import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { forgetSetupAddress, setupAddress } from './setup-address.ts';

/**
 * The address of the site of a visit of the setup (FRU-635): read from `?site=`, kept in the tab
 * across a sign-in with a provider, and forgotten when the site is added.
 */
class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

const query = (text: string) => new URLSearchParams(text);
const NOW = Date.UTC(2026, 10, 19, 12);

describe('the address of the site that comes with the setup (FRU-635)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  });

  it('reads ?site= as the form reads a typed address, and keeps it for the way back from a provider', () => {
    assert.equal(setupAddress(query('site=staging.acme.dev'), NOW), 'https://staging.acme.dev');
    // Back from Google: the front door sends to /setup with no query.
    assert.equal(setupAddress(query(''), NOW + 10 * 60 * 1000), 'https://staging.acme.dev');
    assert.equal(setupAddress(query('site=localhost:5177'), NOW), 'http://localhost:5177');
  });

  it('takes nothing that cannot be an address, and keeps the one before', () => {
    assert.equal(setupAddress(query('site=javascript:alert(1)'), NOW), undefined);
    assert.equal(setupAddress(query('site=staging'), NOW), undefined);
    setupAddress(query('site=staging.acme.dev'), NOW);
    assert.equal(setupAddress(query('site=not an address'), NOW), 'https://staging.acme.dev');
  });

  it('forgets the address after an hour, or once its site is added', () => {
    setupAddress(query('site=staging.acme.dev'), NOW);
    assert.equal(setupAddress(query(''), NOW + 61 * 60 * 1000), undefined);

    setupAddress(query('site=staging.acme.dev'), NOW);
    forgetSetupAddress();
    assert.equal(setupAddress(query(''), NOW), undefined);
  });

  it('reads a kept value again as an address, and works with no storage at all', () => {
    sessionStorage.setItem('fruitback:setup-site', JSON.stringify({ address: 'javascript:alert(1)', until: NOW + 1 }));
    assert.equal(setupAddress(query(''), NOW), undefined);

    Reflect.deleteProperty(globalThis, 'sessionStorage');
    assert.equal(setupAddress(query('site=staging.acme.dev'), NOW), 'https://staging.acme.dev');
    assert.equal(setupAddress(query(''), NOW), undefined);
  });
});
