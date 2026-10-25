import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type Draft, batchBody, createDraftStore, cutIntoRequests, offeredBatch, withPlacesOfNow } from './drafts.ts';

/** A `Storage` with nothing behind it, and a switch that makes it refuse writes like a full quota. */
function memoryStorage(): Storage & { refuse: boolean } {
  const values = new Map<string, string>();
  const storage = {
    refuse: false,
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (storage.refuse) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => void values.delete(key),
  };

  return storage;
}

const draft = (id: string, more: Partial<Draft> = {}, note = `Note ${id}`): Draft => ({
  note: noteFixture({ id, text: note }),
  ...more,
});

describe('the drafts of a tab (FRU-124)', () => {
  it('outlive a new store on the same storage, oldest first, and leave it when all are sent', () => {
    const storage = memoryStorage();
    const first = createDraftStore({ storage, key: 'k' });
    first.add(draft('sd_a', { destination: 'dst_web' }));
    first.add(draft('sd_b'));

    // A reload: a new store reads what the last one wrote.
    const again = createDraftStore({ storage, key: 'k' });
    assert.deepEqual(
      again.list().map((each) => [each.note.id, each.destination]),
      [
        ['sd_a', 'dst_web'],
        ['sd_b', undefined],
      ],
    );

    again.remove(['sd_a']);
    assert.deepEqual(
      createDraftStore({ storage, key: 'k' })
        .list()
        .map((each) => each.note.id),
      ['sd_b'],
    );
    again.remove(['sd_b']);
    assert.equal(storage.getItem('k'), null, 'an empty list stays in the storage');
  });

  // FRU-44: the picture of a note is taken when the note is written, and a note kept for later is
  // sent as the note it was. The address of its picture must come out of the storage, and reach the
  // body that is sent.
  it('keeps the address of the picture of a note through a reload, and sends it', () => {
    const storage = memoryStorage();
    const screenshot = {
      url: 'https://worker.test/screenshot/shot_0123456789abcdef0123456789abcdef',
      width: 200,
      height: 80,
    };
    createDraftStore({ storage, key: 'k' }).add({
      note: noteFixture({ id: 'sd_a', text: 'With a picture', screenshot }),
    });

    const [kept] = createDraftStore({ storage, key: 'k' }).list();

    assert.deepEqual(kept?.note.screenshot, screenshot);
    assert.deepEqual((JSON.parse(batchBody([kept as Draft])) as { screenshot?: unknown }[])[0]?.screenshot, screenshot);
  });

  it('keeps one draft for one note, and tells its listeners', () => {
    const store = createDraftStore({ storage: null, key: 'k' });
    let told = 0;
    store.subscribe(() => (told += 1));
    store.add(draft('sd_a', {}, 'First'));
    store.add(draft('sd_a', {}, 'Second'));
    store.remove(['sd_unknown']);

    assert.deepEqual(
      store.list().map((each) => each.note.text),
      ['Second'],
    );
    assert.equal(told, 2, 'a removal that removes nothing told the listeners');
  });

  it('drops what is not a note, and reads garbage as no draft at all', () => {
    const storage = memoryStorage();
    storage.setItem(
      'k',
      JSON.stringify([{ note: noteFixture({ id: 'sd_good' }) }, { note: { kind: 'nope' } }, 'text', null]),
    );
    assert.deepEqual(
      createDraftStore({ storage, key: 'k' })
        .list()
        .map((each) => each.note.id),
      ['sd_good'],
    );

    storage.setItem('k', '{not json');
    assert.deepEqual(createDraftStore({ storage, key: 'k' }).list(), []);
  });

  it('keeps the drafts in memory when the storage refuses them', () => {
    const storage = memoryStorage();
    storage.refuse = true;
    const store = createDraftStore({ storage, key: 'k' });
    store.add(draft('sd_a'));

    assert.equal(store.list().length, 1);
  });
});

describe('the requests that send the drafts (FRU-124)', () => {
  const offer = { max: 2, maxBytes: 1_000_000 };
  const ids = (requests: Draft[][]) => requests.map((request) => request.map((each) => each.note.id));

  it('sends one note for each request to a worker that offers no batch', () => {
    assert.deepEqual(ids(cutIntoRequests([draft('a'), draft('b')], undefined)), [['a'], ['b']]);
  });

  it('cuts by the number the worker takes, and by place: ?destination= is for the whole batch', () => {
    const drafts = [draft('a'), draft('b', { destination: 'dst_2' }), draft('c'), draft('d'), draft('e')];

    assert.deepEqual(ids(cutIntoRequests(drafts, offer)), [['a', 'c'], ['d', 'e'], ['b']]);
  });

  it('cuts by the bytes the worker takes, and sends alone a note heavier than that', () => {
    const long = 'é'.repeat(2_000);
    const drafts = [draft('a', {}, long), draft('b', {}, long), draft('c', {}, 'é'.repeat(5_000))];
    const one = new TextEncoder().encode(batchBody([drafts[0] as Draft])).length;
    const cut = cutIntoRequests(drafts, { max: 10, maxBytes: one + 10 });

    assert.deepEqual(ids(cut), [['a'], ['b'], ['c']]);
    for (const request of cut.slice(0, 2)) {
      assert.ok(new TextEncoder().encode(batchBody(request)).length <= one + 10);
    }
  });

  it('sends to the first place a draft whose place the team took away, like the composer at its second try', () => {
    const offered = [{ id: 'dst_web' }, { id: 'dst_design' }];
    const drafts = [draft('a', { destination: 'dst_design' }), draft('b', { destination: 'dst_gone' }), draft('c')];
    const places = (list: Draft[]) => list.map((each) => each.destination);

    // The control: a place still offered is kept.
    assert.deepEqual(places(withPlacesOfNow(drafts, offered)), ['dst_design', undefined, undefined]);
    // A reader who lost the right to choose: every draft goes where the site sends by default.
    assert.deepEqual(places(withPlacesOfNow(drafts, [])), [undefined, undefined, undefined]);
  });

  it('reads the offer of the worker tolerantly', () => {
    assert.deepEqual(offeredBatch({ max: 10, maxBytes: 65_536 }), { max: 10, maxBytes: 65_536 });
    for (const bad of [undefined, null, 'x', { max: 0, maxBytes: 1 }, { max: 2.5, maxBytes: 1 }, { max: 2 }]) {
      assert.equal(offeredBatch(bad), undefined, JSON.stringify(bad));
    }
  });
});
