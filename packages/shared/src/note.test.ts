import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_KIND, NOTE_VERSION, canonicalizePageUrl, parseNote } from './note.ts';
import { minimalNoteFixture, noteFixture } from './note.fixture.ts';

describe('createNote', () => {
  it('stamps the current kind and version', () => {
    const note = noteFixture();

    assert.equal(note.kind, NOTE_KIND);
    assert.equal(note.v, NOTE_VERSION);
  });

  it('names the kind and the version of a note (FRU-378)', () => {
    assert.equal(NOTE_KIND, 'fruitback.note');
    assert.equal(NOTE_VERSION, 3);
  });

  it('adds no field the caller did not provide', () => {
    // Schema defaults would silently break the write ↦ read round-trip.
    const note = minimalNoteFixture();

    assert.deepEqual(Object.keys(note), ['kind', 'v', 'id', 'createdAt', 'text', 'page', 'viewport', 'anchor']);
  });

  it('rejects a page URL that is not absolute http(s)', () => {
    assert.throws(() => noteFixture({ page: { url: '/pricing', path: '/pricing' } }));
    assert.throws(() => noteFixture({ page: { url: 'javascript:alert(1)', path: '/' } }));
  });

  it('accepts a page URL over plain http', () => {
    assert.equal(
      noteFixture({ page: { url: 'http://localhost:5173/pricing', path: '/pricing' } }).page.url,
      'http://localhost:5173/pricing',
    );
  });

  it('rejects a malformed timestamp', () => {
    assert.throws(() => noteFixture({ createdAt: 'yesterday' }));
  });

  it('rejects a text excerpt used as content storage', () => {
    assert.throws(() => noteFixture({ anchor: { ...noteFixture().anchor, text: 'x'.repeat(161) } }));
  });
});

describe('parseNote', () => {
  it('accepts a note it produced, the full one and the minimal one', () => {
    for (const note of [noteFixture(), minimalNoteFixture()]) {
      assert.deepEqual(parseNote(JSON.parse(JSON.stringify(note))), { ok: true, note });
    }
  });

  it('keeps the words of the note in text, and in no field called note', () => {
    const result = parseNote(JSON.parse(JSON.stringify(noteFixture({ text: 'Le bouton déborde.' }))));

    assert.ok(result.ok);
    assert.equal(result.note.text, 'Le bouton déborde.');
    assert.equal('note' in result.note, false);
  });

  it('reports anything without our kind as not-found', () => {
    assert.deepEqual(parseNote({ hello: 'world' }), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNote(null), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNote('{}'), { ok: false, reason: 'not-found' });
  });

  it('refuses a payload from a newer Fruitback instead of dropping its fields', () => {
    const result = parseNote({ ...noteFixture(), v: NOTE_VERSION + 1 });

    assert.deepEqual(result, { ok: false, reason: 'unsupported-version', version: NOTE_VERSION + 1 });
  });

  it('refuses a fruitback.note of a version before 3, which no writer made', () => {
    for (const v of [1, 2]) {
      assert.deepEqual(parseNote({ ...noteFixture(), v }), {
        ok: false,
        reason: 'invalid',
        message: 'v: fruitback.note starts at version 3',
      });
    }
  });

  it('refuses a note that holds its words in note rather than text', () => {
    const { text, ...withoutText } = noteFixture();

    assert.deepEqual(parseNote({ ...withoutText, note: text }), {
      ok: false,
      reason: 'invalid',
      message: 'text: Invalid input: expected string, received undefined',
    });
  });

  it('refuses a text longer than a note may be', () => {
    const result = parseNote({ ...noteFixture(), text: 'x'.repeat(5_001) });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'invalid');
    assert.match(!result.ok && result.reason === 'invalid' ? result.message : '', /^text: /);
  });

  it('reports a corrupted payload as invalid, naming the field', () => {
    const { anchor: _dropped, ...withoutAnchor } = noteFixture();
    const result = parseNote(withoutAnchor);

    if (result.ok || result.reason !== 'invalid') {
      throw new assert.AssertionError({ message: 'expected an invalid result', actual: result });
    }
    assert.ok(result.message.includes('anchor'), result.message);
  });

  it('reports a version that is not a positive integer as malformed', () => {
    for (const v of [0, -1, 1.5, '3', null, Number.NaN]) {
      assert.deepEqual(
        parseNote({ ...noteFixture(), v }),
        { ok: false, reason: 'invalid', message: 'missing or malformed note version' },
        `v ${JSON.stringify(v)} should be malformed`,
      );
    }
  });

  it('reports a missing version as invalid rather than unsupported', () => {
    const { v: _dropped, ...withoutVersion } = noteFixture();

    assert.deepEqual(parseNote(withoutVersion), {
      ok: false,
      reason: 'invalid',
      message: 'missing or malformed note version',
    });
  });
});

describe('canonicalizePageUrl', () => {
  it('drops each tracking parameter by its exact name, whatever its case', () => {
    const tracking = [
      'utm_source',
      'utm_whatever',
      'UTM_Medium',
      'gclid',
      'gbraid',
      'wbraid',
      'dclid',
      'fbclid',
      'igshid',
      'msclkid',
      'ttclid',
      'twclid',
      'yclid',
      'li_fat_id',
      'mc_cid',
      'mc_eid',
      '_ga',
      '_gl',
    ];
    for (const key of tracking) {
      assert.equal(canonicalizePageUrl(`https://acme.test/p?${key}=1&tab=2`), 'https://acme.test/p?tab=2', key);
    }
  });

  it('keeps a parameter that only contains the name of a tracking one, because it can name a screen', () => {
    // Two screens that differ by `?xgclid=1` are two screens: dropping that parameter would make them
    // share their pins.
    const kept = [
      'xutm_source',
      'xgclid',
      'gclidx',
      'xgbraid',
      'gbraidx',
      'xwbraid',
      'wbraidx',
      'xdclid',
      'dclidx',
      'xfbclid',
      'fbclid_note',
      'xigshid',
      'igshidx',
      'xmsclkid',
      'msclkidx',
      'xttclid',
      'ttclidx',
      'xtwclid',
      'twclidx',
      'xyclid',
      'yclidx',
      'xli_fat_id',
      'li_fat_idx',
      'xmc_cid',
      'mc_cidx',
      'x_ga',
      '_gax',
    ];
    for (const key of kept) {
      assert.equal(canonicalizePageUrl(`https://acme.test/p?${key}=1`), `https://acme.test/p?${key}=1`, key);
    }
  });

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

describe('the message of an invalid note (FRU-377)', () => {
  it('names the path of each field, with the words of its rule', () => {
    const note = JSON.parse(JSON.stringify(noteFixture()));

    assert.deepEqual(parseNote({ ...note, createdAt: 'yesterday', page: { ...note.page, url: 'ftp://x' } }), {
      ok: false,
      reason: 'invalid',
      message: 'createdAt: expected an ISO 8601 timestamp; page.url: expected an absolute http(s) URL',
    });
  });
});

describe('the identity of a page whose scheme the URL standard does not know (FRU-377)', () => {
  it('lowercases its host, and keeps the slash of its root', () => {
    // `URL` lowercases the host of http and https on its own, and never leaves their path empty.
    // It does neither for another scheme, so this is where those two lines show.
    assert.equal(canonicalizePageUrl('app://Host.Example/'), 'app://host.example/');
  });
});
