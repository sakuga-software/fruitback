import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { type Note, type NoteComment, type NoteIssue, parseNote } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { init, mountOptions, plant, uploadAttachment } from './embed.ts';
import { type FruitbackNotes, NOTES_ENDPOINT, type StoredNote, localNotes, notesTransport } from './notes.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';
import { replyFromPage, verdictFromPage } from './overlay.ts';

/** The notes of a widget with no worker (FRU-646): `notes`, `localNotes` and the transport over them. */

const PAGE = 'https://preview.acme.test/pricing';
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
  mock.restoreAll();
});

/** A `Storage` in memory. `full`: every write throws, as a full `localStorage` does. */
function memoryStorage(full = false): Storage {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      items.set(key, value);
    },
  };
}

function forbidFetch(): void {
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('the widget went to the network with `notes`');
  });
}

function page(): MountedPage {
  const mounted = mountPage('<main><button data-testid="cta">Commander</button></main>', {
    width: 1_000,
    height: 1_000,
  });
  setDocumentSize(mounted.document, 1_000, 1_000);
  setRect(mounted.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return mounted;
}

/** Sends one note of `mounted` with `notes`, as the composer does. */
function send(mounted: MountedPage, notes: FruitbackNotes, text = 'the price is wrong') {
  return plant({
    note: text,
    target: { element: mounted.query('button'), source: undefined },
    reporter: { name: 'Léa' },
    config: { hiddenStages: [], screenshot: false },
    options: mountOptions({ document: mounted.document, notes }),
  });
}

const NO_FILE = { attachments: [] };

const call = (notes: FruitbackNotes, path: string, method: 'GET' | 'POST' = 'GET', body?: string) =>
  notesTransport(notes)({
    url: `${NOTES_ENDPOINT}${path}`,
    method,
    headers: {},
    ...(body === undefined ? {} : { body }),
  });

describe('init with `notes` (FRU-646)', () => {
  it('needs no endpoint and no client id, and refuses `notes` with an endpoint or a transport', () => {
    const notes = localNotes({ storage: memoryStorage() });

    assert.equal(mountOptions({ notes }).endpoint, NOTES_ENDPOINT);
    assert.throws(() => mountOptions({ notes, endpoint: 'https://worker.test' }), /takes the place of a worker/);
    assert.throws(
      () => mountOptions({ notes, transport: async () => ({ ok: true, status: 200, body: '{}' }) }),
      /takes the place of a worker/,
    );
    // The control: without `notes`, the worker needs both.
    assert.throws(() => mountOptions({ endpoint: 'https://worker.test' }), /pass `endpoint` and `clientId`/);
    assert.equal(mountOptions({ endpoint: 'https://worker.test', clientId: 'acme' }).endpoint, 'https://worker.test');
  });

  it('hands `write` the note that `parseNote` reads, with no client when none was given, and no request', async () => {
    forbidFetch();
    const written: Note[] = [];
    const sent = await send(page(), { write: async (note) => (written.push(note), { id: 'n-1' }) });

    assert.equal(sent, true);
    assert.equal(written.length, 1);
    assert.equal(parseNote(written[0]).ok, true);
    assert.equal(written[0]?.text, 'the price is wrong');
    assert.equal(written[0]?.page.url, PAGE);
    assert.equal('client' in (written[0] ?? {}), false, 'an empty client id is no client');
  });

  it('writes the client id it was given', async () => {
    const written: Note[] = [];
    const mounted = page();
    await plant({
      note: 'x',
      target: { element: mounted.query('button'), source: undefined },
      reporter: undefined,
      config: { hiddenStages: [], screenshot: false },
      options: mountOptions({ notes: { write: async (note) => (written.push(note), { id: 'n' }) }, clientId: 'acme' }),
    });

    assert.deepEqual(written[0]?.client, { id: 'acme' });
  });

  it('says a send failed when `write` rejects, or answers no id', async () => {
    for (const write of [
      async () => Promise.reject(new Error('down')),
      async () => ({ id: '' }),
      async () => undefined as unknown as { id: string },
    ]) {
      assert.equal(await send(page(), { write }), 'retry', String(write));
    }
  });

  it('shows the pins `read` gives back on a widget built again, and none without `read`', async () => {
    forbidFetch();
    const storage = memoryStorage();
    const first = page();
    assert.equal(await send(first, localNotes({ storage })), true);

    const again = page();
    const widget = init({ document: again.document, locale: 'en', notes: localNotes({ storage }) });
    cleanup.push(() => widget.destroy());
    await widget.refresh();
    const notes = widget.pageNotes();

    assert.equal(notes?.length, 1);
    assert.equal(notes?.[0]?.note, 'the price is wrong');
    assert.equal(notes?.[0]?.stage, 'new', 'a stored note with no stage is « New »');
    // FRU-647: `localNotes` takes replies, so the thread offers a field to write one.
    assert.equal(notes?.[0]?.canReply, true);

    const blind = page();
    const writeOnly = init({ document: blind.document, locale: 'en', notes: { write: localNotes({ storage }).write } });
    cleanup.push(() => writeOnly.destroy());
    await writeOnly.refresh();

    assert.deepEqual(writeOnly.pageNotes(), [], 'without `read`, no pin comes back');
    assert.equal(writeOnly.notesState(), 'read', 'and the list says « no note », not « could not be read »');

    // FRU-647: without `reply`, the pin comes back and its thread offers no reply.
    const quiet = page();
    const { reply: _reply, ...noReply } = localNotes({ storage });
    const silent = init({ document: quiet.document, locale: 'en', notes: noReply });
    cleanup.push(() => silent.destroy());
    await silent.refresh();
    assert.equal(silent.pageNotes()?.[0]?.canReply, false);
    assert.equal(await silent.replyTo(silent.pageNotes()?.[0]?.id ?? '', 'Hi'), 'refused');
  });
});

describe('notesTransport (FRU-646)', () => {
  it('answers the read with no place, no batch and no address to ask, and a reply and a file only with their function', async () => {
    const keysOf = async (notes: FruitbackNotes) => {
      const answer = await call(notes, `/feedback?url=${encodeURIComponent(PAGE)}&client=`);
      assert.equal(answer.status, 200);

      return Object.keys(JSON.parse(answer.body) as Record<string, unknown>);
    };
    const all = localNotes({ storage: memoryStorage() });

    assert.deepEqual(await keysOf(all), ['issues', 'canReply', 'canAttach']);
    assert.deepEqual(await keysOf({ write: all.write, read: all.read }), ['issues']);
    assert.deepEqual(await keysOf({ write: all.write }), ['issues'], 'without `read`');
    assert.deepEqual(await keysOf({ write: all.write, reply: all.reply }), ['issues', 'canReply']);
    assert.deepEqual(await keysOf({ write: all.write, attach: all.attach }), ['issues', 'canAttach']);
  });

  it('drops what `read` gives that is not a note of this page', async () => {
    const good = noteFixture({ id: 'good', page: { url: PAGE, path: '/pricing' } });
    const other = noteFixture({ id: 'other', page: { url: 'https://preview.acme.test/about', path: '/about' } });
    const notes: FruitbackNotes = {
      write: async () => ({ id: 'x' }),
      read: async () =>
        [
          { id: 'n-good', note: good, stage: 'done' },
          { id: 'n-other', note: other },
          { id: 'n-broken', note: { ...good, anchor: 'nowhere' } },
          { id: '', note: good },
          { note: good },
          null,
          'text',
        ] as never,
    };
    const answer = await call(notes, `/feedback?url=${encodeURIComponent(PAGE)}`);
    const { issues } = JSON.parse(answer.body) as { issues: { id: string; stage: string }[] };

    assert.deepEqual(
      issues.map((issue) => [issue.id, issue.stage]),
      [['n-good', 'done']],
    );
  });

  it('answers a failed read as a failure, so the pins on screen stay', async () => {
    const answer = await call(
      { write: async () => ({ id: 'x' }), read: async () => Promise.reject(new Error('down')) },
      `/feedback?url=${encodeURIComponent(PAGE)}`,
    );

    assert.equal(answer.ok, false);
  });

  it('refuses a body that is not a note, and answers 404 to every other call', async () => {
    const notes: FruitbackNotes = { write: async () => ({ id: 'x' }) };

    assert.equal((await call(notes, '/feedback', 'POST', 'not json')).status, 400);
    assert.equal((await call(notes, '/feedback', 'POST', '{"text":"x"}')).status, 400);
    // FRU-647: a call whose function is absent is not offered.
    for (const path of [
      '/feedback/n/replies',
      '/feedback/n/notify',
      '/attachments?name=a.png',
      '/feedback/n/check',
      '/feedback/n/text',
      '/feedback/n/withdraw',
      '/feedback/n/place',
      '/feedback/n/status',
    ]) {
      assert.equal((await call(notes, path, 'POST', '{}')).status, 404, path);
    }
    const elsewhere = await notesTransport(notes)({ url: 'https://worker.test/feedback', method: 'GET', headers: {} });
    assert.equal(elsewhere.status, 404, 'another origin');
  });
});

describe('localNotes (FRU-646)', () => {
  it('keeps a note once when it comes again, and reads the notes of one page', async () => {
    const storage = memoryStorage();
    const notes = localNotes({ storage });
    const here = noteFixture({ id: 'a', page: { url: PAGE, path: '/pricing' } });
    const there = noteFixture({ id: 'b', page: { url: 'https://preview.acme.test/about', path: '/about' } });

    await notes.write(here, NO_FILE);
    await notes.write(here, NO_FILE);
    await notes.write(there, NO_FILE);

    assert.deepEqual(
      (await notes.read?.({ url: PAGE, path: '/pricing' }))?.map((stored) => stored.id),
      ['a'],
    );
    assert.equal(JSON.parse(storage.getItem('fruitback:notes') ?? '[]').length, 2);
  });

  it('finds a note kept under another form of the address, and skips one with no address', async () => {
    const storage = memoryStorage();
    const note = noteFixture({ id: 'a', page: { url: PAGE, path: '/pricing' } });
    storage.setItem(
      'fruitback:notes',
      JSON.stringify([
        { id: 'a', note: { ...note, page: { ...note.page, url: 'https://PREVIEW.acme.test/pricing/#top' } } },
        { id: 'b', note: { ...note, page: { path: '/' } } },
        { id: 'c', note: { ...note, page: { url: 'not an address', path: '/' } } },
      ]),
    );

    assert.deepEqual(
      (await localNotes({ storage }).read?.({ url: PAGE, path: '/pricing' }))?.map((stored) => stored.id),
      ['a'],
    );
  });

  it('refuses a read of an address that is not one', async () => {
    assert.equal((await call(localNotes({ storage: memoryStorage() }), '/feedback?url=nowhere')).status, 400);
  });

  it('fails the write when the storage refuses it, so the composer keeps the text', async () => {
    assert.equal(await send(page(), localNotes({ storage: memoryStorage(true) })), 'retry');
  });

  it('reads a key that holds no list as no note', async () => {
    const storage = memoryStorage();
    storage.setItem('fruitback:notes', '{"not":"a list"}');

    assert.deepEqual(await localNotes({ storage }).read?.({ url: PAGE, path: '/pricing' }), []);
  });
});

/** One transport over `notes`, for a read then the writes about its notes: they check what it read. */
function over(notes: FruitbackNotes, words?: Parameters<typeof notesTransport>[1]) {
  const transport = notesTransport(notes, words);
  const send = (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
    transport({
      url: `${NOTES_ENDPOINT}${path}`,
      method,
      headers: {},
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const read = async () => {
    const answer = await send(`/feedback?url=${encodeURIComponent(PAGE)}`);

    return (JSON.parse(answer.body) as { issues: NoteIssue[] }).issues;
  };

  return { transport, send, read };
}

const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};

/** A note of `PAGE`, on the button of `page()`. */
const noteOf = (id: string, extra: Partial<Note> = {}) =>
  noteFixture({ id, page: { url: PAGE, path: '/pricing' }, anchor: ANCHOR, ...extra });

/** Functions that record what they are handed, over the notes `stored`. */
function recording(stored: StoredNote[]) {
  const calls: unknown[][] = [];
  const notes: Required<FruitbackNotes> = {
    write: async (note, sent) => (calls.push(['write', note.id, sent]), { id: note.id }),
    read: async () => stored,
    reply: async (id, reply) => (calls.push(['reply', id, reply]), { id: 'r-1' }),
    check: async (id, verdict) => void calls.push(['check', id, verdict]),
    edit: async (id, text) => void calls.push(['edit', id, text]),
    withdraw: async (id) => void calls.push(['withdraw', id]),
    attach: async (file) => (
      calls.push(['attach', file.name, file.type, [...new Uint8Array(await file.arrayBuffer())]]),
      {
        id: `host-${file.name}`,
      }
    ),
  };

  return { calls, notes };
}

describe('the other functions of `notes` (FRU-647)', () => {
  it('offers edit and withdraw on a note of the reader while it is open, and only with their function', async () => {
    const stored: StoredNote[] = [
      { id: 'open', note: noteOf('a'), stage: 'progress', mine: true },
      { id: 'done', note: noteOf('b'), stage: 'done', mine: true },
      { id: 'other', note: noteOf('c'), stage: 'new' },
      { id: 'false', note: noteOf('d'), stage: 'new', mine: 'yes' as never },
    ];
    const { notes } = recording(stored);
    const flags = async (given: FruitbackNotes) =>
      (await over(given).read()).map((issue) => [issue.id, issue.mine, issue.editable, issue.withdrawable]);

    assert.deepEqual(await flags(notes), [
      ['open', true, true, true],
      ['done', true, undefined, undefined],
      ['other', undefined, undefined, undefined],
      ['false', undefined, undefined, undefined],
    ]);
    const { edit: _edit, withdraw: _withdraw, ...neither } = notes;
    assert.deepEqual((await flags(neither))[0], ['open', true, undefined, undefined]);
    const { withdraw: _only, ...editOnly } = notes;
    assert.deepEqual((await flags(editOnly))[0], ['open', true, true, undefined]);
  });

  it('gives the replies oldest first, those of the reader and the verdicts as the thread reads them, and drops what is not a reply', async () => {
    const replies = [
      { id: 'r0', text: 'Me\n\ntoo', createdAt: '2026-11-20T08:00:00.000Z', author: 'Léa', mine: true },
      { id: 'r2', text: 'Still grey.', createdAt: '2026-11-20T10:00:00.000Z', verdict: 'wrong' },
      { id: 'r1', text: 'Seen.', createdAt: '2026-11-20T09:00:00.000Z', author: ' Marc ' },
      { id: 'r3', text: '', createdAt: '2026-11-20T11:00:00.000Z', author: 'Léa', verdict: 'fixed' },
      { id: '', text: 'no id', createdAt: '2026-11-20T09:00:00.000Z' },
      { id: 'r4', text: 'no date', createdAt: 'yesterday' },
      { id: 'r5', text: 42, createdAt: '2026-11-20T09:00:00.000Z' },
      'text',
    ];
    const stored = [{ id: 'n', note: noteOf('a'), stage: 'done', mine: true, replies }] as never as StoredNote[];
    const words = (key: 'thread.anonymous' | 'thread.you') => (key === 'thread.anonymous' ? 'Anonyme' : 'vous');
    const [issue] = await over({ write: async () => ({ id: 'x' }), read: async () => stored }, words).read();

    assert.deepEqual(issue?.comments, [
      {
        id: 'r0',
        body: '**Léa** via Fruitback · vous\n\n> Me\n>\n> too',
        createdAt: '2026-11-20T08:00:00.000Z',
        author: 'Léa',
      },
      { id: 'r1', body: 'Seen.', createdAt: '2026-11-20T09:00:00.000Z', author: 'Marc' },
      {
        id: 'r2',
        body: '**Anonyme** via Fruitback · vous\nReopened: still wrong\n\n> Still grey.',
        createdAt: '2026-11-20T10:00:00.000Z',
        author: 'Anonyme',
      },
      {
        id: 'r3',
        body: '**Léa** via Fruitback · vous\nChecked: looks fixed',
        createdAt: '2026-11-20T11:00:00.000Z',
        author: 'Léa',
      },
    ]);
    // The thread reads them as replies of the page: the name, « vous », and the text as it was typed.
    const t = createTranslator({ locale: 'fr' });
    const [mine, team, reopened, fixed] = issue?.comments ?? [];
    assert.deepEqual(replyFromPage(mine?.body ?? ''), { name: 'Léa', who: 'vous', text: 'Me\n\ntoo' });
    assert.equal(replyFromPage(team?.body ?? ''), undefined);
    assert.equal(verdictFromPage(reopened?.body ?? '', t)?.text, `${t.text('thread.reopened')}\nStill grey.`);
    assert.equal(verdictFromPage(fixed?.body ?? '', t)?.verdict, 'fixed');
    // The newest verdict is `fixed`, on a note at `done`: confirmed, as the worker reads it.
    assert.deepEqual(issue?.checked, { by: 'Léa', at: '2026-11-20T11:00:00.000Z' });
    assert.equal(issue?.updatedAt, '2026-11-20T11:00:00.000Z');
  });

  it('confirms nothing when the newest verdict is `wrong`, or the note is not at `done`', async () => {
    const fixed = { id: 'r1', text: '', createdAt: '2026-11-20T09:00:00.000Z', verdict: 'fixed' as const };
    const wrong = { id: 'r2', text: 'no', createdAt: '2026-11-20T10:00:00.000Z', verdict: 'wrong' as const };
    const stored: StoredNote[] = [
      { id: 'reopened', note: noteOf('a'), stage: 'done', mine: true, replies: [fixed, wrong] },
      { id: 'moved', note: noteOf('b'), stage: 'todo', mine: true, replies: [fixed] },
    ];
    const issues = await over(recording(stored).notes).read();

    assert.deepEqual(
      issues.map((issue) => issue.checked),
      [undefined, undefined],
    );
  });

  it('keeps a reply with the name typed, answers it as the thread shows it, and names nobody when none was typed', async () => {
    const { calls, notes } = recording([{ id: 'n', note: noteOf('a') }]);
    const { send, read } = over(notes, (key) => (key === 'thread.anonymous' ? 'Anonyme' : 'vous'));
    await read();

    const named = await send('/feedback/n/replies', 'POST', { url: PAGE, body: '  Merci  ', name: 'Léa' });
    const anonymous = await send('/feedback/n/replies', 'POST', { url: PAGE, body: 'Hi', name: '  ' });

    assert.equal(named.status, 201);
    const comment = (JSON.parse(named.body) as { comment: NoteComment }).comment;
    assert.deepEqual(
      { ...comment, createdAt: 'x' },
      { id: 'r-1', body: '**Léa** via Fruitback · vous\n\n> Merci', createdAt: 'x', author: 'Léa' },
    );
    assert.equal(
      (JSON.parse(anonymous.body) as { comment: NoteComment }).comment.body,
      '**Anonyme** via Fruitback · vous\n\n> Hi',
    );
    assert.deepEqual(calls, [
      ['reply', 'n', { text: 'Merci', author: 'Léa' }],
      ['reply', 'n', { text: 'Hi' }],
    ]);
  });

  it('refuses a reply to a note no read gave, an empty one, and fails one the host refused', async () => {
    const { notes } = recording([{ id: 'n', note: noteOf('a') }]);
    const { send, read } = over({ ...notes, reply: async () => Promise.reject(new Error('down')) });
    await read();

    assert.equal((await send('/feedback/nobody/replies', 'POST', { body: 'Hi' })).status, 404);
    assert.equal((await send('/feedback/n/replies', 'POST', { body: '   ' })).status, 400);
    assert.equal((await send('/feedback/n/replies', 'POST', 'not json')).status, 400);
    assert.equal((await send('/feedback/n/replies', 'POST', { body: 'Hi' })).status, 500);
    const noId = over({ ...notes, reply: async () => ({ id: '' }) });
    await noId.read();
    assert.equal((await noId.send('/feedback/n/replies', 'POST', { body: 'Hi' })).status, 500);
  });

  it('takes a verdict only from the author of a note at `done` that nothing confirmed, and moves it as the worker does', async () => {
    const confirmed = { id: 'r', text: '', createdAt: '2026-11-20T09:00:00.000Z', verdict: 'fixed' as const };
    const { calls, notes } = recording([
      { id: 'done', note: noteOf('a', { reporter: { name: 'Léa' } }), stage: 'done', mine: true },
      { id: 'again', note: noteOf('b'), stage: 'done', mine: true },
      { id: 'theirs', note: noteOf('c'), stage: 'done' },
      { id: 'open', note: noteOf('d'), stage: 'todo', mine: true },
      { id: 'checked', note: noteOf('e'), stage: 'done', mine: true, replies: [confirmed] },
    ]);
    const { send, read } = over(notes);
    await read();

    for (const id of ['theirs', 'open', 'checked']) {
      assert.equal((await send(`/feedback/${id}/check`, 'POST', { verdict: 'fixed' })).status, 409, id);
    }
    assert.equal((await send('/feedback/done/check', 'POST', { verdict: 'maybe' })).status, 400);

    const fixed = JSON.parse((await send('/feedback/done/check', 'POST', { verdict: 'fixed' })).body) as {
      comment: NoteComment;
      stage: string;
    };
    assert.equal(fixed.stage, 'done');
    assert.equal(fixed.comment.body, '**Léa** via Fruitback · you\nChecked: looks fixed');
    assert.equal(fixed.comment.author, 'Léa');
    assert.equal((await send('/feedback/done/check', 'POST', { verdict: 'wrong' })).status, 409, 'confirmed now');

    const wrong = JSON.parse(
      (await send('/feedback/again/check', 'POST', { verdict: 'wrong', body: ' Still grey. ' })).body,
    ) as { comment: NoteComment; stage: string };
    assert.equal(wrong.stage, 'new');
    assert.equal(wrong.comment.body, '**Anonymous** via Fruitback · you\nReopened: still wrong\n\n> Still grey.');
    assert.deepEqual(calls, [
      ['check', 'done', { verdict: 'fixed', author: 'Léa' }],
      ['check', 'again', { verdict: 'wrong', text: 'Still grey.' }],
    ]);
  });

  it('edits the text of an open note of its author, and answers the note as it is now', async () => {
    const { calls, notes } = recording([
      { id: 'open', note: noteOf('a'), stage: 'new', mine: true },
      { id: 'closed', note: noteOf('b'), stage: 'closed', mine: true },
      { id: 'theirs', note: noteOf('c'), stage: 'new' },
    ]);
    const { send, read } = over(notes);
    await read();

    assert.equal((await send('/feedback/closed/text', 'POST', { text: 'x' })).status, 409);
    assert.equal((await send('/feedback/theirs/text', 'POST', { text: 'x' })).status, 409);
    assert.equal((await send('/feedback/open/text', 'POST', { text: '  ' })).status, 400);
    assert.equal((await send('/feedback/open/text', 'POST', { text: 'x'.repeat(100_000) })).status, 400);
    const edited = await send('/feedback/open/text', 'POST', { url: PAGE, text: ' The price is 3 € ' });

    assert.equal(edited.status, 200);
    const { note } = JSON.parse(edited.body) as { note: Note };
    assert.equal(note.text, 'The price is 3 €');
    assert.equal(note.id, 'a');
    assert.deepEqual(calls, [['edit', 'open', 'The price is 3 €']]);
  });

  it('withdraws an open note of its author to `closed`, once', async () => {
    const { calls, notes } = recording([
      { id: 'open', note: noteOf('a'), stage: 'todo', mine: true },
      { id: 'theirs', note: noteOf('b'), stage: 'todo' },
    ]);
    const { send, read } = over(notes);
    await read();

    assert.equal((await send('/feedback/theirs/withdraw', 'POST', {})).status, 409);
    const withdrawn = await send('/feedback/open/withdraw', 'POST', { url: PAGE });
    assert.deepEqual(JSON.parse(withdrawn.body), { stage: 'closed' });
    assert.equal((await send('/feedback/open/withdraw', 'POST', {})).status, 409, 'closed now');
    assert.deepEqual(calls, [['withdraw', 'open']]);
  });

  it('fails a verdict, an edit or a withdrawal the host refused, and moves nothing then', async () => {
    const refuse = async () => Promise.reject(new Error('down'));
    const { notes } = recording([
      { id: 'done', note: noteOf('a'), stage: 'done', mine: true },
      { id: 'open', note: noteOf('b'), stage: 'new', mine: true },
    ]);
    const { send, read } = over({ ...notes, check: refuse, edit: refuse, withdraw: refuse });
    await read();

    assert.equal((await send('/feedback/done/check', 'POST', { verdict: 'wrong' })).status, 500);
    assert.equal((await send('/feedback/open/text', 'POST', { text: 'x' })).status, 500);
    assert.equal((await send('/feedback/open/withdraw', 'POST', {})).status, 500);
    // Nothing moved: the note at `done` still takes a verdict.
    const again = over(recording([{ id: 'done', note: noteOf('a'), stage: 'done', mine: true }]).notes);
    await again.read();
    assert.equal((await again.send('/feedback/done/check', 'POST', { verdict: 'fixed' })).status, 200);
  });

  it('hands `attach` the file, and `write` the ids `attach` gave, through the composer and the send', async () => {
    forbidFetch();
    const { calls, notes } = recording([]);
    const mounted = page();
    const options = mountOptions({ document: mounted.document, notes });
    const file = { name: 'shot.png', type: 'image/png', size: 3, base64: btoa('\u0001\u0002\u0003') };

    const uploaded = await uploadAttachment(options, file, undefined);
    assert.equal(uploaded.ok, true);
    const id = uploaded.ok ? uploaded.id : '';
    assert.match(id, /^att_[0-9a-f]{32}$/u, 'the id is of the shape the widget takes');
    const sent = await plant({
      note: 'with a file',
      target: { element: mounted.query('button'), source: undefined },
      reporter: undefined,
      attachments: [id],
      config: { hiddenStages: [], screenshot: false },
      options,
    });

    assert.equal(sent, true);
    assert.deepEqual(calls.at(0), ['attach', 'shot.png', 'image/png', [1, 2, 3]]);
    assert.deepEqual(calls.at(1)?.[2], { attachments: ['host-shot.png'] });
  });

  it('refuses a write that names a file it did not take, and fails a file the host refused', async () => {
    const { notes } = recording([]);
    const { send } = over({ ...notes, attach: async () => Promise.reject(new Error('full')) });

    assert.equal((await send('/attachments?name=a.png', 'POST', btoa('x'))).status, 500);
    assert.equal((await send('/attachments', 'POST', btoa('x'))).status, 400, 'no name');
    assert.equal((await send('/attachments?name=a.png', 'POST', '%%%')).status, 400, 'not base64');
    const written = await send(`/feedback?attachments=att_${'a'.repeat(32)}`, 'POST', noteOf('a'));
    assert.equal(written.status, 400);
  });

  it('gives back the files of a note, and drops one that is not a file', async () => {
    const stored = [
      {
        id: 'n',
        note: noteOf('a'),
        attachments: [{ name: 'shot.png' }, { name: '' }, 'x', { name: 'doc.pdf', url: 'https://files.test/1' }],
      },
    ] as never as StoredNote[];
    const [issue] = await over({ write: async () => ({ id: 'x' }), read: async () => stored }).read();

    assert.deepEqual(issue?.attachments, [{ name: 'shot.png' }, { name: 'doc.pdf', url: 'https://files.test/1' }]);
  });
});

describe('localNotes takes every function (FRU-647)', () => {
  it('keeps replies, a verdict, an edit and a withdrawal on the note, and gives them back as the reader’s', async () => {
    const storage = memoryStorage();
    const notes = localNotes({ storage });
    await notes.write(noteOf('a', { text: 'first' }), NO_FILE);
    await notes.write(noteOf('b'), NO_FILE);

    await notes.reply?.('a', { text: 'Seen.', author: 'Léa' });
    await notes.edit?.('a', 'second');
    await notes.check?.('a', { verdict: 'wrong', text: 'Still grey.' });
    await notes.withdraw?.('b');
    const [a, b] = (await notes.read?.({ url: PAGE, path: '/pricing' })) ?? [];

    assert.equal(a?.mine, true);
    assert.equal(a?.note.text, 'second');
    assert.equal(a?.stage, 'new', '« Still wrong » opens the note again');
    assert.deepEqual(
      a?.replies?.map((reply) => [reply.text, reply.author, reply.verdict]),
      [
        ['Seen.', 'Léa', undefined],
        ['Still grey.', undefined, 'wrong'],
      ],
    );
    assert.equal(b?.stage, 'closed');
    assert.notEqual(a?.replies?.[0]?.id, a?.replies?.[1]?.id);
  });

  it('keeps the name of a file of a sent note, never its bytes, and nothing of a file of a note never sent', async () => {
    const storage = memoryStorage();
    const notes = localNotes({ storage });
    const kept = await notes.attach?.(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    await notes.attach?.(new File(['x'], 'dropped.txt', { type: 'text/plain' }));
    await notes.write(noteOf('a'), { attachments: [kept?.id ?? ''] });

    const [stored] = (await notes.read?.({ url: PAGE, path: '/pricing' })) ?? [];
    assert.deepEqual(stored?.attachments, [{ name: 'shot.png' }]);
    assert.equal(storage.getItem('fruitback:notes')?.includes('dropped.txt'), false);
  });

  it('fails a reply to a note it does not hold, or when the storage refuses it', async () => {
    await assert.rejects(
      localNotes({ storage: memoryStorage() }).reply?.('nobody', { text: 'Hi' }) ?? Promise.resolve(),
    );
    const storage = memoryStorage();
    await localNotes({ storage }).write(noteOf('a'), NO_FILE);
    const full = memoryStorage(true);
    full.getItem = (key) => storage.getItem(key);
    await assert.rejects(localNotes({ storage: full }).reply?.('a', { text: 'Hi' }) ?? Promise.resolve());
  });
});

describe('a widget with `notes`, in its thread (FRU-647)', () => {
  const shadowOf = (mounted: MountedPage) =>
    mounted.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

  async function threadOf(notes: FruitbackNotes, id = 'a') {
    const mounted = page();
    const widget = init({ document: mounted.document, locale: 'en', notes });
    cleanup.push(() => widget.destroy());
    await widget.refresh();
    assert.equal(widget.focusNote(id), true, 'no pin to open');

    return { mounted, widget, root: shadowOf(mounted) };
  }

  it('offers the reply field and the menu of the author with `localNotes`, and neither without their functions', async () => {
    forbidFetch();
    const storage = memoryStorage();
    await localNotes({ storage }).write(noteOf('a'), NO_FILE);

    /** The items of the menu « ⋯ » of the author, by their words. */
    const itemsOf = (root: ShadowRoot) => {
      root.querySelector<HTMLButtonElement>('.fruitback-thread-more')?.click();

      return [...root.querySelectorAll('.fruitback-thread-more-item')].map((item) => item.textContent?.trim());
    };

    const full = await threadOf(localNotes({ storage }));
    assert.ok(full.root.querySelector('.fruitback-thread-reply-field'), 'no field to reply');
    // No « Move the note »: no function of `notes` takes a move.
    assert.deepEqual(itemsOf(full.root), ['Edit the note', 'Copy link to the note', 'Withdraw the note']);

    const { write, read } = localNotes({ storage });
    const bare = await threadOf({ write, read });
    assert.equal(bare.root.querySelector('.fruitback-thread-reply-field') === null, true, 'a field with no `reply`');
    assert.deepEqual(itemsOf(bare.root), ['Copy link to the note']);
  });

  it('replies from the thread, and the reply comes back after a reload', async () => {
    forbidFetch();
    const storage = memoryStorage();
    await localNotes({ storage }).write(noteOf('a'), NO_FILE);
    const { widget } = await threadOf(localNotes({ storage }));

    assert.equal(await widget.replyTo('a', 'Thanks!'), 'sent');
    const again = await threadOf(localNotes({ storage }));
    assert.deepEqual(
      again.widget.pageNotes()?.[0]?.replies.map((reply) => reply.body),
      ['Thanks!'],
    );
    assert.match(again.root.querySelector('.fruitback-thread-replies')?.textContent ?? '', /Thanks!/u);
  });

  it('asks the author of a note at `done` for a verdict, and opens it again on « Still wrong »', async () => {
    forbidFetch();
    const storage = memoryStorage();
    const mineReply = { id: 'r', text: 'Seen.', createdAt: '2026-11-20T09:00:00.000Z', author: 'Léa', mine: true };
    storage.setItem(
      'fruitback:notes',
      JSON.stringify([{ id: 'a', note: noteOf('a'), stage: 'done', replies: [mineReply] }]),
    );
    const { root, widget } = await threadOf(localNotes({ storage }));
    assert.ok(root.querySelector('.fruitback-thread-check-fixed'), 'no « Looks fixed »');
    // A reply of the reader is no reply of the team: nobody of the team is named for « done ».
    assert.equal(root.querySelector('.fruitback-thread-done')?.textContent, 'Marked done');
    assert.equal(await widget.checkNote('a', 'wrong'), 'sent');
    assert.equal(widget.pageNotes()?.[0]?.stage, 'new');
    const { check: _check, ...noCheck } = localNotes({ storage });
    storage.setItem('fruitback:notes', JSON.stringify([{ id: 'a', note: noteOf('a'), stage: 'done' }]));
    const without = await threadOf(noCheck);
    assert.equal(
      without.root.querySelector('.fruitback-thread-check-fixed') === null,
      true,
      'a verdict with no `check`',
    );
  });
});
