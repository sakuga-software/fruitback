import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0026_stage_names` (FRU-355) on a database full of the old stage names, made by the migrations of
 * before. Every stored stage takes its new name; what is no old name stays as it is; the file can
 * run twice; and the reverse UPDATE below gives the old names back, which is the rollback.
 */

const { opening } = databasesOfACase();

const OLD = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
const NEW = ['new', 'todo', 'progress', 'done', 'closed'] as const;

/** The rollback of `0026_stage_names`, to run before a worker of before FRU-355 starts again. */
const REVERSE_SQL = [
  ...['seeds', 'note_index', 'statuses'].map(
    (table) => `UPDATE "${table}" SET "stage" = CASE "stage"
        WHEN 'new' THEN 'seeded' WHEN 'todo' THEN 'green' WHEN 'progress' THEN 'ripening'
        WHEN 'done' THEN 'ripe' WHEN 'closed' THEN 'composted' END
      WHERE "stage" IN ('new', 'todo', 'progress', 'done', 'closed')`,
  ),
  `UPDATE "connectors" SET "settings" = jsonb_set("settings"::jsonb, '{stages}',
      (SELECT jsonb_object_agg(e."key", CASE e."value" #>> '{}'
                WHEN 'new' THEN to_jsonb('seeded'::text) WHEN 'todo' THEN to_jsonb('green'::text)
                WHEN 'progress' THEN to_jsonb('ripening'::text) WHEN 'done' THEN to_jsonb('ripe'::text)
                WHEN 'closed' THEN to_jsonb('composted'::text) ELSE e."value" END)
         FROM jsonb_each("settings"::jsonb -> 'stages') AS e("key", "value")))::text
    WHERE CASE WHEN pg_input_is_valid("settings", 'jsonb')
               THEN CASE WHEN jsonb_typeof("settings"::jsonb -> 'stages') = 'object'
                         THEN EXISTS (SELECT 1 FROM jsonb_each("settings"::jsonb -> 'stages') AS e("key", "value")
                                       WHERE jsonb_typeof(e."value") = 'string'
                                         AND e."value" #>> '{}' IN ('new', 'todo', 'progress', 'done', 'closed'))
                         ELSE false END
               ELSE false END`,
  `UPDATE "statuses" AS s SET "key" = CASE s."key"
        WHEN 'new' THEN 'seeded' WHEN 'todo' THEN 'green' WHEN 'progress' THEN 'ripening'
        WHEN 'done' THEN 'ripe' WHEN 'closed' THEN 'composted' END
      WHERE s."source" = 'own' AND s."key" IN ('new', 'todo', 'progress', 'done', 'closed')
        AND NOT EXISTS (SELECT 1 FROM "statuses" AS t WHERE t."site_id" = s."site_id" AND t."source" = 'own'
          AND t."key" = CASE s."key" WHEN 'new' THEN 'seeded' WHEN 'todo' THEN 'green' WHEN 'progress' THEN 'ripening'
            WHEN 'done' THEN 'ripe' WHEN 'closed' THEN 'composted' END)`,
  `UPDATE "seeds" SET "status_key" = CASE "status_key"
        WHEN 'new' THEN 'seeded' WHEN 'todo' THEN 'green' WHEN 'progress' THEN 'ripening'
        WHEN 'done' THEN 'ripe' WHEN 'closed' THEN 'composted' END
      WHERE "status_key" IN ('new', 'todo', 'progress', 'done', 'closed')
        AND NOT EXISTS (SELECT 1 FROM "statuses" AS t WHERE t."site_id" = "seeds"."client_id" AND t."source" = 'own'
          AND t."key" = "seeds"."status_key")`,
];

/** Every stage of before, a stage already new, and a value that is no stage. */
const SETTINGS = {
  con_old: JSON.stringify({
    showComments: false,
    stages: { st_a: 'seeded', st_b: 'green', st_c: 'ripening', st_d: 'ripe', st_e: 'composted' },
  }),
  con_mixed: JSON.stringify({ stages: { st_new: 'done', st_old: 'ripe', st_blue: 'blue', st_number: 5 } }),
  con_broken: 'not json at all',
  con_array: '{"stages":["ripe"]}',
  con_none: '{"showComments":true}',
};

const BEFORE = [
  `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
  `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES
     ('site_a', 'ws_acme', 'https://a.acme.dev', 'members', 1),
     ('site_b', 'ws_acme', 'https://b.acme.dev', 'members', 2)`,
  `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at, settings) VALUES ${Object.entries(
    SETTINGS,
  )
    .map(([id, settings], at) => `('${id}', 'ws_acme', 'linear', '${id}', 'sealed', ${at}, '${settings}')`)
    .join(', ')}`,
  `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES ${[...OLD, 'blue']
    .map((stage, at) => `('site_a', 'https://a.acme.dev/${stage}', '${stage}', '{}', ${at}, ${at})`)
    .join(', ')}`,
  `INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, author_kind, place, created_at, checked_at) VALUES ${[
    ...OLD,
    'blue',
  ]
    .map(
      (stage, at) =>
        `('site_a', 'sd_${stage}', 'ws_acme', 'https://a.acme.dev/', '${stage}', '${stage}', 'visitor', 'fruitback', ${at}, ${at})`,
    )
    .join(', ')}`,
  `INSERT INTO statuses (site_id, source, key, stage) VALUES ${OLD.map((stage) => `('site_a', 'con_old', 'st_${stage}', '${stage}')`).join(', ')}`,
  // The built-in statuses of the worker's own store are keyed by their stage (statuses.md). site_b
  // has a status of its team keyed `closed` already, so its built-in `composted` keeps its key.
  `INSERT INTO statuses (site_id, source, key, name, stage, origin) VALUES
     ('site_a', 'own', 'ripe', 'Shipped', 'ripe', 'tracker'),
     ('site_a', 'own', 'waiting', 'Waiting', 'green', 'team'),
     ('site_b', 'own', 'composted', NULL, 'composted', 'tracker'),
     ('site_b', 'own', 'closed', 'Closed by the client', 'composted', 'team')`,
  `INSERT INTO seeds (client_id, page_url, stage, status_key, seed, created_at, updated_at) VALUES
     ('site_a', 'https://a.acme.dev/shipped', 'ripe', 'ripe', '{}', 10, 10),
     ('site_a', 'https://a.acme.dev/waiting', 'green', 'waiting', '{}', 11, 11),
     ('site_b', 'https://b.acme.dev/kept', 'composted', 'composted', '{}', 12, 12),
     ('site_b', 'https://b.acme.dev/builtin', 'green', 'green', '{}', 13, 13)`,
];

