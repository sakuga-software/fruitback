import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UNREACHABLE } from './api.ts';
import { known, listedOf } from './listed.ts';

describe('a list read from the worker (FRU-162)', () => {
  const sites = (data: { sites: string[] }) => data.sites;

  it('is failed when the worker refused or did not answer, never empty', () => {
    assert.equal(listedOf({ ok: false, status: 503, error: 'store-unavailable' }, sites), 'failed');
    assert.equal(listedOf({ ok: false, status: 401, error: 'unauthenticated' }, sites), 'failed');
    assert.equal(listedOf(UNREACHABLE, sites), 'failed');
  });

  it('is empty only when the worker answered an empty list: the control', () => {
    assert.deepEqual(listedOf({ ok: true, data: { sites: [] } }, sites), []);
    assert.deepEqual(listedOf({ ok: true, data: { sites: ['a'] } }, sites), ['a']);
  });

  it('has no items to count while it is loading or failed', () => {
    assert.equal(known('loading'), undefined);
    assert.equal(known('failed'), undefined);
    assert.deepEqual(known([]), []);
  });
});
