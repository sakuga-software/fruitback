import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0060_keep_note_versions` (FRU-704) on a database that holds sites and notes already. Every site keeps
 * every version, as the mockup draws it, those of before included: Fruitback has no users yet. The
 * routes are told it only where a visitor writes. A version goes with its note.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`« Keep every version », on ${label} (FRU-704)`, { skip: skip !== false }, () => {
    it('keeps every version of every site of before and after, and tells the routes only where a visitor writes', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0059_saved_views'));
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, writers, created_at) VALUES
           ('site_closed', 'ws_acme', 'https://closed.acme.dev', 'members', 'members', 1),
           ('site_public', 'ws_acme', 'https://www.acme.dev', 'everyone', 'anyone', 2)`,
        `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, place, created_at, checked_at)
           VALUES ('site_public', 'sd_1', 'ws_acme', 'https://www.acme.dev/', 'A note.', 'new', 'visitor', 'fruitback', 1, 1)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT id, keep_note_versions FROM sites ORDER BY created_at');
      assert.deepEqual(
        rows.map((row) => [row.id, row.keep_note_versions]),
        [
          ['site_closed', true],
          ['site_public', true],
        ],
      );
      const store = createPostgresAccountStore(database);
      const clients = await store.clientMap();
      assert.equal(clients.site_public?.keepNoteVersions, true);
      assert.equal(clients.site_closed?.keepNoteVersions, undefined);

      // A version of the note of before, which goes with the note.
      await rowsOf(
        database,
        `INSERT INTO note_versions (id, site_id, note_id, workspace_id, kind, text, author_kind, author_account_id, at)
           VALUES ('ver_1', 'site_public', 'sd_1', 'ws_acme', 'edit', 'Before.', 'visitor', NULL, 3)`,
      );
      await rowsOf(database, `DELETE FROM note_index WHERE note_id = 'sd_1'`);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM note_versions'), []);
    });
  });
}
