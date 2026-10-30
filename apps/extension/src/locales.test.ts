import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../wxt.config.ts';
import { MANIFEST_COMMANDS } from './shortcut.ts';

/**
 * The words of the manifest, in the language of the browser (FRU-555): `public/_locales`. Before,
 * the name, the description and the shortcut were in English only.
 */
type Messages = Record<string, { message: string; description?: string }>;
const read = (language: string): Messages =>
  JSON.parse(readFileSync(new URL(`../public/_locales/${language}/messages.json`, import.meta.url), 'utf8'));
const english = read('en');
const french = read('fr');

/** Each `__MSG_name__` the manifest uses. */
function used(): string[] {
  const manifest = config.manifest as { name?: string; description?: string; default_locale?: string };
  const fields = [
    manifest.name,
    manifest.description,
    ...Object.values(MANIFEST_COMMANDS).map((each) => each.description),
  ];

  return fields.flatMap((field) => [...String(field).matchAll(/__MSG_(\w+)__/g)].map((match) => match[1] as string));
}

describe('the words of the manifest (FRU-555)', () => {
  it('come from the locales, with English as the default', () => {
    const manifest = config.manifest as { default_locale?: string };

    assert.equal(manifest.default_locale, 'en');
    assert.deepEqual(used().sort(), ['extensionDescription', 'extensionName', 'leaveNoteCommand']);
  });

  it('are in English and in French, the same keys in both', () => {
    assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
    for (const key of used()) {
      assert.ok(english[key]?.message, `no English for ${key}`);
      assert.ok(french[key]?.message, `no French for ${key}`);
    }
  });

  it('say « note », in the words of the glossary', () => {
    assert.equal(english.leaveNoteCommand?.message, 'Leave a note on this page');
    assert.equal(french.leaveNoteCommand?.message, 'Laisser une note sur cette page');
    assert.doesNotMatch(english.extensionDescription?.message ?? '', /feedback/i);
    assert.doesNotMatch(
      Object.values(french)
        .map((each) => each.message)
        .join(' '),
      /'/,
    );
  });
});
