import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HIDDEN_ORIGINS_KEY, hiddenUnder, isHidden, parseHidden, readHidden, setHidden } from './page-visibility.ts';

function area(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = { ...initial };

  return {
    items,
    get: async (key: string) => (key in items ? { [key]: items[key] } : {}),
    set: async (next: Record<string, unknown>) => void Object.assign(items, next),
    remove: async (key: string) => void delete items[key],
  };
}

describe('« Show Fruitback on this page » (FRU-444)', () => {
  it('hides an origin, keeps the others, and removes the key when the last one is shown', async () => {
    const storage = area();
    await setHidden(storage, 'https://acme.dev', true);
    await setHidden(storage, 'http://localhost:5177', true);
    await setHidden(storage, 'https://acme.dev', true);

    assert.deepEqual(storage.items[HIDDEN_ORIGINS_KEY], ['http://localhost:5177', 'https://acme.dev']);
    assert.equal(await isHidden(storage, 'https://acme.dev'), true);
    assert.equal(await isHidden(storage, 'https://other.dev'), false);

    await setHidden(storage, 'https://acme.dev', false);
    await setHidden(storage, 'http://localhost:5177', false);

    assert.equal(HIDDEN_ORIGINS_KEY in storage.items, false);
  });

  it('keeps only origins: a path, another scheme or another type is left out', () => {
    assert.deepEqual(
      parseHidden([
        'https://acme.dev',
        'https://acme.dev/page',
        'chrome://extensions',
        'javascript:alert(1)',
        42,
        null,
      ]),
      ['https://acme.dev'],
    );
    assert.deepEqual(parseHidden('https://acme.dev'), []);
    assert.deepEqual(parseHidden(undefined), []);
  });

  it('shows the widget when the read fails', async () => {
    const failing = { ...area(), get: async () => Promise.reject(new Error('closed')) };

    assert.deepEqual(await readHidden(failing), []);
    assert.equal(await isHidden(failing, 'https://acme.dev'), false);
  });

  it('gives a rule the hidden origins it covers, and no other', () => {
    const hidden = ['https://shop.acme.dev', 'https://acme.dev', 'https://other.dev', 'https://acme.dev:8443'];

    assert.deepEqual(hiddenUnder('https://*.acme.dev', hidden), ['https://acme.dev', 'https://shop.acme.dev']);
    assert.deepEqual(hiddenUnder('https://other.dev', hidden), ['https://other.dev']);
    assert.deepEqual(hiddenUnder('https://none.dev', hidden), []);
  });
});
