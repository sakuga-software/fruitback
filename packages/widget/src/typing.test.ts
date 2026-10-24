import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteAnchor } from '@fruitback/shared';
import { MAX_TYPING, createTypingStore } from './typing.ts';

/** The note being written, saved per page and per element (FRU-311). */

function memoryStorage(): Storage {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const anchor = (selector: string): NoteAnchor => ({
  selector,
  domPath: `main > ${selector}`,
  tag: 'button',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
});
const PAGE = 'https://staging.acme.dev/pricing';
const LATTE = { page: PAGE, anchor: anchor('#latte') };
const MOCHA = { page: PAGE, anchor: anchor('#mocha') };
const KEY = 'fruitback:config:typing';

describe('the note being written (FRU-311)', () => {
  it('keeps a text for its page and its element, and outlives a new store on the same storage', () => {
    const storage = memoryStorage();
    let clock = 1;
    const store = createTypingStore({ storage, key: KEY, now: () => clock++ });
    store.write(LATTE, 'Le prix devrait être 18 €');
    store.write(MOCHA, 'Le Mocha manque de mousse');

    const again = createTypingStore({ storage, key: KEY });
    assert.equal(again.get(LATTE)?.text, 'Le prix devrait être 18 €');
    assert.equal(again.get(MOCHA)?.text, 'Le Mocha manque de mousse');
    assert.equal(again.get({ page: 'https://staging.acme.dev/', anchor: anchor('#latte') }), undefined);
    // The one written last is the one that reopens.
    assert.equal(again.latest(PAGE)?.anchor.selector, '#mocha');
    assert.equal(again.latest('https://staging.acme.dev/'), undefined);
  });

  it('forgets a text emptied by hand, and the key once nothing is left', () => {
    const storage = memoryStorage();
    const store = createTypingStore({ storage, key: KEY });
    store.write(LATTE, 'Un mot');
    store.write(LATTE, '   ');

    assert.equal(store.get(LATTE), undefined);
    assert.equal(storage.getItem(KEY), null);
  });

  // The witness: a composer opened and closed with nothing typed writes nothing at all.
  it('writes nothing for an empty text', () => {
    const storage = memoryStorage();
    createTypingStore({ storage, key: KEY }).write(LATTE, '');

    assert.equal(storage.length, 0);
  });

  it('keeps the latest texts of a tab, and drops the oldest past the limit', () => {
    let clock = 1;
    const store = createTypingStore({ storage: memoryStorage(), key: KEY, now: () => clock++ });
    for (let index = 0; index <= MAX_TYPING; index += 1) {
      store.write({ page: PAGE, anchor: anchor(`#card-${index}`) }, `note ${index}`);
    }

    assert.equal(store.get({ page: PAGE, anchor: anchor('#card-0') }), undefined);
    assert.equal(store.get({ page: PAGE, anchor: anchor(`#card-${MAX_TYPING}`) })?.text, `note ${MAX_TYPING}`);
  });

  it('drops what is not a saved text, and keeps the rest', () => {
    const storage = memoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify([
        { page: PAGE, anchor: { selector: 1 }, text: 'x', at: 1 },
        // A selector and a tag, and no bounds: resolveAnchor reads them, so the entry goes (review).
        { page: PAGE, anchor: { selector: '#mocha', tag: 'button' }, text: 'sans bornes', at: 1 },
        'nope',
        { ...LATTE, text: 'gardé', at: 2 },
      ]),
    );

    const read = createTypingStore({ storage, key: KEY });
    assert.equal(read.get(LATTE)?.text, 'gardé');
    assert.equal(read.get({ page: PAGE, anchor: anchor('#mocha') }), undefined);
    storage.setItem(KEY, '{not json');
    assert.equal(createTypingStore({ storage, key: KEY }).latest(PAGE), undefined);
  });

  it('keeps the text in memory when the storage refuses', () => {
    const refusing = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as Storage;
    const store = createTypingStore({ storage: refusing, key: KEY });
    store.write(LATTE, 'Gardé ici');

    assert.equal(store.get(LATTE)?.text, 'Gardé ici');
  });
});
