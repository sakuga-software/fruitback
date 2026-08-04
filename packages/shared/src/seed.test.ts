import { describe, expect, it } from 'vitest';
import { SEED_KIND, SEED_VERSION, canonicalizePageUrl, parseSeed } from './seed';
import { minimalSeedFixture, seedFixture } from './seed.fixture';

describe('createSeed', () => {
  it('stamps the current kind and version', () => {
    const seed = seedFixture();

    expect(seed.kind).toBe(SEED_KIND);
    expect(seed.v).toBe(SEED_VERSION);
  });

  it('adds no field the caller did not provide', () => {
    // Schema defaults would silently break the write ↦ read round-trip.
    const seed = minimalSeedFixture();

    expect(Object.keys(seed).sort()).toEqual(['anchor', 'createdAt', 'id', 'kind', 'note', 'page', 'v', 'viewport']);
  });

  it('rejects a page URL that is not absolute http(s)', () => {
    expect(() => seedFixture({ page: { url: '/pricing', path: '/pricing' } })).toThrow();
    expect(() => seedFixture({ page: { url: 'javascript:alert(1)', path: '/' } })).toThrow();
  });

  it('rejects a malformed timestamp', () => {
    expect(() => seedFixture({ createdAt: 'yesterday' })).toThrow();
  });

  it('rejects a text excerpt used as content storage', () => {
    expect(() => seedFixture({ anchor: { ...seedFixture().anchor, text: 'x'.repeat(161) } })).toThrow();
  });
});

describe('parseSeed', () => {
  it('accepts a seed it produced', () => {
    const result = parseSeed(JSON.parse(JSON.stringify(seedFixture())));

    expect(result).toEqual({ ok: true, seed: seedFixture() });
  });

  it('reports anything without our kind as not-found', () => {
    expect(parseSeed({ hello: 'world' })).toEqual({ ok: false, reason: 'not-found' });
    expect(parseSeed(null)).toEqual({ ok: false, reason: 'not-found' });
    expect(parseSeed('{}')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses a payload from a newer Fruitback instead of dropping its fields', () => {
    const result = parseSeed({ ...seedFixture(), v: SEED_VERSION + 1 });

    expect(result).toEqual({ ok: false, reason: 'unsupported-version', version: SEED_VERSION + 1 });
  });

  it('reports a corrupted payload as invalid, naming the field', () => {
    const { anchor: _dropped, ...withoutAnchor } = seedFixture();
    const result = parseSeed(withoutAnchor);

    if (result.ok || result.reason !== 'invalid') throw new Error(`expected an invalid result, got ${result.ok}`);
    expect(result.message).toContain('anchor');
  });

  it('reports a missing version as invalid rather than unsupported', () => {
    const { v: _dropped, ...withoutVersion } = seedFixture();

    expect(parseSeed(withoutVersion)).toEqual({
      ok: false,
      reason: 'invalid',
      message: 'missing or malformed seed version',
    });
  });
});

describe('canonicalizePageUrl', () => {
  it('drops the fragment, the credentials and the default port', () => {
    expect(canonicalizePageUrl('https://user:pass@Acme.test:443/pricing#cta')).toBe('https://acme.test/pricing');
  });

  it('drops tracking parameters but keeps the ones that identify a screen', () => {
    expect(canonicalizePageUrl('https://acme.test/pricing?utm_source=ads&gclid=x&tab=annual')).toBe(
      'https://acme.test/pricing?tab=annual',
    );
  });

  it('sorts the remaining parameters so two links to one screen group together', () => {
    const fromNav = canonicalizePageUrl('https://acme.test/pricing?plan=pro&tab=annual');
    const fromEmail = canonicalizePageUrl('https://acme.test/pricing?tab=annual&plan=pro&utm_medium=email');

    expect(fromNav).toBe(fromEmail);
  });

  it('removes a trailing slash but keeps the root one', () => {
    expect(canonicalizePageUrl('https://acme.test/pricing/')).toBe('https://acme.test/pricing');
    expect(canonicalizePageUrl('https://acme.test/')).toBe('https://acme.test/');
  });

  it('can collapse every screen of a path into one key', () => {
    expect(canonicalizePageUrl('https://acme.test/pricing?tab=annual', { keepSearch: false })).toBe(
      'https://acme.test/pricing',
    );
  });

  it('is idempotent', () => {
    const once = canonicalizePageUrl('https://acme.test/pricing/?utm_source=x&tab=annual#top');

    expect(canonicalizePageUrl(once)).toBe(once);
  });

  it('throws on a relative URL rather than guessing an origin', () => {
    expect(() => canonicalizePageUrl('/pricing')).toThrow();
  });
});
