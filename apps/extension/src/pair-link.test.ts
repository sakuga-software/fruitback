import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAIR_PATH, parsePairLink } from './pair-link.ts';

const CODE = '2YWQ-XBWK-6KH1';

describe('a pairing link, read from the address of the tab (FRU-92)', () => {
  it('reads the worker from where the page is, and the code from after the #', () => {
    assert.deepEqual(parsePairLink(`https://feedback.acme.dev/pair#${CODE}`), {
      endpoint: 'https://feedback.acme.dev',
      code: CODE,
    });
  });

  it('keeps the path a worker is served under, because the rules name the endpoint with it', () => {
    assert.deepEqual(parsePairLink(`https://example.com/fruitback/pair#${CODE}`), {
      endpoint: 'https://example.com/fruitback',
      code: CODE,
    });
    assert.equal(parsePairLink(`http://localhost:8789/pair#${CODE}`)?.endpoint, 'http://localhost:8789');
  });

  it('ignores a query, and never takes the worker from it', () => {
    const link = parsePairLink(`https://evil.example/pair?endpoint=https://feedback.acme.dev#${CODE}`);

    assert.equal(link?.endpoint, 'https://evil.example');
  });

  it('is not a link on any other page, with any other fragment', () => {
    for (const url of [
      undefined,
      '',
      'not a url',
      'chrome://extensions/',
      `https://acme.dev/pairing#${CODE}`,
      `https://acme.dev/pair/more#${CODE}`,
      `https://acme.dev/#${CODE}`,
      'https://acme.dev/pair',
      'https://acme.dev/pair#',
      'https://acme.dev/pair#section-2',
      'https://acme.dev/pair#2ywq-xbwk-6kh1',
      'https://acme.dev/pair#2YWQ',
      `https://acme.dev/pair#${CODE}&endpoint=https://other.dev`,
      `https://user:secret@acme.dev/pair#${CODE}`,
      `ftp://acme.dev/pair#${CODE}`,
    ]) {
      assert.equal(parsePairLink(url), undefined, String(url));
    }
  });

  it('reads a link on plain http too: the popup says why it will not pair there', () => {
    // Refusing here would show the form to switch the site on, with nothing about the link.
    assert.equal(parsePairLink(`http://feedback.acme.dev/pair#${CODE}`)?.endpoint, 'http://feedback.acme.dev');
  });
});

describe('the link the worker prints is the link the popup reads', () => {
  const read = (url: URL): string => readFileSync(fileURLToPath(url), 'utf8');

  it('uses the path the worker serves', () => {
    const page = read(new URL('../../worker/src/pair-page.ts', import.meta.url));
    const served = /export const PAIR_PATH = '([^']+)';/.exec(page)?.[1];

    assert.equal(served, PAIR_PATH);
  });

  it('reads every code the worker can write', () => {
    const source = read(new URL('../../worker/src/session.ts', import.meta.url));
    const alphabet = /const CODE_ALPHABET = '([^']+)';/.exec(source)?.[1] ?? '';

    assert.ok(alphabet.length >= 16, 'the alphabet of the worker was not found: this check reads nothing');
    // One code of each character, in the worker's groups of four.
    for (const character of alphabet) {
      const code = [character.repeat(4), character.repeat(4), character.repeat(4)].join('-');
      assert.equal(parsePairLink(`https://w.test/pair#${code}`)?.code, code, `refused a code made of ${character}`);
    }
  });
});
