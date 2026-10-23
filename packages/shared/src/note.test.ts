import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Note, NOTE_KIND, NOTE_VERSION, SEED_KIND, SEED_VERSION, canonicalizePageUrl, parseNote } from './note.ts';
import { minimalNoteFixture, noteFixture } from './note.fixture.ts';

describe('createNote', () => {
  it('stamps the current kind and version', () => {
    const note = noteFixture();

    assert.equal(note.kind, SEED_KIND);
    assert.equal(note.v, SEED_VERSION);
  });

  it('adds no field the caller did not provide', () => {
    // Schema defaults would silently break the write ↦ read round-trip.
    const note = minimalNoteFixture();

    assert.deepEqual(Object.keys(note).sort(), ['anchor', 'createdAt', 'id', 'kind', 'note', 'page', 'v', 'viewport']);
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
  it('accepts a note it produced', () => {
    const result = parseNote(JSON.parse(JSON.stringify(noteFixture())));

    assert.deepEqual(result, { ok: true, note: noteFixture() });
  });

  it('reports anything without our kind as not-found', () => {
    assert.deepEqual(parseNote({ hello: 'world' }), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNote(null), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNote('{}'), { ok: false, reason: 'not-found' });
  });

  it('refuses a payload from a newer Fruitback instead of dropping its fields', () => {
    const result = parseNote({ ...noteFixture(), v: SEED_VERSION + 1 });

    assert.deepEqual(result, { ok: false, reason: 'unsupported-version', version: SEED_VERSION + 1 });
  });

  it('reports a corrupted payload as invalid, naming the field', () => {
    const { anchor: _dropped, ...withoutAnchor } = noteFixture();
    const result = parseNote(withoutAnchor);

    if (result.ok || result.reason !== 'invalid') {
      throw new assert.AssertionError({ message: 'expected an invalid result', actual: result });
    }
    assert.ok(result.message.includes('anchor'), result.message);
  });

  it('still reads a note written at version 1', () => {
    // A note as a widget wrote it before FRU-9 moved the version to 2: no `reporter.verified`. Such
    // notes live in issues already in Linear, and readers accept older versions (CONTRIBUTING.md).
    const v1 = {
      kind: 'fruitback.seed',
      v: 1,
      id: 'sd_v1_7c41',
      createdAt: '2026-08-01T10:00:00.000Z',
      note: 'Le titre passe sous le menu.',
      page: { url: 'https://preview.acme.test/pricing', path: '/pricing', title: 'Pricing — Acme' },
      viewport: { width: 1440, height: 900, dpr: 2 },
      anchor: {
        selector: '[data-testid="hero-title"]',
        tag: 'h1',
        text: 'Pricing',
        bounds: { xPct: 10, yPct: 5, wPct: 80, hPct: 6 },
      },
      client: { id: 'acme' },
      reporter: { name: 'Alice', email: 'alice@acme.test' },
    };

    assert.deepEqual(parseNote(JSON.parse(JSON.stringify(v1))), { ok: true, note: v1 });
  });

  it('reports a version that is not a positive integer as malformed', () => {
    for (const v of [0, -1, 1.5, '2', null, Number.NaN]) {
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

/** A note as a writer of `NOTE_KIND` writes it: the same fields, its words in `text` (FRU-378). */
function version3(note: Note): Record<string, unknown> {
  const { kind: _kind, v: _v, note: text, ...rest } = note;

  return JSON.parse(JSON.stringify({ kind: NOTE_KIND, v: NOTE_VERSION, ...rest, text }));
}

describe('parseNote, the kind fruitback.note (FRU-378)', () => {
  it('names the kinds and the versions the issues hold', () => {
    assert.equal(SEED_KIND, 'fruitback.seed');
    assert.equal(SEED_VERSION, 2);
    assert.equal(NOTE_KIND, 'fruitback.note');
    assert.equal(NOTE_VERSION, 3);
  });

  it('reads a note of version 3 as the same note of version 2', () => {
    for (const note of [noteFixture(), minimalNoteFixture()]) {
      assert.deepEqual(parseNote(version3(note)), { ok: true, note });
    }
  });

  it('answers the fields in the order of version 2, so a note written again reads the same', () => {
    const result = parseNote(version3(noteFixture()));

    assert.ok(result.ok);
    assert.equal(JSON.stringify(result.note), JSON.stringify(noteFixture()));
  });

  it('keeps the words of the note, and no field called text', () => {
    const result = parseNote(version3(noteFixture({ note: 'Le bouton déborde.' })));

    assert.ok(result.ok);
    assert.equal(result.note.note, 'Le bouton déborde.');
    assert.equal('text' in result.note, false);
  });

  it('refuses a version 3 that holds its words in note rather than text', () => {
    const { text: _text, ...withoutText } = version3(noteFixture());

    assert.deepEqual(parseNote({ ...withoutText, note: 'Le bouton déborde.' }), {
      ok: false,
      reason: 'invalid',
      message: 'text: Invalid input: expected string, received undefined',
    });
  });

  it('refuses a version 3 whose text is longer than a note may be', () => {
    const result = parseNote({ ...version3(noteFixture()), text: 'x'.repeat(5_001) });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'invalid');
    assert.match(!result.ok && result.reason === 'invalid' ? result.message : '', /^text: /);
  });

  it('refuses a version of fruitback.note newer than it reads', () => {
    assert.deepEqual(parseNote({ ...version3(noteFixture()), v: NOTE_VERSION + 1 }), {
      ok: false,
      reason: 'unsupported-version',
      version: NOTE_VERSION + 1,
    });
  });

  it('refuses a fruitback.note of a version before 3, which no writer made', () => {
    for (const v of [1, 2]) {
      assert.deepEqual(parseNote({ ...version3(noteFixture()), v }), {
        ok: false,
        reason: 'invalid',
        message: 'v: fruitback.note starts at version 3',
      });
    }
  });

  it('reports a malformed version of fruitback.note as malformed', () => {
    assert.deepEqual(parseNote({ ...version3(noteFixture()), v: '3' }), {
      ok: false,
      reason: 'invalid',
      message: 'missing or malformed note version',
    });
  });

  it('reports a corrupted version 3 as invalid, naming the field', () => {
    const { anchor: _anchor, ...withoutAnchor } = version3(noteFixture());
    const result = parseNote(withoutAnchor);

    assert.equal(!result.ok && result.reason, 'invalid');
    assert.match(!result.ok && result.reason === 'invalid' ? result.message : '', /^anchor: /);
  });

  it('still refuses a fruitback.seed of version 3', () => {
    assert.deepEqual(parseNote({ ...noteFixture(), v: 3 }), { ok: false, reason: 'unsupported-version', version: 3 });
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
