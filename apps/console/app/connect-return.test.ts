import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keepConnect, takeConnect } from './connect-return.ts';

/** A `sessionStorage` of the test: the console has no DOM under `node --test`. */
function storage(): Map<string, string> {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });

  return items;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});

describe('the request a sign-in with a provider comes back to (FRU-240)', () => {
  it('is given back once, then forgotten', () => {
    const items = storage();
    keepConnect('Ab3_-x', 1000);
    assert.equal(takeConnect(2000), 'Ab3_-x');
    assert.equal(takeConnect(2000), undefined);
    assert.equal(items.size, 0);
  });

  it('is not given back after the fifteen minutes of a request', () => {
    storage();
    keepConnect('Ab3', 0);
    assert.equal(takeConnect(15 * 60 * 1000 + 1), undefined);
    // The control: one millisecond before, it is.
    keepConnect('Ab3', 0);
    assert.equal(takeConnect(15 * 60 * 1000), 'Ab3');
  });

  it('keeps and follows nothing that is not the id of a request: no path, no address', () => {
    const items = storage();
    for (const forged of ['../w/w1/account', 'https://evil.example', 'a b', '', 'x'.repeat(65)]) {
      keepConnect(forged, 0);
      assert.equal(items.size, 0, forged);
      items.set('fruitback:connect', JSON.stringify({ request: forged, until: 1e15 }));
      assert.equal(takeConnect(0), undefined, forged);
    }
    items.set('fruitback:connect', '{not json');
    assert.equal(takeConnect(0), undefined);
  });

  it('does nothing in a browser with no storage', () => {
    keepConnect('Ab3', 0);
    assert.equal(takeConnect(0), undefined);
  });
});
