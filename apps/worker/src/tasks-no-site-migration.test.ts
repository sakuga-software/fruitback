import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0062_tasks_with_no_site` (FRU-672) on a database that holds notes already: the foreign key of the
 * index to `sites` moves to `site_ref`, which PostgreSQL computes. Every row stays, and still goes with
 * its site; a row with no site (`''`) is taken, and goes with its workspace.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the tasks with no site, on ${label} (FRU-672)`, { skip: skip !== false }, () => {
    it('keeps every row with its site, takes a row with none, and removes each with what it belongs to', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0061_deleted_notes_keep_days'));
      const row = (site: string, note: string, workspace = 'ws_acme') =>
        `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, place, created_at, checked_at) VALUES ('${site}', '${note}', '${workspace}', '', '${note}', 'new', 'member', 'fruitback', 1, 1)`;
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now()), ('ws_other', 'Other', 'ws_other', now())`,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_a', 'ws_acme', 'https://a.acme.dev', 'members', 1), ('site_b', 'ws_acme', 'https://b.acme.dev', 'members', 1)`,
        row('site_a', 'sd_a'),
        row('site_b', 'sd_b'),
      ]) {
        await rowsOf(database, statement);
      }
      // Before: a row needs a site.
      await assert.rejects(rowsOf(database, row('', 'task_before')), /note_index_site_id_fkey/);

      await migrate(database);

      assert.deepEqual(
        (await rowsOf(database, 'SELECT site_id, site_ref, note_id FROM note_index ORDER BY note_id')).map((one) => [
          one.site_id,
          one.site_ref,
          one.note_id,
        ]),
        [
          ['site_a', 'site_a', 'sd_a'],
          ['site_b', 'site_b', 'sd_b'],
        ],
      );
      await rowsOf(database, row('', 'task_acme'));
      await rowsOf(database, row('', 'task_other', 'ws_other'));
      const [own] = await rowsOf(database, `SELECT site_ref FROM note_index WHERE note_id = 'task_acme'`);
      assert.equal(own?.site_ref, null);
      // A site that is not one is still refused, and so is a row of no workspace.
      await assert.rejects(rowsOf(database, row('site_none', 'sd_none')), /note_index_site_ref_fkey/);
      await assert.rejects(rowsOf(database, row('', 'task_none', 'ws_none')), /note_index_workspace_id_fkey/);
      const notes = async () =>
        (await rowsOf(database, 'SELECT note_id FROM note_index ORDER BY note_id')).map((one) => one.note_id);

      await rowsOf(database, `DELETE FROM sites WHERE id = 'site_a'`);
      assert.deepEqual(await notes(), ['sd_b', 'task_acme', 'task_other']);
      await rowsOf(database, `DELETE FROM organization WHERE id = 'ws_acme'`);
      assert.deepEqual(await notes(), ['task_other']);
    });
  });
}
