import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0062_sites_visitor_identity` (FRU-706) on a database that holds sites already. Every site of before
 * knows its visitors by their browser, as it did, and has no key: no route is given one.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`« How a visitor is recognised », on ${label} (FRU-706)`, { skip: skip !== false }, () => {
    it('knows the visitors of every site of before by their browser, with no key of the site', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0061_deleted_notes_keep_days'));
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, writers, created_at) VALUES
           ('site_closed', 'ws_acme', 'https://closed.acme.dev', 'members', 'members', 1),
           ('site_public', 'ws_acme', 'https://www.acme.dev', 'everyone', 'anyone', 2)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT id, visitor_identity, identity_key FROM sites ORDER BY created_at');
      assert.deepEqual(
        rows.map((row) => [row.id, row.visitor_identity, row.identity_key]),
        [
          ['site_closed', 'browser', null],
          ['site_public', 'browser', null],
        ],
      );
      const clients = await createPostgresAccountStore(database).clientMap();
      assert.equal(clients.site_public?.visitorIdentity, 'browser');
      assert.equal(clients.site_public?.sealedIdentityKey, undefined);
      // A site of its members only has no visitor to recognise.
      assert.equal(clients.site_closed?.visitorIdentity, undefined);
    });
  });
}
