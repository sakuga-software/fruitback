import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, PANEL_LIMITS, parseBridgeMessage, parsePanelNotes } from './protocol.ts';
import {
  PANEL_EVENT_TYPE,
  acceptedCommand,
  acceptedRequest,
  commandTimeout,
  panelEvent,
  parseAnswer,
  tabCommand,
} from './tab-command.ts';

const ID = 'abcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}/`;
const POPUP = { id: ID, url: `${ORIGIN}popup.html` };

describe('a command of the popup to the widget of its tab (FRU-254)', () => {
  it('is taken from a page of this extension', () => {
    for (const command of ['leave-feedback', 'show-notes', 'counts'] as const) {
      assert.equal(acceptedCommand(tabCommand(command), POPUP, ID, ORIGIN), command);
    }
  });

  // FRU-291: the key of the manifest is caught by the background, which sends what the popup sends.
  // The background is no tab, and its URL is on the origin of the extension in both browsers.
  it('is taken from the background of this extension, which the shortcut runs in', () => {
    for (const url of [`${ORIGIN}background.js`, `${ORIGIN}_generated_background_page.html`]) {
      assert.equal(acceptedCommand(tabCommand('leave-feedback'), { id: ID, url }, ID, ORIGIN), 'leave-feedback');
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

describe('the commands of the side panel (FRU-299)', () => {
  const PANEL = { id: ID, url: `${ORIGIN}sidepanel.html` };
  const NOTE = {
    id: 'seed-1',
    number: 3,
    stage: 'green',
    note: 'Could the title mention Bordeaux?',
    author: 'Léa',
    mine: true,
    createdAt: '2026-10-19T12:00:00Z',
    updatedAt: '2026-10-19T12:00:00Z',
    replies: [{ author: 'Marc', body: 'Planned.', createdAt: '2026-10-19T16:00:00Z' }],
    canReply: true,
    placement: 'found',
  } as const;

  it('are taken from the side panel, with the note and the text they carry', () => {
    assert.deepEqual(acceptedRequest(tabCommand('notes'), PANEL, ID, ORIGIN), { command: 'notes' });
    assert.deepEqual(acceptedRequest(tabCommand('focus-note', { note: 'seed-1' }), PANEL, ID, ORIGIN), {
      command: 'focus-note',
      note: 'seed-1',
    });
    assert.deepEqual(acceptedRequest(tabCommand('reply', { note: 'seed-1', body: 'Merci' }), PANEL, ID, ORIGIN), {
      command: 'reply',
      note: 'seed-1',
      body: 'Merci',
    });
  });

  // The planted violation of the ticket: a page that forges the command, through the bridge of its tab.
  it('are refused when a page sends them', () => {
    const page = { id: ID, tab: { id: 4 }, url: 'https://acme.dev/' };
    for (const command of ['notes', 'focus-note', 'mark-note', 'reply'] as const) {
      assert.equal(acceptedRequest(tabCommand(command, { note: 'seed-1', body: 'x' }), page, ID, ORIGIN), undefined);
    }
  });

  it('drop a note id or a text longer than the bounds', () => {
    assert.deepEqual(
      acceptedRequest(
        tabCommand('reply', { note: 'x'.repeat(101), body: 'y'.repeat(PANEL_LIMITS.text + 1) }),
        PANEL,
        ID,
        ORIGIN,
      ),
      { command: 'reply' },
    );
  });

  it('give a reply the time of the worker, and the others the time of the page', () => {
    assert.equal(commandTimeout('reply'), 20_000);
    assert.equal(commandTimeout('notes'), 1_500);
  });

  it('carry the note and the text across the channel of the page, bounded', () => {
    assert.deepEqual(
      parseBridgeMessage({
        channel: CHANNEL,
        kind: 'command',
        id: 'c1',
        command: 'reply',
        note: 'seed-1',
        body: 'Merci',
      }),
      { channel: CHANNEL, kind: 'command', id: 'c1', command: 'reply', note: 'seed-1', body: 'Merci' },
    );
    assert.deepEqual(
      parseBridgeMessage({ channel: CHANNEL, kind: 'command', id: 'c1', command: 'reply', note: 7, body: {} }),
      { channel: CHANNEL, kind: 'command', id: 'c1', command: 'reply' },
    );
  });

  it('read the notes and the outcome of a reply in an answer', () => {
    assert.deepEqual(parseAnswer({ done: true, notes: [NOTE] }), { done: true, notes: [NOTE] });
    assert.deepEqual(parseAnswer({ done: false, outcome: 'wait' }), { done: false, outcome: 'wait' });
    assert.deepEqual(parseAnswer({ done: false, outcome: 'boom' }), { done: false });
    // Why there are no notes (raised in review).
    assert.deepEqual(parseAnswer({ done: false, reading: 'failed' }), { done: false, reading: 'failed' });
    assert.deepEqual(parseAnswer({ done: false, reading: 'no-widget' }), { done: false, reading: 'no-widget' });
    assert.deepEqual(parseAnswer({ done: false, reading: 'gone' }), { done: false });
  });

  it('keep the notes that are notes, and drop the others', () => {
    const bad = [
      { ...NOTE, id: '' },
      { ...NOTE, stage: 'lost' },
      { ...NOTE, note: 'x'.repeat(PANEL_LIMITS.text + 1) },
      { ...NOTE, author: 7 },
      { ...NOTE, replies: 'none' },
      { ...NOTE, placement: 'somewhere' },
      'not a note',
    ];
    assert.deepEqual(parsePanelNotes([NOTE, ...bad]), [NOTE]);
    // A number that is not a whole positive number goes, the note stays.
    const { number: _number, ...withoutNumber } = NOTE;
    assert.deepEqual(parsePanelNotes([{ ...NOTE, number: -1 }]), [withoutNumber]);
    // A reply that is not one goes, the note stays.
    assert.deepEqual(parsePanelNotes([{ ...NOTE, replies: [{ body: 3 }, ...NOTE.replies] }]), [NOTE]);
    // `mine` is `true` or nothing.
    const { mine: _mine, ...notMine } = NOTE;
    assert.deepEqual(parsePanelNotes([{ ...NOTE, mine: 'yes' }]), [notMine]);
  });

  it('refuse a list longer than a page can hold', () => {
    assert.equal(parsePanelNotes(Array.from({ length: PANEL_LIMITS.notes + 1 }, () => NOTE)), undefined);
    assert.equal(parsePanelNotes('notes'), undefined);
  });

  it('read an event of the widget: read again, or open a note', () => {
    assert.deepEqual(panelEvent({ type: PANEL_EVENT_TYPE }), {});
    assert.deepEqual(panelEvent({ type: PANEL_EVENT_TYPE, open: 'seed-1' }), { open: 'seed-1' });
    assert.deepEqual(panelEvent({ type: PANEL_EVENT_TYPE, open: 'x'.repeat(101) }), {});
    assert.equal(panelEvent({ type: 'something-else' }), undefined);
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'notes-changed', open: 'seed-1', extra: 1 }), {
      channel: CHANNEL,
      kind: 'notes-changed',
      open: 'seed-1',
    });
  });
});
