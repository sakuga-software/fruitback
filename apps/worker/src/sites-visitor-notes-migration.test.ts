import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0056_sites_visitor_notes_per_hour` (FRU-704) on a database that holds sites already. Every site
 * takes 10 notes of a visitor an hour, the value of the mockup, those of before included: Fruitback
 * has no users yet. The routes are told it only where a visitor writes.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the notes of a visitor in an hour, on ${label} (FRU-704)`, { skip: skip !== false }, () => {
    it('gives every site of before and after 10 an hour, and tells the routes only where a visitor writes', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0055_sites_seen'));
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, writers, created_at) VALUES
           ('site_closed', 'ws_acme', 'https://closed.acme.dev', 'members', 'members', 1),
           ('site_public', 'ws_acme', 'https://www.acme.dev', 'everyone', 'anyone', 2)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT id, visitor_notes_per_hour FROM sites ORDER BY created_at');
      assert.deepEqual(
        rows.map((row) => [row.id, row.visitor_notes_per_hour]),
        [
          ['site_closed', 10],
          ['site_public', 10],
        ],
      );
      const store = createPostgresAccountStore(database);
      const clients = await store.clientMap();
      assert.equal(clients.site_public?.visitorNotesPerHour, 10);
      assert.equal(clients.site_closed?.visitorNotesPerHour, undefined);

      // A row that holds a value out of the list counts as the default, never as « No limit ».
      await rowsOf(database, `UPDATE sites SET visitor_notes_per_hour = 7 WHERE id = 'site_public'`);
      assert.equal((await store.clientMap()).site_public?.visitorNotesPerHour, 10);

      const made = await store.addSite('ws_acme', { origin: 'https://new.acme.dev', visibility: 'everyone' });
      assert.equal(made.visitorNotesPerHour, 10);
    });
  });
}
