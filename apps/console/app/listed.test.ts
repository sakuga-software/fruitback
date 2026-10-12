import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UNREACHABLE } from './api.ts';
import { edited, known, listedOf } from './listed.ts';

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

  it('is failed for an answer that says yes and holds no list', () => {
    assert.equal(listedOf({ ok: true, data: undefined as unknown as { sites: string[] } }, sites), 'failed');
    assert.equal(listedOf({ ok: true, data: {} as { sites: string[] } }, sites), 'failed');
    // A selector written for a list, on an answer that is an object: it throws, and that is `failed`.
    const pending = (data: { status: string }[]) => data.filter((each) => each.status === 'pending');
    assert.equal(listedOf({ ok: true, data: {} as { status: string }[] }, pending), 'failed');
  });

  it('has no items to count while it is loading or failed', () => {
    assert.equal(known('loading'), undefined);
    assert.equal(known('failed'), undefined);
    assert.deepEqual(known([]), []);
  });

  it('stays not read when a row is removed from it or added to it', () => {
    const remove = (items: readonly string[]) => items.filter((item) => item !== 'a');

    assert.equal(edited('failed', remove), 'failed');
    assert.equal(edited('loading', remove), 'loading');
    assert.deepEqual(edited(['a', 'b'], remove), ['b']);
  });
});

describe('a screen that reads a list (FRU-162)', () => {
  /** A refused answer that becomes an empty list in the state of a screen: `if (!answer.ok) return setX([])`. */
  const EMPTY_FOR_A_FAILURE = /!\w+\.ok\)[^;\n]*set\w+\(\[\]\)/;
  const routes = new URL('./routes/', import.meta.url);

  it('never keeps an empty list for an answer that failed', () => {
    const found = readdirSync(routes).filter((name) =>
      EMPTY_FOR_A_FAILURE.test(readFileSync(new URL(name, routes), 'utf8')),
    );

    assert.deepEqual(found, []);
  });

  it('finds the line it looks for: the control', () => {
    // The line of the panel of a connector before it was a `Listed`: a failed read of the states read
    // as « no site sends here yet ».
    assert.match('      if (!answer.ok) return setStates([]);', EMPTY_FOR_A_FAILURE);
    assert.doesNotMatch('      setStates(listedOf(answer, (data) => data.states));', EMPTY_FOR_A_FAILURE);
  });
});
