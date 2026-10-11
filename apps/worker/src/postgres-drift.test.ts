import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The schema and its migrations say the same thing (FRU-180).
 *
 * `postgres-schema.ts` is what the stores are written against, and `drizzle/` is what a database
 * gets. A column that is added to the first and not generated into the second compiles, passes on
 * no database, and is found in production. So `drizzle-kit generate` runs here, on a copy of the
 * folder: it must write nothing. It opens no database.
 */

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(WORKER, 'node_modules', 'drizzle-kit', 'bin.cjs');

const copies: string[] = [];

after(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/** A copy of the folder of the worker, for `drizzle-kit` to write in. */
function copyOfTheFolder(): string {
  const copy = mkdtempSync(join(tmpdir(), 'fruitback-drift-'));
  copies.push(copy);
  cpSync(join(WORKER, 'drizzle'), copy, { recursive: true });

  return copy;
}

/**
 * The SQL that `drizzle-kit generate` writes for the schema of the worker, against this folder.
 * Empty: the schema is the one of the last snapshot.
 *
 * `drizzle-kit` asks a question when it cannot tell a column that was renamed from one that was
 * added, and nobody answers here: the limit of time ends it, and that is a failure of the test.
 *
 * **`drizzle-kit` ends with 0 when it fails** (measured on 0.31.11, with a folder it could not
 * open). So « it wrote nothing » is read with what it said: it must say that it compared.
 */
async function generatedFor(folder: string): Promise<string[]> {
  const before = new Set(readdirSync(folder));
  const { stdout } = await run(
    process.execPath,
    [
      KIT,
      'generate',
      '--dialect',
      'postgresql',
      '--schema',
      './src/postgres-schema.ts',
      '--out',
      // It puts `./` before this path: an absolute one is a folder that it does not find.
      relative(WORKER, folder),
      '--name',
      'drift',
    ],
    { cwd: WORKER, timeout: 60_000 },
  );
  assert.match(
    stdout,
    /No schema changes, nothing to migrate|Your SQL migration file/,
    `drizzle-kit did not say that it compared the schema:\n${stdout}`,
  );

  return readdirSync(folder)
    .filter((file) => !before.has(file))
    .map((file) => readFileSync(join(folder, file), 'utf8'));
}

describe('the schema of the database and its migrations (FRU-180)', () => {
  it('are the same: drizzle-kit generate writes nothing', async () => {
    assert.deepEqual(
      await generatedFor(copyOfTheFolder()),
      [],
      'postgres-schema.ts changed and no migration was generated: run « pnpm --filter @fruitback/worker db:generate », and commit what it writes',
    );
  });

  // The control of the test above: a column of the schema that the last snapshot does not have.
  it('are told apart when a column of the schema has no migration', async () => {
    const folder = copyOfTheFolder();
    const path = join(
      folder,
      'meta',
      readdirSync(join(folder, 'meta'))
        .filter((file) => file.endsWith('_snapshot.json'))
        .sort()
        .at(-1) ?? '',
    );
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const columns = snapshot.tables['public.accounts']?.columns;
    assert.ok(columns !== undefined && 'locale' in columns, 'the snapshot no longer holds accounts.locale');
    delete columns.locale;
    writeFileSync(path, JSON.stringify(snapshot));

    const written = await generatedFor(folder);

    assert.equal(written.length, 1, 'drizzle-kit generated nothing for a column that the snapshot does not have');
    assert.match(written[0] ?? '', /ALTER TABLE "accounts" ADD COLUMN "locale" text/);
  });
});
