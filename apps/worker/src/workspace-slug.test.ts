import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  MAX_SLUG,
  RESERVED_SLUGS,
  freeSlugFor,
  readWorkspaceSlug,
  slugFromName,
  slugSuffix,
} from './workspace-slug.ts';

/** The rule of the short name of a workspace (FRU-715), with no database. */

describe('the short name of a workspace (FRU-715)', () => {
  it('takes [a-z0-9-], 3 to 40 characters, a letter or a digit at each end, typed in any case', () => {
    for (const [typed, slug] of [
      ['acme', 'acme'],
      ['  Acme-Studio ', 'acme-studio'],
      ['a-1', 'a-1'],
      ['007', '007'],
      [`a${'b'.repeat(38)}c`, `a${'b'.repeat(38)}c`],
    ] as const) {
      assert.deepEqual(readWorkspaceSlug(typed), { slug }, typed);
    }
    for (const typed of [
      'ab',
      `a${'b'.repeat(39)}c`,
      '-acme',
      'acme-',
      'ac_me',
      'ws_0123',
      'ac me',
      'acmé',
      'ac.me',
      '',
    ]) {
      assert.deepEqual(readWorkspaceSlug(typed), { refused: 'invalid-slug' }, typed);
    }
    for (const value of [42, null, undefined, ['acme'], { slug: 'acme' }]) {
      assert.deepEqual(readWorkspaceSlug(value), { refused: 'invalid-slug' }, JSON.stringify(value));
    }
  });

  it('refuses the reserved words, which are all of the form a person can type', () => {
    for (const word of ['api', 'login', 'setup', 'admin', 'sign-in', 'WWW']) {
      assert.deepEqual(readWorkspaceSlug(word), { refused: 'reserved-slug' }, word);
    }
    // `w` is reserved, and too short anyway: every other word is refused for being reserved alone.
    const ofTheForm = [...RESERVED_SLUGS].filter((word) => word.length >= 3);
    assert.deepEqual(
      ofTheForm.map((word) => readWorkspaceSlug(word)),
      ofTheForm.map(() => ({ refused: 'reserved-slug' })),
    );
    assert.deepEqual(readWorkspaceSlug('w'), { refused: 'invalid-slug' });
  });

  it('is read in a name: no accent, one hyphen for the rest, 35 characters at most', () => {
    for (const [name, slug] of [
      ['Acme', 'acme'],
      ['Acme Studio', 'acme-studio'],
      ['Café Crème', 'cafe-creme'],
      ['  Bob & co. ', 'bob-co'],
      ['Ünïcödé 工作室 🍓', 'unicode'],
      ['A', 'workspace'],
      ['工作室', 'workspace'],
      ['---', 'workspace'],
      [`${'x'.repeat(34)} tail`, 'x'.repeat(34)],
    ] as const) {
      assert.equal(slugFromName(name), slug, name);
    }
  });

  it('gives a new workspace the name alone when it is free, else a suffix, never a reserved word', async () => {
    assert.equal(await freeSlugFor('Acme', async () => false), 'acme');
    const taken = new Set(['acme']);
    assert.match(await freeSlugFor('Acme', async (slug) => taken.has(slug)), /^acme-[a-z0-9]{4}$/);
    assert.match(await freeSlugFor('Admin', async () => false), /^admin-[a-z0-9]{4}$/);
    assert.match(await freeSlugFor('A', async () => false), /^workspace-[a-z0-9]{4}$/);
    // Every try taken: an unasked suffix of eight, still of the form, within 40 characters.
    const last = await freeSlugFor('x'.repeat(80), async () => true);
    assert.match(last, /^x{31}-[a-z0-9]{8}$/);
    assert.ok(last.length <= MAX_SLUG);
    assert.deepEqual(readWorkspaceSlug(last), { slug: last });
  });

  it('draws a suffix of letters and digits from the random bytes', () => {
    assert.equal(
      slugSuffix(4, () => Uint8Array.of(0, 25, 26, 35)),
      '-az09',
    );
    assert.equal(
      slugSuffix(4, () => Uint8Array.of(36, 255, 72, 0)),
      '-adaa',
    );
  });
});
