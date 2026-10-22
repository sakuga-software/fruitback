import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, PANEL_LIMITS, parseBridgeMessage, parsePanelNotes } from './protocol.ts';
import {
  PANEL_EVENT_TYPE,
  acceptedCommand,
  answerOf,
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
    const counts = { new: 1, todo: 0, progress: 2, done: 0, closed: 3 };
    assert.deepEqual(parseAnswer({ done: true, counts }), { done: true, counts });
    assert.deepEqual(parseAnswer({ done: true, counts: { ...counts, done: -1 } }), { done: true });
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
    stage: 'todo',
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

  it('take « Show pins on the page » from the side panel, off and on (FRU-307)', () => {
    assert.deepEqual(acceptedRequest(tabCommand('hide-pins'), PANEL, ID, ORIGIN), { command: 'hide-pins' });
    assert.deepEqual(acceptedRequest(tabCommand('show-pins'), PANEL, ID, ORIGIN), { command: 'show-pins' });
    assert.equal(acceptedRequest({ type: 'fruitback-tab-command', command: 'pins' }, PANEL, ID, ORIGIN), undefined);
  });

  it('take a verdict from the side panel, and only one of the two the worker knows (FRU-300)', () => {
    assert.deepEqual(acceptedRequest(tabCommand('check', { note: 'seed-1', verdict: 'wrong' }), PANEL, ID, ORIGIN), {
      command: 'check',
      note: 'seed-1',
      verdict: 'wrong',
    });
    assert.deepEqual(
      acceptedRequest(
        { type: 'fruitback-tab-command', command: 'check', note: 'seed-1', verdict: 'stage' },
        PANEL,
        ID,
        ORIGIN,
      ),
      { command: 'check', note: 'seed-1' },
    );
    // A page that forges the command, through the bridge of its tab: refused.
    assert.equal(
      acceptedRequest(
        tabCommand('check', { note: 'seed-1', verdict: 'fixed' }),
        { id: ID, tab: { id: 4 }, url: 'https://acme.dev/' },
        ID,
        ORIGIN,
      ),
      undefined,
    );
    assert.deepEqual(
      parseBridgeMessage({
        channel: CHANNEL,
        kind: 'command',
        id: 'c1',
        command: 'check',
        note: 'seed-1',
        verdict: 'fixed',
      }),
      { channel: CHANNEL, kind: 'command', id: 'c1', command: 'check', note: 'seed-1', verdict: 'fixed' },
    );
    assert.equal(commandTimeout('check'), 20_000);
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
    // A reply of a page says so; anything but `true` is dropped.
    assert.deepEqual(parsePanelNotes([{ ...NOTE, replies: [{ ...NOTE.replies[0], fromPage: true }] }])?.[0]?.replies, [
      { ...NOTE.replies[0], fromPage: true },
    ]);
    assert.deepEqual(parsePanelNotes([{ ...NOTE, replies: [{ ...NOTE.replies[0], fromPage: 'yes' }] }])?.[0]?.replies, [
      NOTE.replies[0],
    ]);
    // FRU-300: who confirmed it, both fields or nothing.
    assert.deepEqual(parsePanelNotes([{ ...NOTE, checked: { by: 'Camille', at: '2026-10-20T10:00:00Z' } }]), [
      { ...NOTE, checked: { by: 'Camille', at: '2026-10-20T10:00:00Z' } },
    ]);
    assert.deepEqual(parsePanelNotes([{ ...NOTE, checked: { by: 'Camille' } }]), [NOTE]);
    // `mine` is `true` or nothing.
    const { mine: _mine, ...notMine } = NOTE;
    assert.deepEqual(parsePanelNotes([{ ...NOTE, mine: 'yes' }]), [notMine]);
  });

  it('keep the word of the store and the status of a note, and only a colour that is #rrggbb (FRU-370)', () => {
    const status = { key: 'own:wait', name: 'Waiting', stage: NOTE.stage, color: '#7c3aed', textColor: '#ffffff' };
    const kept = { name: 'Waiting', stage: NOTE.stage };
    // The key is not kept: the panel draws nothing with it.
    const once = parsePanelNotes([{ ...NOTE, stateName: 'In Review', status }]);
    assert.deepEqual(once, [
      { ...NOTE, stateName: 'In Review', status: { ...kept, color: '#7c3aed', textColor: '#ffffff' } },
    ]);
    // The bridge parses the notes, then the panel parses them again: the second parse keeps them.
    assert.deepEqual(parsePanelNotes(once), once);
    // A colour goes into a style of the panel: anything else is dropped, and the status keeps its name.
    for (const color of ['var(--x)', 'url(x)', 'red', '#fff', '#7c3aed;x', 7]) {
      assert.deepEqual(parsePanelNotes([{ ...NOTE, status: { ...status, color } }])?.[0]?.status, kept, String(color));
    }
    // A text colour comes only with a colour, and only as #rrggbb.
    const noText = parsePanelNotes([{ ...NOTE, status: { ...status, textColor: 'url(y)' } }])?.[0]?.status;
    assert.deepEqual(noText, { ...kept, color: '#7c3aed' });
    // A status of another stage, or with no name, is dropped, and the note stays: the stage wins.
    // NOTE is a note to do.
    const other = 'done';
    assert.deepEqual(parsePanelNotes([{ ...NOTE, status: { ...status, stage: other } }]), [NOTE]);
    const long = 'x'.repeat(PANEL_LIMITS.name + 1);
    assert.deepEqual(parsePanelNotes([{ ...NOTE, status: { ...status, name: long } }]), [NOTE]);
    assert.deepEqual(parsePanelNotes([{ ...NOTE, status: 'Done' }]), [NOTE]);
    // A word that is empty, too long or not a word is left out.
    for (const stateName of ['', long, 7]) assert.deepEqual(parsePanelNotes([{ ...NOTE, stateName }]), [NOTE]);
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

describe('the answer the bridge hands back (raised in review)', () => {
  it('carries done and the outcome of a reply together, and every field of the response', () => {
    assert.deepEqual(answerOf({ channel: CHANNEL, kind: 'command-response', id: 'c1', done: true, outcome: 'sent' }), {
      done: true,
      outcome: 'sent',
    });
    assert.deepEqual(
      answerOf({
        channel: CHANNEL,
        kind: 'command-response',
        id: 'c1',
        done: false,
        outcome: 'wait',
        reading: 'failed',
      }),
      { done: false, outcome: 'wait', reading: 'failed' },
    );
    // The same answer the panel reads after the runtime message: nothing dropped on the way.
    const crossed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'command-response',
      id: 'c1',
      done: true,
      outcome: 'sent',
    });
    assert.ok(crossed?.kind === 'command-response');
    assert.deepEqual(parseAnswer(answerOf(crossed)), { done: true, outcome: 'sent' });
  });
});
