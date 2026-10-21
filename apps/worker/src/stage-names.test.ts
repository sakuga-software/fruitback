import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

/**
 * The old names of the five stages are gone from the code (FRU-355, docs/decisions/stage-names.md).
 * An old name in a string, a message key or a CSS token is a stage that nothing reads any more: a pin
 * with no colour, a filter that hides nothing. Prose and comments are not read; the migrations are
 * history, and the two tests of the migrations plant the old names on purpose.
 *
 * The files are the ones git lists, tracked or new, never one it ignores. A mutation run of StrykerJS
 * keeps copies of the sources in `.stryker-tmp/backup-*` (`inPlace`), which a walk of the folders read
 * as code; the copies of the two tests of the migrations then failed its dry run (FRU-355).
 */

const SEARCHED = ['apps/', 'packages/', 'e2e/'];
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

/**
 * The files of the code that git lists under the searched folders, tracked or new, as paths from the
 * repository. What git ignores is not code: `node_modules`, a build, `.stryker-tmp`, `reports`. The
 * migrations are history: a migration that ran is never edited.
 */
function codeFiles(): string[] {
  const listed = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      ...SEARCHED.map((folder) => `:(top)${folder}`),
    ],
    { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  return [...new Set(listed.split('\0'))].filter(
    (file) =>
      EXTENSIONS.test(file) &&
      !file.split('/').includes('drizzle') &&
      existsSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url))),
  );
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
    const files = codeFiles();
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
