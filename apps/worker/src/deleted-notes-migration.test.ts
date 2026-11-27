import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { DAY_MS } from './deleted-notes.ts';
import { createPostgresDeletedNotes } from './deleted-notes-postgres.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0061_deleted_notes_keep_days` (FRU-704) on a database that holds sites and deleted notes already.
 * Every site keeps a deleted note 30 days, the value of the mockup, those of before included; the
 * sweep then erases it, on PGlite and on a real PostgreSQL alike.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`« Deleted notes », on ${label} (FRU-704)`, { skip: skip !== false }, () => {
    it('keeps a deleted note of every site 30 days, then the sweep erases it', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0060_keep_note_versions'));
      const deletedAt = Date.now() - 10 * DAY_MS;
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, writers, created_at) VALUES
           ('site_public', 'ws_acme', 'https://www.acme.dev', 'everyone', 'anyone', 1)`,
        `INSERT INTO notes (id, client_id, page_url, stage, payload, created_at, updated_at)
           OVERRIDING SYSTEM VALUE VALUES (7, 'site_public', 'https://www.acme.dev/', 'closed', '{"id":"sd_1"}', 1, 1)`,
        `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, place, reference, created_at, checked_at, removed_at)
           VALUES ('site_public', 'sd_1', 'ws_acme', 'https://www.acme.dev/', 'A note.', 'closed', 'visitor', 'fruitback', 'FB-7', 1, 1, ${deletedAt})`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      assert.deepEqual(
        (await rowsOf(database, 'SELECT deleted_notes_keep_days FROM sites')).map((row) => row.deleted_notes_keep_days),
        [30],
      );
      assert.equal((await createPostgresAccountStore(database).sites('ws_acme'))[0]?.deletedNotesKeepDays, 30);
      const deleted = createPostgresDeletedNotes(database);
      assert.equal((await deleted.of('ws_acme', 'site_public', 'sd_1', Date.now()))?.until, deletedAt + 30 * DAY_MS);

      // Ten days on, it is kept; 31 days on, it goes, whole.
      assert.equal(await deleted.sweep(Date.now()), 0);
      assert.equal(await deleted.sweep(deletedAt + 31 * DAY_MS), 1);
      assert.deepEqual(await rowsOf(database, 'SELECT note_id FROM note_index'), []);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM notes'), []);
    });
  });
}
