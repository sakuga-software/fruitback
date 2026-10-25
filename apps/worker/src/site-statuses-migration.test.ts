import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0025_site_statuses` (FRU-365) on a database that holds connectors and sites already, made from an
 * empty one. The stages that FRU-102 kept per Linear connector go to every site of that connector;
 * what `readConnectorSettings` would not keep goes nowhere; nothing of before changes. It stops at
 * `0025`: the data are of before FRU-355, and `0026_stage_names` renames them (its own test).
 */

const { opening } = databasesOfACase();

/** The settings of the Linear connector that the sites send to: two exceptions, and three that are not. */
const LINEAR_SETTINGS = JSON.stringify({
  showComments: false,
  stages: { st_review: 'ripening', st_wontfix: 'composted', 'not an id': 'ripe', st_blue: 'blue', st_number: 5 },
});

const BEFORE = [
  `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
  `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at, settings) VALUES
     ('con_linear', 'ws_acme', 'linear', 'Linear', 'sealed', 1, '${LINEAR_SETTINGS}'),
     ('con_broken', 'ws_acme', 'linear', 'Linear 2', 'sealed', 2, 'not json at all'),
     ('con_array', 'ws_acme', 'linear', 'Linear 3', 'sealed', 3, '{"stages":["ripe"]}'),
     ('con_empty', 'ws_acme', 'linear', 'Linear 4', 'sealed', 4, '{}'),
     ('con_alone', 'ws_acme', 'linear', 'Linear 5', 'sealed', 5, '{"stages":{"st_alone":"ripe"}}'),
     ('con_rest', 'ws_acme', 'rest', 'Hook', 'sealed', 6, '{"stages":{"st_rest":"ripe"}}'),
     ('con_github', 'ws_acme', 'github', 'GitHub', 'sealed', 7, '{"stages":{"st_github":"ripe"}}')`,
  `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES
     ('site_a', 'ws_acme', 'https://a.acme.dev', 'members', 1),
     ('site_b', 'ws_acme', 'https://b.acme.dev', 'members', 2),
     ('site_two_teams', 'ws_acme', 'https://c.acme.dev', 'members', 3),
     ('site_broken', 'ws_acme', 'https://d.acme.dev', 'members', 4),
     ('site_array', 'ws_acme', 'https://e.acme.dev', 'members', 5),
     ('site_empty', 'ws_acme', 'https://f.acme.dev', 'members', 6),
     ('site_rest', 'ws_acme', 'https://g.acme.dev', 'members', 7),
     ('site_own', 'ws_acme', 'https://h.acme.dev', 'members', 8),
     ('site_github', 'ws_acme', 'https://i.acme.dev', 'members', 9)`,
  `INSERT INTO site_destinations (site_id, position, connector_id, team_id) VALUES
     ('site_a', 0, 'con_linear', 'team_web'),
     ('site_b', 0, 'con_linear', 'team_web'),
     ('site_two_teams', 0, 'con_linear', 'team_web'),
     ('site_two_teams', 1, 'con_linear', 'team_design'),
     ('site_broken', 0, 'con_broken', 'team_web'),
     ('site_array', 0, 'con_array', 'team_web'),
     ('site_empty', 0, 'con_empty', 'team_web'),
     ('site_rest', 0, 'con_rest', NULL),
     ('site_github', 0, 'con_github', NULL)`,
  `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES
     ('site_own', 'https://h.acme.dev/', 'ripe', '{}', 1, 1)`,
];

for (const { label, open, skip } of DATABASES) {
  describe(`the statuses of a site, migrated, on ${label} (FRU-365)`, { skip: skip !== false }, () => {
    it('makes no status on a database with no connector', async () => {
      const database = await opening(open);
      await migrate(database);

      assert.deepEqual(await rowsOf(database, 'SELECT * FROM statuses'), []);
    });

    it('copies the stages of a Linear connector to every site that sends to it, and nothing else', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0024_github_installation'));
      for (const statement of BEFORE) await rowsOf(database, statement);

      await migrate(database, migrationsThrough('0025_site_statuses'));

      const copied = await rowsOf(
        database,
        `SELECT site_id, source, key, name, stage, color, text_color, position, origin, hidden
           FROM statuses ORDER BY site_id, key`,
      );
      const exception = (site: string, key: string, stage: string) => ({
        site_id: site,
        source: 'con_linear',
        key,
        name: null,
        stage,
        color: null,
        text_color: null,
        position: 0,
        origin: 'tracker',
        hidden: false,
      });
      assert.deepEqual(copied, [
        exception('site_a', 'st_review', 'ripening'),
        exception('site_a', 'st_wontfix', 'composted'),
        exception('site_b', 'st_review', 'ripening'),
        exception('site_b', 'st_wontfix', 'composted'),
        // Two destinations on one connector: one row per state, not two.
        exception('site_two_teams', 'st_review', 'ripening'),
        exception('site_two_teams', 'st_wontfix', 'composted'),
      ]);

      // The JSON stays, word for word: a worker of before reads what it wrote.
      const settings = await rowsOf(
        database,
        `SELECT id, settings FROM connectors WHERE id IN ('con_linear', 'con_broken') ORDER BY id`,
      );
      assert.deepEqual(
        settings.map((row) => [row.id, row.settings]),
        [
          ['con_broken', 'not json at all'],
          ['con_linear', LINEAR_SETTINGS],
        ],
      );

      // A note of before has no status: it is drawn by its stage.
      const notes = await rowsOf(database, 'SELECT stage, status_key FROM seeds');
      assert.deepEqual(notes, [{ stage: 'ripe', status_key: null }]);

      // The statuses of a site go with it.
      await rowsOf(database, `DELETE FROM sites WHERE id = 'site_a'`);
      const left = await rowsOf(database, 'SELECT DISTINCT site_id FROM statuses ORDER BY site_id');
      assert.deepEqual(
        left.map((row) => row.site_id),
        ['site_b', 'site_two_teams'],
      );
    });

    it('refuses a status of a site that does not exist, and a second row for one state', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0024_github_installation'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      await migrate(database);

      await assert.rejects(
        rowsOf(
          database,
          `INSERT INTO statuses (site_id, source, key, stage) VALUES ('site_gone', 'own', 'seeded', 'seeded')`,
        ),
      );
      await assert.rejects(
        rowsOf(
          database,
          `INSERT INTO statuses (site_id, source, key, stage) VALUES ('site_a', 'con_linear', 'st_review', 'ripe')`,
        ),
      );
      await rowsOf(
        database,
        `INSERT INTO statuses (site_id, source, key, stage) VALUES ('site_a', 'own', 'st_review', 'ripe')`,
      );
    });
  });
}
