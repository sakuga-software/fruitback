import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0021_sites_writers` and `0022_sites_writers_default` (FRU-330) on a database that holds sites
 * already. A site of before takes notes from anybody, as it did: « Anyone on the page ». A site made
 * after is « Members only », by the store and by the default of the column.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`who may leave a note on a site, on ${label} (FRU-330)`, { skip }, () => {
    it('gives « anyone » to every site of before, and « members » to a site made after', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0020_workspace_keeps_owner'));
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES
           ('site_members', 'ws_acme', 'https://acme.dev', 'members', 1),
           ('site_everyone', 'ws_acme', 'https://docs.acme.dev', 'everyone', 2)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const before = await rowsOf(database, 'SELECT id, writers FROM sites ORDER BY created_at');
      assert.deepEqual(
        before.map((row) => [row.id, row.writers]),
        [
          ['site_members', 'anyone'],
          ['site_everyone', 'anyone'],
        ],
      );
      // A row written with no value, as a statement of another tool would: the column closes it.
      await rowsOf(
        database,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_raw', 'ws_acme', 'https://raw.acme.dev', 'members', 3)`,
      );
      assert.equal((await rowsOf(database, `SELECT writers FROM sites WHERE id = 'site_raw'`))[0]?.writers, 'members');

      // The store reads them, and makes a new site « Members only » when nobody chose.
      const store = createPostgresAccountStore(database);
      const made = await store.addSite('ws_acme', { origin: 'https://new.acme.dev', visibility: 'members' });
      assert.equal(made.writers, 'members');
      const sites = await store.sites('ws_acme');
      assert.deepEqual(
        sites.map((site) => [site.id, site.writers]),
        [
          ['site_members', 'anyone'],
          ['site_everyone', 'anyone'],
          ['site_raw', 'members'],
          [made.id, 'members'],
        ],
      );
      // A site of before keeps what it had when it is added again with no `writers`.
      const again = await store.addSite('ws_acme', { origin: 'https://acme.dev', visibility: 'members' });
      assert.equal(again.writers, 'anyone');
    });
  });
}
