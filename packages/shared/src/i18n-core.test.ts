import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fillSentence, nearestLanguage } from './i18n-core.ts';

describe('the language of a tag (FRU-512)', () => {
  const languages = ['en', 'fr'] as const;

  it('reads the language of the tag, whatever its region and its case', () => {
    assert.equal(nearestLanguage('fr-CA', languages, 'en'), 'fr');
    assert.equal(nearestLanguage('FR', languages, 'en'), 'fr');
    assert.equal(nearestLanguage('en-GB', languages, 'en'), 'en');
  });

  it('reads the fallback for a language with no words, and for no tag', () => {
    for (const tag of ['ja', '', undefined, null])
      assert.equal(nearestLanguage(tag, languages, 'en'), 'en', String(tag));
  });
});

describe('a sentence with its values (FRU-512)', () => {
  it('fills every {name} it has a value for, each time it appears, and leaves the others', () => {
    assert.equal(fillSentence('{n} of {n}, by {who}', { n: 3 }), '3 of 3, by {who}');
    assert.equal(fillSentence('No value'), 'No value');
  });
});
