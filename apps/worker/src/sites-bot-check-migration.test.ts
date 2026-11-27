import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0062_sites_bot_check` (FRU-704) on a database that holds sites already. Every site asks for the bot
 * check, as the mockup draws it, those of before included: Fruitback has no users yet. The routes are
 * told it only where a visitor writes.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`« Bot check », on ${label} (FRU-704)`, { skip: skip !== false }, () => {
    it('asks for the bot check on every site of before and after, and tells the routes only where a visitor writes', async () => {
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

      const rows = await rowsOf(database, 'SELECT id, bot_check FROM sites ORDER BY created_at');
      assert.deepEqual(
        rows.map((row) => [row.id, row.bot_check]),
        [
          ['site_closed', true],
          ['site_public', true],
        ],
      );
      const store = createPostgresAccountStore(database);
      const clients = await store.clientMap();
      assert.equal(clients.site_public?.botCheck, true);
      assert.equal(clients.site_closed?.botCheck, undefined);
      // A site made after it asks for it too, and a site that turns it off keeps it off.
      const made = await store.addSite('ws_acme', { origin: 'https://new.acme.dev', visibility: 'everyone' });
      assert.equal(made.botCheck, true);
      await store.addSite('ws_acme', { origin: 'https://www.acme.dev', visibility: 'everyone', botCheck: false });
      assert.equal((await store.clientMap()).site_public?.botCheck, undefined);
    });
  });
}
