import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import config from '../drizzle.config.ts';

/**
 * The schema and its migrations say the same thing (FRU-180).
 *
 * `postgres-schema.ts` and `auth-schema.ts` are what the stores and better-auth are written against,
 * and `drizzle/` is what a database gets. A column that is added to the first and not generated into
 * the second compiles, passes on no database, and is found in production. So `drizzle-kit generate`
 * runs here, on a copy of the folder, with the schema files that `drizzle.config.ts` names: it must
 * write nothing. It opens no database.
 */

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(WORKER, 'node_modules', 'drizzle-kit', 'bin.cjs');

const copies: string[] = [];

after(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/** A copy of the folder of the worker, for `drizzle-kit` to write in, in a folder of its own. */
function copyOfTheFolder(): string {
  const copy = mkdtempSync(join(tmpdir(), 'fruitback-drift-'));
  copies.push(copy);
  cpSync(join(WORKER, 'drizzle'), join(copy, 'drizzle'), { recursive: true });

  return join(copy, 'drizzle');
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
  // The configuration of the worker, with the copy as its folder. `--config` takes no other option.
  const copied = join(folder, '..', 'drizzle.config.json');
  // It puts `./` before the path of `out`: an absolute one is a folder that it does not find.
  writeFileSync(copied, JSON.stringify({ ...config, out: relative(WORKER, folder) }));
  const { stdout } = await run(process.execPath, [KIT, 'generate', '--config', copied, '--name', 'drift'], {
    cwd: WORKER,
    timeout: 60_000,
  });
  assert.match(
    stdout,
    /No schema changes, nothing to migrate|Your SQL migration file/,
    `drizzle-kit did not say that it compared the schema:\n${stdout}`,
  );

  return readdirSync(folder)
    .filter((file) => !before.has(file))
    .map((file) => readFileSync(join(folder, file), 'utf8'));
}

/** The last snapshot of `folder`: what `drizzle-kit` compares the schema with. */
function lastSnapshot(folder: string): string {
  const last = readdirSync(join(folder, 'meta'))
    .filter((file) => file.endsWith('_snapshot.json'))
    .sort()
    .at(-1);
  assert.ok(last !== undefined, 'the folder has no snapshot');

  return join(folder, 'meta', last);
}

describe('the schema of the database and its migrations (FRU-180)', () => {
  it('are the same: drizzle-kit generate writes nothing', async () => {
    assert.deepEqual(
      await generatedFor(copyOfTheFolder()),
      [],
      'a schema file changed and no migration was generated: run « pnpm --filter @fruitback/worker db:generate », and commit what it writes',
    );
  });

  it('reads the tables of better-auth too', () => {
    assert.deepEqual(config.schema, ['./src/postgres-schema.ts', './src/auth-schema.ts']);
  });

  // The control of the test above: a column of the schema that the last snapshot does not have.
  it('are told apart when a column of the schema has no migration', async () => {
    const folder = copyOfTheFolder();
    const path = lastSnapshot(folder);
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

  // The same control on a table of better-auth: the guard holds the whole schema, not the stores only.
  it('are told apart when a column of a table of better-auth has no migration', async () => {
    const folder = copyOfTheFolder();
    const path = lastSnapshot(folder);
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const columns = snapshot.tables['public.session']?.columns;
    assert.ok(
      columns !== undefined && 'activeOrganizationId' in columns,
      'the snapshot no longer holds session.activeOrganizationId',
    );
    delete columns.activeOrganizationId;
    writeFileSync(path, JSON.stringify(snapshot));

    const written = await generatedFor(folder);

    assert.equal(written.length, 1, 'drizzle-kit generated nothing for a column that the snapshot does not have');
    assert.match(written[0] ?? '', /ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text/);
  });
});
