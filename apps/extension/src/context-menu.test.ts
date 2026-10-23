import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config from '../wxt.config.ts';
import { CAPTURE_MENU_ID, CAPTURE_MENU_TITLE, captureMenu, runCaptureMenu } from './context-menu.ts';
import { TAB_COMMAND_TYPE } from './tab-command.ts';
import { TAB_COMMANDS } from './protocol.ts';

/** « Capture with Fruitback », in the context menu of a page (FRU-423). */
describe('the item « Capture with Fruitback » of the context menu (FRU-423)', () => {
  it('is the permission contextMenus of the manifest, and no host', () => {
    const manifest = config.manifest as { permissions?: string[]; optional_host_permissions?: string[] };
    assert.ok(manifest.permissions?.includes('contextMenus'));
    assert.deepEqual(manifest.optional_host_permissions, ['*://*/*', '<all_urls>']);
  });

  it('is on the web pages only, in the language of the reviewer', () => {
    assert.deepEqual(captureMenu('en'), {
      id: CAPTURE_MENU_ID,
      title: CAPTURE_MENU_TITLE,
      contexts: ['page', 'selection', 'image', 'link'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    assert.equal(captureMenu('fr').title, 'Capturer avec Fruitback');
  });

  it('sends the widget of the tab « capture-area », and nothing for another item or no tab', async () => {
    const sent: [number, unknown][] = [];
    const send = async (tabId: number, message: unknown) => void sent.push([tabId, message]);
    assert.equal(runCaptureMenu({ menuItemId: CAPTURE_MENU_ID }, { id: 7 }, send), true);
    assert.deepEqual(sent, [[7, { type: TAB_COMMAND_TYPE, command: 'capture-area' }]]);
    assert.ok(TAB_COMMANDS.includes('capture-area'));
    assert.equal(runCaptureMenu({ menuItemId: 'another' }, { id: 7 }, send), false);
    assert.equal(runCaptureMenu({ menuItemId: CAPTURE_MENU_ID }, undefined, send), false);
    // A tab of no window (a prerender, a devtools page) has the id -1.
    assert.equal(runCaptureMenu({ menuItemId: CAPTURE_MENU_ID }, { id: -1 }, send), false);
    assert.equal(sent.length, 1);
  });

  it('drops a refusal: a tab with no widget answers nothing', async () => {
    assert.equal(
      runCaptureMenu({ menuItemId: CAPTURE_MENU_ID }, { id: 3 }, () => Promise.reject(new Error('no receiver'))),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
