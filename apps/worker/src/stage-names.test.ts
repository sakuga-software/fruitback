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

const SEARCHED = ['apps/', 'packages/', 'e2e/'];
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.output', '.wxt', 'drizzle', 'coverage', 'test-results']);
const EXTENSIONS = /\.(ts|tsx|css|sql|html|mjs|js)$/;
const HISTORY = new Set([
  'apps/worker/src/stage-names.test.ts',
  'apps/worker/src/stage-names-migration.test.ts',
  'apps/worker/src/site-statuses-migration.test.ts',
]);

/** A colour named green, which is no stage: the photo of the preview, and a mark of Google. */
const COLOURS: Record<string, string[]> = {
  'apps/console/app/preview-scene.css': ["'green'"],
  'apps/console/app/preview-scene.tsx': ['"green"'],
  'apps/console/app/provider-icons.test.ts': ["'green'"],
};

/** An old name as a whole string, a message key (`stage.ripe`) or a token (`stage-ripe`). */
const OLD_NAME = /(['"`])(seeded|green|ripening|ripe|composted)\1|\bstage[.-](seeded|green|ripening|ripe|composted)\b/g;

function oldNamesIn(text: string): string[] {
  return [...text.matchAll(OLD_NAME)].map((match) => match[0]);
}

/** The files of the code under `folder`, as paths from the repository. */
function filesUnder(folder: string): string[] {
  const base = fileURLToPath(new URL(`../../../${folder}`, import.meta.url));
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : walk(join(directory, entry.name));

      return EXTENSIONS.test(entry.name) ? [join(directory, entry.name)] : [];
    });

  return walk(base).map((file) => `${folder}${relative(base, file)}`);
}

function textOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
}

describe('the old names of the stages (FRU-355)', () => {
  it('finds one in a string, a message key and a token, and not in prose', () => {
    assert.deepEqual(oldNamesIn(`stage === 'ripe'; t('stage.green'); var(--fruitback-stage-seeded)`), [
      "'ripe'",
      'stage.green',
      'stage-seeded',
    ]);
    assert.deepEqual(oldNamesIn('a note that ripens, on the green of the logo'), []);
  });

  it('are in no file of the code', () => {
    const files = SEARCHED.flatMap(filesUnder);
    assert.ok(files.length > 500, `read ${files.length} files: the walk found less code than there is`);

    const found = files
      .filter((file) => !HISTORY.has(file))
      .flatMap((file) => {
        const names = oldNamesIn(textOf(file));

        return (COLOURS[file] ?? []).join() === names.join() ? [] : names.map((name) => `${file}: ${name}`);
      });

    assert.deepEqual(found, []);
  });
});
