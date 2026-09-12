import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSite } from './sites.ts';

describe('parseSite', () => {
  /**
   * The one shape a release cannot re-run.
   *
   * Written as a literal rather than built by this repository's own writer, because what has to keep
   * working is what a browser profile already holds: an entry stored before SKG-596, with no `mode`
   * and a real client id. If it ever stopped reading as private mode, every reviewer using the
   * extension today would open their browser to a site that mounts nothing.
   */
  it('reads an entry written before the modes existed as private mode', () => {
    assert.deepEqual(parseSite({ endpoint: 'https://worker.test', clientId: 'acme', enabled: true }), {
      mode: 'private',
      endpoint: 'https://worker.test',
      clientId: 'acme',
      enabled: true,
    });
  });

  it('reads a team entry, which carries no client id at all', () => {
    assert.deepEqual(parseSite({ mode: 'team', endpoint: 'https://worker.test', enabled: true }), {
      mode: 'team',
      endpoint: 'https://worker.test',
      enabled: true,
    });
  });

  /** A client id on a team entry is a value nothing reads, so it is not kept. */
  it('drops a client id from a team entry rather than storing one nothing uses', () => {
    assert.equal(
      Object.hasOwn(parseSite({ mode: 'team', endpoint: 'https://worker.test', clientId: 'acme' }) ?? {}, 'clientId'),
      false,
    );
  });

  /** An unknown mode reads as the one that existed first, and is then held to its own rules. */
  it('reads a mode it does not know as private', () => {
    assert.partialDeepStrictEqual(parseSite({ mode: 'squad', endpoint: 'https://worker.test', clientId: 'acme' }), {
      mode: 'private',
    });
    assert.equal(parseSite({ mode: 'squad', endpoint: 'https://worker.test' }), undefined);
  });

  it('refuses an entry with nothing to call', () => {
    for (const value of [undefined, null, 42, {}, { endpoint: '' }, { mode: 'team', endpoint: '' }]) {
      assert.equal(parseSite(value), undefined, JSON.stringify(value));
    }
  });

  it('refuses a private entry with no client id', () => {
    assert.equal(parseSite({ endpoint: 'https://worker.test' }), undefined);
    assert.equal(parseSite({ mode: 'private', endpoint: 'https://worker.test', clientId: '' }), undefined);
  });

  /** Absent reads as on: an entry exists because somebody added this site. */
  it('reads an absent switch as on, in both modes', () => {
    assert.partialDeepStrictEqual(parseSite({ endpoint: 'https://worker.test', clientId: 'acme' }), { enabled: true });
    assert.partialDeepStrictEqual(parseSite({ mode: 'team', endpoint: 'https://worker.test' }), { enabled: true });
  });

  it('drops a label that is not a string instead of refusing the entry', () => {
    const site = parseSite({ endpoint: 'https://worker.test', clientId: 'acme', label: 7 });

    assert.partialDeepStrictEqual(site, { mode: 'private', clientId: 'acme' });
    assert.equal(Object.hasOwn(site ?? {}, 'label'), false);
  });
});
