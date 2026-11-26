import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSite } from './sites.ts';

/**
 * The name of the mode where the extension mounts the widget on a site that embeds nothing (FRU-662).
 *
 * It was « private mode ». That name does not say what the mode does, and it is the first path of a
 * person who finds Fruitback. It is now « Extension mode » in English and « mode extension » in
 * French. The team mode keeps its name.
 *
 * The words changed, and the stored value did not: a rule keeps `mode: 'private'`, so a rule saved
 * before the rename and a rules file written by an older version read as before.
 */
const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');

/** The text files under a folder of the repository, without dependencies or build output. */
function textFiles(folder: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(fileURLToPath(new URL(folder, ROOT)))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = `${folder}${name}`;
    if (statSync(fileURLToPath(new URL(path, ROOT))).isDirectory()) found.push(...textFiles(`${path}/`));
    else if (/\.(ts|tsx|md|html)$/.test(name)) found.push(path);
  }

  return found;
}

describe('the mode the extension mounts is « Extension mode » (FRU-662)', () => {
  const here = 'apps/extension/src/mode-name.test.ts';
  const files = [
    ...textFiles('apps/extension/src/'),
    ...textFiles('apps/extension/entrypoints/'),
    ...textFiles('apps/extension/store/'),
    ...textFiles('apps/console/app/'),
    ...textFiles('docs/'),
    'README.md',
    'SECURITY.md',
    'CLAUDE.md',
  ].filter((path) => path !== here);

  it('reads the files it checks', () => {
    // A wrong root would read no file and pass. These are the files that named the mode most.
    for (const path of ['docs/modes.md', 'docs/reviewing.md', 'apps/extension/src/messages.fr.ts']) {
      assert.ok(files.includes(path), `${path} is not read`);
    }
  });

  it('says the old name nowhere, in English or in French', () => {
    const old = [/\bprivate[ -]mode\b/i, /\bmode priv[ée]/i, /« Private »/, /\bPrivé\b/];
    const found = files.flatMap((path) =>
      read(path)
        .split('\n')
        .flatMap((line, index) =>
          old.some((pattern) => pattern.test(line)) ? [`${path}:${index + 1}: ${line.trim()}`] : [],
        ),
    );

    assert.deepEqual(found, []);
  });

  it('labels the stored value `private` as « Extension » in the popup and on the options page', () => {
    for (const path of [
      'apps/extension/entrypoints/popup/rule-screens.ts',
      'apps/extension/entrypoints/options/main.ts',
    ]) {
      assert.match(read(path), /\['private', 'Extension · the extension shows the widget'\]/, path);
    }
    assert.match(read('apps/extension/src/site-page.ts'), /\{ id: 'private', label: t\('Extension'\) \}/);
  });

  it('still reads a rule stored before the rename, and one with no mode, as extension mode', () => {
    const stored = { mode: 'private', clientId: 'acme', endpoint: 'https://feedback.acme.dev', enabled: true };

    assert.equal(parseSite(stored)?.mode, 'private');
    assert.equal(parseSite({ ...stored, mode: undefined })?.mode, 'private');
  });
});
