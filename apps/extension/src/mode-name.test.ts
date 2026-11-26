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

/**
 * The old name, and the phrasings that used it as the name of a mode: « a private rule », « a
 * private site », a « Private » cell of a table. The stored value `private` in code, and « private »
 * in another sense (a private repository, a private network), are not the name of the mode.
 *
 * **A list, not a reading of the sentence.** These are the phrasings the tree held before FRU-662,
 * each found by a search of the repository. A new phrasing (« a private reviewer ») passes until it
 * is added here: « private » and « privé » alone are too common to forbid (« private ones first »,
 * « réseau privé »). Raised in review of #967.
 */
const OLD_NAMES = [
  /\bprivate[ -]mode\b/i,
  /\bmode priv[ée]/i,
  /« Private »/,
  /\bPrivé\b/,
  /\bPrivate ·/,
  /\bprivate (?:rule|site|mount|entry|wildcard)s?\b/i,
  /\|\s*Private\s*\|/,
];
/**
 * A browser's own private mode, which is not the mode of the extension: the browser named just
 * before it, or after it. Only that phrase is taken out of a line, so the old name beside it still
 * counts (review of #967).
 */
const BROWSER_PRIVATE =
  /\b(?:Safari|Firefox|Chrome|Chromium|Edge)\s+(?:in|en)\s+(?:private mode|mode privé)|\bprivate mode of (?:the|a) browser\b|\bmode privé du navigateur\b/gi;

/** Whether a line names the mode of the extension by its old name. */
function namesTheOldMode(line: string): boolean {
  const left = line.replace(BROWSER_PRIVATE, '');

  return OLD_NAMES.some((pattern) => pattern.test(left));
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
    const found = files.flatMap((path) =>
      read(path)
        .split('\n')
        .flatMap((line, index) => (namesTheOldMode(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    );

    assert.deepEqual(found, []);
  });

  it('tells the old name of the mode from the private window of a browser (review of #967)', () => {
    for (const line of [
      'A site that a reviewer opens in private mode takes no note.',
      'Le mode privé ne porte aucune session.',
      '| « Private » | « Team » |',
      "['private', 'Private · the extension shows the widget'],",
      // Kentō #0a56f0: the mode named by its old word, without « mode ».
      'Keeps the label of a private rule, and the mount of a private site.',
      '|  | Public | Private | Team |',
      // A browser named on the line does not hide the old name of the mode.
      'Private mode in the extension of the browser.',
      'Safari in private mode, and the private mode of the extension.',
      'Open it in a private window: private mode carries no session.',
    ]) {
      assert.ok(namesTheOldMode(line), line);
    }
    for (const line of [
      'Reading `localStorage` can throw in Safari in private mode.',
      'Open the page in the private mode of the browser.',
      'Firefox en mode privé refuse le stockage, comme le mode privé du navigateur.',
      'the private ranges of the network, a private repository, private ones first',
      "const clientId = site.mode === 'private' ? site.clientId : undefined;",
    ]) {
      assert.ok(!namesTheOldMode(line), line);
    }
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
