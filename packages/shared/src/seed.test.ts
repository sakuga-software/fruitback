import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_KIND, SEED_VERSION, canonicalizePageUrl, parseSeed } from './seed.ts';
import { minimalSeedFixture, seedFixture } from './seed.fixture.ts';

describe('createSeed', () => {
  it('stamps the current kind and version', () => {
    const seed = seedFixture();

    assert.equal(seed.kind, SEED_KIND);
    assert.equal(seed.v, SEED_VERSION);
  });

  it('adds no field the caller did not provide', () => {
    // Schema defaults would silently break the write ↦ read round-trip.
    const seed = minimalSeedFixture();

    assert.deepEqual(Object.keys(seed).sort(), ['anchor', 'createdAt', 'id', 'kind', 'note', 'page', 'v', 'viewport']);
  });

  it('rejects a page URL that is not absolute http(s)', () => {
    assert.throws(() => seedFixture({ page: { url: '/pricing', path: '/pricing' } }));
    assert.throws(() => seedFixture({ page: { url: 'javascript:alert(1)', path: '/' } }));
  });

  it('rejects a malformed timestamp', () => {
    assert.throws(() => seedFixture({ createdAt: 'yesterday' }));
  });

  it('rejects a text excerpt used as content storage', () => {
    assert.throws(() => seedFixture({ anchor: { ...seedFixture().anchor, text: 'x'.repeat(161) } }));
  });
});

describe('parseSeed', () => {
  it('accepts a seed it produced', () => {
    const result = parseSeed(JSON.parse(JSON.stringify(seedFixture())));

    assert.deepEqual(result, { ok: true, seed: seedFixture() });
  });

  it('reports anything without our kind as not-found', () => {
    assert.deepEqual(parseSeed({ hello: 'world' }), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseSeed(null), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseSeed('{}'), { ok: false, reason: 'not-found' });
  });

  it('refuses a payload from a newer Fruitback instead of dropping its fields', () => {
    const result = parseSeed({ ...seedFixture(), v: SEED_VERSION + 1 });

    assert.deepEqual(result, { ok: false, reason: 'unsupported-version', version: SEED_VERSION + 1 });
  });

  it('reports a corrupted payload as invalid, naming the field', () => {
    const { anchor: _dropped, ...withoutAnchor } = seedFixture();
    const result = parseSeed(withoutAnchor);

    if (result.ok || result.reason !== 'invalid') {
      throw new assert.AssertionError({ message: 'expected an invalid result', actual: result });
    }
    assert.ok(result.message.includes('anchor'), result.message);
  });

  it('reports a missing version as invalid rather than unsupported', () => {
    const { v: _dropped, ...withoutVersion } = seedFixture();

    assert.deepEqual(parseSeed(withoutVersion), {
      ok: false,
      reason: 'invalid',
      message: 'missing or malformed seed version',
    });
  });
});

describe('canonicalizePageUrl', () => {
  it('drops the fragment, the credentials and the default port', () => {
    assert.equal(canonicalizePageUrl('https://user:pass@Acme.test:443/pricing#cta'), 'https://acme.test/pricing');
  });

  it('drops tracking parameters but keeps the ones that identify a screen', () => {
    assert.equal(
      canonicalizePageUrl('https://acme.test/pricing?utm_source=ads&gclid=x&tab=annual'),
      'https://acme.test/pricing?tab=annual',
    );
  });

  it('sorts the remaining parameters so two links to one screen group together', () => {
    const fromNav = canonicalizePageUrl('https://acme.test/pricing?plan=pro&tab=annual');
    const fromEmail = canonicalizePageUrl('https://acme.test/pricing?tab=annual&plan=pro&utm_medium=email');

    assert.equal(fromNav, fromEmail);
  });

  it('removes a trailing slash but keeps the root one', () => {
    assert.equal(canonicalizePageUrl('https://acme.test/pricing/'), 'https://acme.test/pricing');
    assert.equal(canonicalizePageUrl('https://acme.test/'), 'https://acme.test/');
  });

  it('can collapse every screen of a path into one key', () => {
    assert.equal(
      canonicalizePageUrl('https://acme.test/pricing?tab=annual', { keepSearch: false }),
      'https://acme.test/pricing',
    );
  });

  it('is idempotent', () => {
    const once = canonicalizePageUrl('https://acme.test/pricing/?utm_source=x&tab=annual#top');

    assert.equal(canonicalizePageUrl(once), once);
  });

  it('throws on a relative URL rather than guessing an origin', () => {
    assert.throws(() => canonicalizePageUrl('/pricing'));
  });
});
