import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config from '../wxt.config.ts';
import { TAB_COMMANDS } from './protocol.ts';
import { TAB_COMMAND_TYPE } from './tab-command.ts';
import {
  LEAVE_FEEDBACK_COMMAND,
  MANIFEST_COMMANDS,
  SUGGESTED_KEY,
  currentShortcut,
  runShortcut,
  tabCommandFor,
} from './shortcut.ts';

/** The key that starts a note (FRU-291). The browser runs it; `e2e/extension-shortcut.spec.ts` drives it. */

type Manifest = { commands?: unknown; permissions?: string[]; optional_host_permissions?: string[] };

describe('the shortcut that starts a note (FRU-291)', () => {
  const manifest = config.manifest as Manifest;

  it('is a command of the manifest, with Alt+Shift+F suggested', () => {
    assert.deepEqual(manifest.commands, MANIFEST_COMMANDS);
    assert.equal(SUGGESTED_KEY, 'Alt+Shift+F');
    assert.equal(MANIFEST_COMMANDS[LEAVE_FEEDBACK_COMMAND].suggested_key.default, SUGGESTED_KEY);
  });

  // A command asks for nothing at install. The list is written out, so a permission added with the
  // shortcut fails here.
  it('asks for no new permission', () => {
    assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'activeTab', 'alarms']);
    assert.deepEqual(manifest.optional_host_permissions, ['*://*/*']);
  });

  it('sends the widget the command of the popup button, and nothing for a command that is not ours', () => {
    assert.equal(tabCommandFor(LEAVE_FEEDBACK_COMMAND), 'leave-feedback');
    assert.ok(TAB_COMMANDS.includes('leave-feedback'));
    assert.equal(tabCommandFor('_execute_action'), undefined);
    assert.equal(tabCommandFor('show-notes'), undefined);
  });

  it('reads the key the browser gives now, and none when it is empty', () => {
    assert.equal(currentShortcut([{ name: LEAVE_FEEDBACK_COMMAND, shortcut: 'Alt+Shift+F' }]), 'Alt+Shift+F');
    // The person changed it in the browser.
    assert.equal(currentShortcut([{ name: LEAVE_FEEDBACK_COMMAND, shortcut: '⌥⇧N' }]), '⌥⇧N');
    // Removed, or not assigned because another extension holds it.
    assert.equal(currentShortcut([{ name: LEAVE_FEEDBACK_COMMAND, shortcut: '' }]), undefined);
    assert.equal(currentShortcut([{ name: '_execute_action', shortcut: 'Alt+Shift+F' }]), undefined);
    assert.equal(currentShortcut([]), undefined);
  });

  it('sends the command to the tab the key was pressed on, and survives a tab with no widget', async () => {
    const sent: [number, unknown][] = [];
    const send = async (tabId: number, message: unknown) => void sent.push([tabId, message]);

    assert.equal(runShortcut(LEAVE_FEEDBACK_COMMAND, { id: 7 }, send), true);
    assert.deepEqual(sent, [[7, { type: TAB_COMMAND_TYPE, command: 'leave-feedback' }]]);

    // No tab (a key pressed on a page of the browser), or a command that is not ours: nothing sent.
    assert.equal(runShortcut(LEAVE_FEEDBACK_COMMAND, undefined, send), false);
    assert.equal(runShortcut(LEAVE_FEEDBACK_COMMAND, {}, send), false);
    assert.equal(runShortcut('_execute_action', { id: 7 }, send), false);
    assert.equal(sent.length, 1);

    // A tab with no bridge rejects: the rejection is caught, not left unhandled.
    let rejected = false;
    runShortcut(LEAVE_FEEDBACK_COMMAND, { id: 8 }, async () => {
      rejected = true;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(rejected, true);
  });
});
