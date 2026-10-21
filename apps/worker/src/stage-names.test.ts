import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

/**
 * The old names of the five stages are gone from the code (FRU-355, docs/decisions/stage-names.md).
 * An old name in a string, a message key or a CSS token is a stage that nothing reads any more: a pin
 * with no colour, a filter that hides nothing. Prose and comments are not read; the migrations are
 * history, and the two tests of the migrations plant the old names on purpose.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SEARCHED = ['apps', 'packages', 'e2e'];
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.output', '.wxt', 'drizzle', 'coverage', 'test-results']);
const EXTENSIONS = /\.(ts|tsx|css|sql|html|mjs|js)$/;
const HISTORY = new Set([
  'apps/worker/src/stage-names.test.ts',
  'apps/worker/src/stage-names-migration.test.ts',
  'apps/worker/src/site-statuses-migration.test.ts',
]);

/**
 * An old name as a whole string, a message key (`stage.ripe`) or a token (`stage-ripe`). Not the
 * `data-tone="green"` of the preview of the console: the colour of a photo, not a stage.
 */
const OLD_NAME =
  /(?<!data-tone=)(['"`])(seeded|green|ripening|ripe|composted)\1|\bstage[.-](seeded|green|ripening|ripe|composted)\b/g;

function oldNamesIn(text: string): string[] {
  return [...text.matchAll(OLD_NAME)].map((match) => match[0]);
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : filesUnder(join(folder, entry.name));

    return EXTENSIONS.test(entry.name) ? [join(folder, entry.name)] : [];
  });
}

describe('the old names of the stages (FRU-355)', () => {
  it('finds one in a string, a message key and a token, and not in prose', () => {
    assert.deepEqual(oldNamesIn(`stage === 'ripe'; t('stage.green'); var(--fruitback-stage-seeded)`), [
      "'ripe'",
      'stage.green',
      'stage-seeded',
    ]);
    assert.deepEqual(oldNamesIn(`a note that ripens, on the green of the logo, data-tone="green"`), []);
  });

  it('are in no file of the code', () => {
    const files = SEARCHED.flatMap((folder) => filesUnder(join(ROOT, folder)));
    assert.ok(files.length > 500, `read ${files.length} files: the walk found less code than there is`);

    const found = files
      .map((file) => relative(ROOT, file))
      .filter((file) => !HISTORY.has(file))
      .flatMap((file) => oldNamesIn(readFileSync(join(ROOT, file), 'utf8')).map((name) => `${file}: ${name}`));

    assert.deepEqual(found, []);
  });
});
