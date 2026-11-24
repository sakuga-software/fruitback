import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0049_task_filters` (FRU-655) on a database whose tasks have fields already: the index takes the
 * fields of the row of `notes` it names `FB-<id>`, of the same site, and nothing for a note of a tracker.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the fields of a task in the index, on ${label} (FRU-655)`, { skip: skip !== false }, () => {
    it('fills the index of a task kept before, and leaves a note of a tracker empty', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0048_task_order_archive'));
      for (const statement of [
        `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('acc_bob', 'Bob', 'bob@acme.dev', true)`,
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_acme', 'ws_acme', 'https://acme.dev', 'members', 1)`,
        `INSERT INTO labels (id, workspace_id, name, color, created_at) VALUES ('lbl_b', 'ws_acme', 'B', '#000000', 1), ('lbl_a', 'ws_acme', 'A', '#000000', 1)`,
        `INSERT INTO notes (id, client_id, page_url, stage, payload, created_at, updated_at, assignee_account_id, priority, due_on)
           VALUES (7, 'site_acme', 'https://acme.dev/', 'new', '{"id":"sd_kept"}', 1, 1, 'acc_bob', 'high', '2026-12-01')`,
        `INSERT INTO note_labels (note_id, label_id) VALUES (7, 'lbl_b'), (7, 'lbl_a')`,
        `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, place, reference, created_at, checked_at) VALUES
           ('site_acme', 'sd_kept', 'ws_acme', 'https://acme.dev/', 'Kept', 'new', 'member', 'fruitback', 'FB-7', 1, 1),
           ('site_acme', 'sd_linear', 'ws_acme', 'https://acme.dev/', 'In Linear', 'new', 'member', 'connector', 'FB-7', 2, 2)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(
        database,
        'SELECT note_id, task_assignee_id, task_priority, task_due_on, task_label_ids FROM note_index ORDER BY created_at',
      );
      assert.deepEqual(
        rows.map((row) => [row.note_id, row.task_assignee_id, row.task_priority, row.task_due_on, row.task_label_ids]),
        [
          ['sd_kept', 'acc_bob', 'high', '2026-12-01', ['lbl_a', 'lbl_b']],
          ['sd_linear', null, null, null, null],
        ],
      );
    });
  });
}
