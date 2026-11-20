import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { type Note, parseNote } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { init, mountOptions, plant } from './embed.ts';
import { type FruitbackNotes, NOTES_ENDPOINT, localNotes, notesTransport } from './notes.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

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
    assert.equal(notes?.[0]?.canReply, false, 'no reply with `notes`');

    const blind = page();
    const writeOnly = init({ document: blind.document, locale: 'en', notes: { write: localNotes({ storage }).write } });
    cleanup.push(() => writeOnly.destroy());
    await writeOnly.refresh();

    assert.deepEqual(writeOnly.pageNotes(), [], 'without `read`, no pin comes back');
    assert.equal(writeOnly.notesState(), 'read', 'and the list says « no note », not « could not be read »');
  });
});

describe('notesTransport (FRU-646)', () => {
  it('answers the read with no reply, no place, no batch and no file offered', async () => {
    const answer = await call(
      localNotes({ storage: memoryStorage() }),
      `/feedback?url=${encodeURIComponent(PAGE)}&client=`,
    );
    const body = JSON.parse(answer.body) as Record<string, unknown>;

    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(body), ['issues']);
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
    for (const path of ['/feedback/n/replies', '/feedback/n/notify', '/attachments', '/feedback/n/check']) {
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

    await notes.write(here);
    await notes.write(here);
    await notes.write(there);

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
