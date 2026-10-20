import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0019_note_index_confirmed` (FRU-295) on a database that holds notes already: it only adds a column
 * that may be empty, so every row stays. A done note of before is no fix to check until a read of its
 * page says that a verdict can be given there.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the column of the verdict of a note, on ${label} (FRU-295)`, { skip }, () => {
    it('keeps every row of the index, and counts no note of before until a read says a verdict can be given', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0018_workspace_suspensions'));
      for (const statement of [
        `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('acc_bob', 'Bob', 'bob@acme.dev', true)`,
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_acme', 'ws_acme', 'https://acme.dev', 'members', 1)`,
        `INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, author_kind, author_account_id, place, created_at, checked_at) VALUES
           ('site_acme', 'sd_done', 'ws_acme', 'https://acme.dev/', 'Done', 'ripe', 'member', 'acc_bob', 'fruitback', 1, 1),
           ('site_acme', 'sd_open', 'ws_acme', 'https://acme.dev/', 'Open', 'green', 'member', 'acc_bob', 'fruitback', 2, 2),
           ('site_acme', 'sd_visitor', 'ws_acme', 'https://acme.dev/', 'Visitor', 'ripe', 'visitor', NULL, 'fruitback', 3, 3)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT seed_id, confirmed FROM note_index ORDER BY created_at');
      assert.deepEqual(
        rows.map((row) => [row.seed_id, row.confirmed]),
        [
          ['sd_done', null],
          ['sd_open', null],
          ['sd_visitor', null],
        ],
      );
      const index = createPostgresNoteIndex(database);
      assert.deepEqual(await index.toCheck('ws_acme', 'acc_bob'), new Map());

      // A read of the page, where a verdict can be given, sees no verdict in the replies of the note.
      const done = seedFixture({ id: 'sd_done', page: { url: 'https://acme.dev/', path: '/', title: 'Home' } });
      await index.refresh(
        'ws_acme',
        'site_acme',
        { kind: 'fruitback' },
        [
          {
            id: '1',
            identifier: 'FB-1',
            title: 'Done',
            stage: 'ripe',
            stateName: '',
            updatedAt: '',
            comments: [],
            seed: done,
          },
        ],
        Date.now(),
        { verdicts: true },
      );
      assert.deepEqual(await index.toCheck('ws_acme', 'acc_bob'), new Map([['site_acme', 1]]));
    });
  });
}