async function stored(database: Awaited<ReturnType<typeof opening>>) {
  const column = async (sql: string) => (await rowsOf(database, sql)).map((row) => row.stage);
  const settings = await rowsOf(database, 'SELECT id, settings FROM connectors ORDER BY id');

  return {
    seeds: await column('SELECT stage FROM seeds WHERE created_at < 10 ORDER BY created_at'),
    own: (
      await rowsOf(database, `SELECT site_id, key, stage FROM statuses WHERE source = 'own' ORDER BY site_id, key`)
    ).map((row) => `${row.site_id} ${row.key} ${row.stage}`),
    keys: (await rowsOf(database, 'SELECT status_key FROM seeds WHERE created_at >= 10 ORDER BY created_at')).map(
      (row) => row.status_key,
    ),
    index: await column('SELECT stage FROM note_index ORDER BY created_at'),
    statuses: await column(`SELECT stage FROM statuses WHERE source <> 'own' ORDER BY key`),
    settings: Object.fromEntries(settings.map((row) => [row.id, row.settings])),
  };
}

const parsed = (settings: unknown) => JSON.parse(String(settings)) as unknown;

for (const { label, open, skip } of DATABASES) {
  describe(`the names of the stages, migrated, on ${label} (FRU-355)`, { skip: skip !== false }, () => {
    it('renames every stored stage, and leaves what is no old name', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0025_site_statuses'));
      for (const statement of BEFORE) await rowsOf(database, statement);

      await migrate(database);

      const after = await stored(database);
      assert.deepEqual(after.seeds, [...NEW, 'blue']);
      assert.deepEqual(after.index, [...NEW, 'blue']);
      // Ordered by key: st_composted, st_green, st_ripe, st_ripening, st_seeded.
      assert.deepEqual(after.statuses, ['closed', 'todo', 'done', 'progress', 'new']);
      assert.deepEqual(after.own, [
        'site_a done done',
        'site_a waiting todo',
        'site_b closed closed',
        'site_b composted closed',
      ]);
      // site_b kept its built-in `composted`, so its note keeps the key. `green` has no row: renamed.
      assert.deepEqual(after.keys, ['done', 'waiting', 'composted', 'todo']);
      assert.deepEqual(parsed(after.settings.con_old), {
        showComments: false,
        stages: { st_a: 'new', st_b: 'todo', st_c: 'progress', st_d: 'done', st_e: 'closed' },
      });
      assert.deepEqual(parsed(after.settings.con_mixed), {
        stages: { st_new: 'done', st_old: 'done', st_blue: 'blue', st_number: 5 },
      });
      assert.equal(after.settings.con_broken, SETTINGS.con_broken);
      assert.equal(after.settings.con_array, SETTINGS.con_array);
      assert.equal(after.settings.con_none, SETTINGS.con_none);
    });

    it('changes nothing when it runs a second time', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0025_site_statuses'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      await migrate(database);
      const once = await stored(database);

      const file = readFileSync(new URL('../drizzle/0026_stage_names.sql', import.meta.url), 'utf8');
      for (const statement of file.split('--> statement-breakpoint')) await rowsOf(database, statement);

      assert.deepEqual(await stored(database), once);
    });

    it('gives the old names back with REVERSE_SQL, the rollback', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0025_site_statuses'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      const before = await stored(database);
      await migrate(database);

      for (const statement of REVERSE_SQL) await rowsOf(database, statement);

      const back = await stored(database);
      assert.deepEqual(back.seeds, before.seeds);
      assert.deepEqual(back.index, before.index);
      assert.deepEqual(back.statuses, before.statuses);
      assert.deepEqual(back.own, before.own);
      assert.deepEqual(back.keys, before.keys);
      assert.deepEqual(parsed(back.settings.con_old), parsed(before.settings.con_old));
      // st_new was `done` before the migration, so the rollback makes it `ripe` like st_old: the one
      // value a round trip cannot tell apart, and harmless, since both name the same stage.
      assert.deepEqual(parsed(back.settings.con_mixed), {
        stages: { st_new: 'ripe', st_old: 'ripe', st_blue: 'blue', st_number: 5 },
      });
      assert.equal(back.settings.con_broken, SETTINGS.con_broken);
    });
  });
}
