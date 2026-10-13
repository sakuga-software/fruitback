import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, parseBridgeMessage } from './protocol.ts';
import { acceptedCommand, parseAnswer, tabCommand } from './tab-command.ts';

const ID = 'abcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}/`;
const POPUP = { id: ID, url: `${ORIGIN}popup.html` };

describe('a command of the popup to the widget of its tab (FRU-254)', () => {
  it('is taken from a page of this extension', () => {
    for (const command of ['leave-feedback', 'show-notes', 'counts'] as const) {
      assert.equal(acceptedCommand(tabCommand(command), POPUP, ID, ORIGIN), command);
    }
  });

  it('is refused from a content script, from another extension, and in any other shape', () => {
    // The planted violation: the bridge of a reviewed tab posting for its page.
    assert.equal(
      acceptedCommand(tabCommand('leave-feedback'), { id: ID, tab: { id: 4 }, url: 'https://acme.dev/' }, ID, ORIGIN),
      undefined,
    );
    assert.equal(
      acceptedCommand(
        tabCommand('show-notes'),
        { id: 'another', url: 'chrome-extension://another/x.html' },
        ID,
        ORIGIN,
      ),
      undefined,
    );
    assert.equal(acceptedCommand(tabCommand('counts'), { id: ID, url: 'https://acme.dev/' }, ID, ORIGIN), undefined);
    assert.equal(acceptedCommand({ type: 'fruitback-tab-command', command: 'mount' }, POPUP, ID, ORIGIN), undefined);
    assert.equal(acceptedCommand({ command: 'counts' }, POPUP, ID, ORIGIN), undefined);
    assert.equal(acceptedCommand(null, POPUP, ID, ORIGIN), undefined);
  });

  it('reads an answer field by field', () => {
    const counts = { seeded: 1, green: 0, ripening: 2, ripe: 0, composted: 3 };
    assert.deepEqual(parseAnswer({ done: true, counts }), { done: true, counts });
    assert.deepEqual(parseAnswer({ done: true, counts: { ...counts, ripe: -1 } }), { done: true });
    assert.deepEqual(parseAnswer({ done: 'yes' }), { done: false });
    // Busy: the widget is there and said no. Never with a done.
    assert.deepEqual(parseAnswer({ done: false, busy: true }), { done: false, busy: true });
    assert.deepEqual(parseAnswer({ done: true, busy: true }), { done: true });
    assert.deepEqual(parseAnswer({ done: false, busy: 'yes' }), { done: false });
    assert.deepEqual(parseAnswer(undefined), { done: false });
  });
});

describe('the command on the channel of the page', () => {
  it('carries a known command and an id, and nothing else', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'command', id: 'c1', command: 'counts', extra: 1 }), {
      channel: CHANNEL,
      kind: 'command',
      id: 'c1',
      command: 'counts',
    });
    assert.equal(parseBridgeMessage({ channel: CHANNEL, kind: 'command', id: 'c1', command: 'destroy' }), undefined);
    assert.equal(parseBridgeMessage({ channel: CHANNEL, kind: 'command', command: 'counts' }), undefined);
  });

  it('answers with what the widget did, and counts only when they are counts', () => {
    assert.deepEqual(
      parseBridgeMessage({ channel: CHANNEL, kind: 'command-response', id: 'c1', done: 1, counts: [1] }),
      {
        channel: CHANNEL,
        kind: 'command-response',
        id: 'c1',
        done: false,
      },
    );
  });
});
