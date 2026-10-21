import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refusalOf } from './frame-refusal.ts';

describe('the refusal of a frame the console knows before it tries (FRU-354)', () => {
  it('frames an https site from an https console, and any site from an http console', () => {
    assert.equal(refusalOf('https://staging.acme.dev', 'https://console.fruitback.com'), undefined);
    assert.equal(refusalOf('http://192.168.1.20:5173', 'http://localhost:5178'), undefined);
    assert.equal(refusalOf('https://staging.acme.dev', 'http://localhost:5178'), undefined);
  });

  it('refuses an http site in an https console, except a host of this machine', () => {
    assert.equal(refusalOf('http://staging.acme.dev', 'https://console.fruitback.com'), 'insecure');
    assert.equal(refusalOf('http://192.168.1.20:5173', 'https://console.fruitback.com'), 'insecure');
    assert.equal(refusalOf('http://staging.local', 'https://console.fruitback.com'), 'insecure');
    for (const local of [
      'http://localhost:3000',
      'http://shop.localhost',
      'http://127.0.0.1:8080',
      'http://[::1]:5177',
    ]) {
      assert.equal(refusalOf(local, 'https://console.fruitback.com'), undefined, local);
    }
  });

  it('refuses the console itself, and an address that does not read', () => {
    assert.equal(refusalOf('https://console.fruitback.com', 'https://console.fruitback.com'), 'console');
    assert.equal(refusalOf('not an address', 'https://console.fruitback.com'), 'insecure');
  });
});
