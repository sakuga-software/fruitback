import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0052_sites_visitor_rights` and `0053_sites_visitor_rights_default` (FRU-703) on a database that
 * holds sites already. No site changes what it does:
 *
 * - a visitor could edit and delete nothing before, so every site of before says `never`;
 * - a site that everyone read took a note from anybody, whatever `writers` said, and `writers` now
 *   decides on every site: such a site says `anyone`.
 *
 * A site made after takes the defaults of the mockup: `while-open`.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`what a visitor may do on a site, on ${label} (FRU-703)`, { skip: skip !== false }, () => {
    it('changes nothing a site of before does, and gives a site made after the defaults of the mockup', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0051_note_index_removed_at'));
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, writers, created_at) VALUES
           ('site_closed', 'ws_acme', 'https://closed.acme.dev', 'members', 'members', 1),
           ('site_contribute', 'ws_acme', 'https://contribute.acme.dev', 'members', 'anyone', 2),
           ('site_public_said_members', 'ws_acme', 'https://docs.acme.dev', 'everyone', 'members', 3),
           ('site_public', 'ws_acme', 'https://www.acme.dev', 'everyone', 'anyone', 4)`,
      ]) {
        await rowsOf(database, statement);
      }
      const store = createPostgresAccountStore(database);
      const before = await store.clientMap();

      await migrate(database);

      const rows = await rowsOf(
        database,
        'SELECT id, visibility, writers, visitor_edit, visitor_delete FROM sites ORDER BY created_at',
      );
      assert.deepEqual(
        rows.map((row) => [row.id, row.visibility, row.writers, row.visitor_edit, row.visitor_delete]),
        [
          ['site_closed', 'members', 'members', 'never', 'never'],
          ['site_contribute', 'members', 'anyone', 'never', 'never'],
          ['site_public_said_members', 'everyone', 'anyone', 'never', 'never'],
          ['site_public', 'everyone', 'anyone', 'never', 'never'],
        ],
      );
      // Who reads and who writes, as the routes read them: the same as before the migration.
      const after = await store.clientMap();
      for (const id of ['site_closed', 'site_contribute', 'site_public_said_members', 'site_public']) {
        assert.deepEqual([after[id]?.read, after[id]?.write], [before[id]?.read, before[id]?.write], id);
      }
      assert.equal(after.site_public_said_members?.write, 'public');
      // A visitor is given nothing to do to their own note: `never`, as before.
      assert.equal(after.site_contribute?.visitorEdit, 'never');
      assert.equal(after.site_contribute?.visitorDelete, 'never');

      // A row written with no value, as a statement of another tool would: the default of the mockup.
      await rowsOf(
        database,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_raw', 'ws_acme', 'https://raw.acme.dev', 'members', 5)`,
      );
      assert.deepEqual(
        (await rowsOf(database, `SELECT visitor_edit, visitor_delete FROM sites WHERE id = 'site_raw'`)).map((row) => [
          row.visitor_edit,
          row.visitor_delete,
        ]),
        [['while-open', 'while-open']],
      );
      const made = await store.addSite('ws_acme', { origin: 'https://new.acme.dev', visibility: 'everyone' });
      assert.deepEqual([made.writers, made.visitorEdit, made.visitorDelete], ['anyone', 'while-open', 'while-open']);
      // A site of before keeps `never` when it is added again with no right named.
      const again = await store.addSite('ws_acme', { origin: 'https://contribute.acme.dev', visibility: 'members' });
      assert.deepEqual([again.writers, again.visitorEdit, again.visitorDelete], ['anyone', 'never', 'never']);
    });
  });
}
