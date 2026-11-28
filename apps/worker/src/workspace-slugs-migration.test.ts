import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { RESERVED_SLUGS, readWorkspaceSlug, slugFromName } from './workspace-slug.ts';

/**
 * `0062_workspace_slugs` (FRU-715) on a database that holds workspaces already: each one gets the short
 * name read in its name, as `slugFromName` reads it for a new workspace, unique, and of the form that
 * `readWorkspaceSlug` takes. On PGlite and on a real PostgreSQL alike.
 */

const MIGRATION = readFileSync(new URL('../drizzle/0062_workspace_slugs.sql', import.meta.url), 'utf8');

const { opening } = databasesOfACase();

/** The 8 characters of the md5 of an id that the migration puts after a name it cannot give alone. */
const md5Of = (id: string): string => createHash('md5').update(id).digest('hex').slice(0, 8);

const WORKSPACES = [
  // [id, name, the instant it was made, its short name after the migration]
  ['ws_acme', 'Acme', '2026-10-01', 'acme'],
  ['ws_acme_again', 'ACME', '2026-10-02', `acme-${md5Of('ws_acme_again')}`],
  ['ws_cafe', 'Café Crème Studio', '2026-10-03', 'cafe-creme-studio'],
  ['ws_bob', 'Bob & co.', '2026-10-04', 'bob-co'],
  ['ws_admin', 'Admin', '2026-10-05', `admin-${md5Of('ws_admin')}`],
  ['ws_han', '工作室', '2026-10-06', `workspace-${md5Of('ws_han')}`],
  ['ws_long', `${'Long name '.repeat(6)}end`, '2026-10-07', 'long-name-long-name-long-name-long'],
  ['ws_ab', 'AB', '2026-10-08', `workspace-${md5Of('ws_ab')}`],
] as const;

for (const { label, open, skip } of DATABASES) {
  describe(`the short names of the workspaces of before, on ${label} (FRU-715)`, { skip: skip !== false }, () => {
    it('reads a short name in each name, unique, and the store answers it', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0061_deleted_notes_keep_days'));
      for (const [id, name, at] of WORKSPACES) {
        await rowsOf(
          database,
          `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('${id}', '${name}', '${id}', '${at}')`,
        );
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT id, slug FROM organization ORDER BY "createdAt"');
      assert.deepEqual(
        rows,
        WORKSPACES.map(([id, , , slug]) => ({ id, slug })),
      );
      for (const { slug } of rows) assert.deepEqual(readWorkspaceSlug(slug), { slug: String(slug) }, String(slug));
      // The names that a name alone gives are the ones `slugFromName` reads for a new workspace.
      for (const [, name, , slug] of WORKSPACES.filter(([id]) => ['ws_acme', 'ws_cafe', 'ws_bob'].includes(id))) {
        assert.equal(slugFromName(name), slug, name);
      }
      assert.equal(slugFromName(WORKSPACES[6][1]), 'long-name-long-name-long-name-long');
      // A store of this database finds them as it finds the slug of a new workspace, and no name of before.
      const accounts = createPostgresAccountStore(database);
      assert.equal(await accounts.slugTaken('cafe-creme-studio', Date.now()), true);
      assert.equal(await accounts.slugTaken('ws_cafe', Date.now()), false);
      assert.deepEqual(await rowsOf(database, 'SELECT slug FROM workspace_former_slugs'), []);
    });
  });
}

describe('the reserved words of the migration (FRU-715)', () => {
  it('are the ones of `RESERVED_SLUGS`', () => {
    const list = /ARRAY\[([^\]]+)\]/.exec(MIGRATION)?.[1] ?? '';
    const words = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    assert.deepEqual(words, [...RESERVED_SLUGS]);
    // The control: a word added to one list only is seen.
    assert.notDeepEqual([...words, 'pricing'], [...RESERVED_SLUGS]);
  });
});
