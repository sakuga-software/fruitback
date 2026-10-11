import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMigrations } from 'better-auth/db/migration';
import { sql } from 'drizzle-orm';
import { authId, type authOptions, startAuth } from './auth.ts';
import {
  DATABASES,
  EMPTY,
  MIGRATED,
  type Made,
  databasesOfACase,
  optionsOn,
  plantedAfterTheMigrations,
} from './auth.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The tables of better-auth, in the schema of the worker (FRU-144), migrated by Drizzle (FRU-180).
 * `auth.test.ts` holds what a worker does with better-auth off, and `auth-instance.test.ts` what an
 * instance does.
 *
 * **A control plants what a migration would have lost**, after the migrations of the worker: a column
 * dropped, a constraint without its cascade. better-auth reads the database, whatever made it, so the
 * finding is the same as for a migration that never made it. The tables are written in
 * `auth-schema.ts`, and `postgres-drift.test.ts` holds the migration to that file.
 *
 * Each case runs on PGlite, and on a real server when the run has one.
 */

const { opening, closing } = databasesOfACase();

/** What better-auth would do to the database to make it the one its options ask for. */
async function plan(
  database: PgDatabase,
  made: Made = MIGRATED,
  change: (options: Awaited<ReturnType<typeof authOptions>>) => Awaited<ReturnType<typeof authOptions>> = (same) =>
    same,
) {
  const { options, said } = await optionsOn(database, made);
  const found = await getMigrations(change(options), { throwOnUnsafe: false });

  return {
    create: found.toBeCreated.map((table) => table.table),
    add: found.toBeAdded.flatMap((table) => Object.keys(table.fields).map((field) => `${table.table}.${field}`)),
    indexes: found.toBeAddedIndexes.map((index) => index.name),
    unsafe: found.unsafeChanges,
    problems: found.schemaProblems,
    // A column of another type, and a required column that takes a null, are only said in the log.
    said: said.filter(({ level }) => level === 'warn' || level === 'error').map(({ message }) => message),
  };
}

const NOTHING = { create: [], add: [], indexes: [], unsafe: [], problems: [], said: [] };

/** The tables in the current schema with their columns, constraints and indexes, by name. */
async function shapeOf(database: PgDatabase, only?: readonly string[]) {
  const schema = String((await rowsOf(database, 'SELECT current_schema() AS name'))[0]?.name);
  const plain = (value: unknown): string => String(value).replaceAll(`${schema}.`, '');
  const kept = (table: unknown): boolean => only === undefined || only.includes(String(table));

  const columns = await rowsOf(
    database,
    sql`SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns WHERE table_schema = ${schema} ORDER BY table_name, column_name`,
  );
  const constraints = await rowsOf(
    database,
    sql`SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = ${schema} ORDER BY t.relname, c.conname`,
  );
  const indexes = await rowsOf(
    database,
    sql`SELECT tablename AS table_name, indexname AS name, indexdef AS definition
          FROM pg_indexes WHERE schemaname = ${schema} ORDER BY tablename, indexname`,
  );

  return {
    tables: [...new Set(columns.map((row) => String(row.table_name)))].filter(kept),
    columns: columns
      .filter((row) => kept(row.table_name))
      .map(
        (row) =>
          `${row.table_name}.${row.column_name} ${row.data_type} null:${row.is_nullable} default:${plain(row.column_default)}`,
      ),
    constraints: constraints
      .filter((row) => kept(row.table_name))
      .map((row) => `${row.table_name} ${row.name}: ${plain(row.definition)}`),
    indexes: indexes.filter((row) => kept(row.table_name)).map((row) => `${row.name}: ${plain(row.definition)}`),
  };
}

/** The one thing the schema of the worker has that the DDL of better-auth does not. */
const ADDED = 'member member_organizationId_userId_key: UNIQUE ("organizationId", "userId")';
const ADDED_INDEX =
  'member_organizationId_userId_key: CREATE UNIQUE INDEX "member_organizationId_userId_key" ON member USING btree ("organizationId", "userId")';

/**
 * How the tables of a database made as `made` says differ from the ones better-auth makes on an empty
 * database by its own migration: `-` is what better-auth has and the worker has not, `+` the reverse.
 *
 * `runMigrations` of better-auth never runs on a database of the worker. Here it makes the database
 * that the migration of the worker is compared with.
 */
async function drift(open: () => Promise<PgDatabase>, as: Made): Promise<string[]> {
  const theirs = await opening(open);
  const { options } = await optionsOn(theirs, EMPTY);
  await (await getMigrations(options)).runMigrations();
  const expected = await shapeOf(theirs);
  // One PGlite is one database, which a case empties: one database of a case at a time.
  await closing(theirs);

  const ours = await opening(open);
  await optionsOn(ours, as);
  const made = await shapeOf(ours, expected.tables);

  assert.deepEqual(expected.tables.toSorted(), [
    'account',
    'invitation',
    'member',
    'organization',
    'session',
    'user',
    'verification',
  ]);

  return (['columns', 'constraints', 'indexes'] as const).flatMap((kind) => {
    const word = { columns: 'column', constraints: 'constraint', indexes: 'index' }[kind];
    const all = [...new Set([...expected[kind], ...made[kind]])].toSorted();

    return all.flatMap((line) => {
      if (expected[kind].includes(line) === made[kind].includes(line)) return [];

      return [`${expected[kind].includes(line) ? '-' : '+'} ${word} ${line}`];
    });
  });
}

for (const { label, open, skip } of DATABASES) {
  describe(
    `the schema of better-auth, migrated by Drizzle with the worker, on ${label} (FRU-144, FRU-180)`,
    { skip },
    () => {
      it('leaves better-auth nothing to create and nothing to add after the migrations of the worker', async () => {
        assert.deepEqual(await plan(await opening(open)), NOTHING);
      });

      // The controls: each thing the test above says is there is taken out, and must be reported.
      it('reports a column that the migration lost', async () => {
        const lost = plantedAfterTheMigrations(
          'ALTER TABLE "session" DROP COLUMN "activeOrganizationId"',
          'ALTER TABLE "user" DROP COLUMN "image"',
        );

        assert.deepEqual(await plan(await opening(open), lost), {
          ...NOTHING,
          add: ['user.image', 'session.activeOrganizationId'],
        });
      });

      it('reports a table that the migration lost', async () => {
        const lost = plantedAfterTheMigrations('DROP TABLE "invitation"');

        assert.deepEqual(await plan(await opening(open), lost), { ...NOTHING, create: ['invitation'] });
      });

      it('says in its log a column of another type, and a required column that takes a null', async () => {
        const drifted = plantedAfterTheMigrations(
          'ALTER TABLE "user" ALTER COLUMN "emailVerified" TYPE text',
          'ALTER TABLE "organization" ALTER COLUMN "slug" DROP NOT NULL',
        );
        const found = await plan(await opening(open), drifted);

        assert.deepEqual({ ...found, said: [] }, NOTHING);
        assert.equal(found.said.length, 2, found.said.join('\n'));
        assert.match(found.said.join('\n'), /emailVerified.*different type/);
        assert.match(found.said.join('\n'), /"slug".*stays nullable/);
      });

      it('reports a required column that better-auth never fills', async () => {
        const more = plantedAfterTheMigrations('ALTER TABLE "user" ADD COLUMN "plan" text NOT NULL');
        const found = await plan(await opening(open), more);

        assert.deepEqual({ ...found, problems: [] }, NOTHING);
        assert.match(found.problems.join('\n'), /plan/);
      });

      it('reports the tables of a plugin that no migration makes', async () => {
        const { organization } = await import('better-auth/plugins/organization');
        const found = await plan(await opening(open), MIGRATED, (options) => ({
          ...options,
          plugins: [organization({ teams: { enabled: true } })],
        }));

        assert.deepEqual(found.create, ['team', 'teamMember']);
        assert.deepEqual(found.add, ['session.activeTeamId', 'invitation.teamId']);
      });

      it('makes the tables that the migration of better-auth itself makes, and one constraint more', async () => {
        assert.deepEqual(await drift(open, MIGRATED), [`+ constraint ${ADDED}`, `+ index ${ADDED_INDEX}`]);
      });

      // The controls of the test above. better-auth reports none of these three (measured): it reads
      // the names of the tables and of the columns, and an index of one column only when it makes the
      // table. So the comparison with its own migration is what holds them.
      it('finds an index, a cascade and a unique constraint that the migration lost', async () => {
        const lost = plantedAfterTheMigrations(
          'DROP INDEX "member_userId_idx"',
          `ALTER TABLE "invitation" DROP CONSTRAINT "invitation_inviterId_fkey",
           ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user" ("id")`,
          'ALTER TABLE "session" DROP CONSTRAINT "session_token_key"',
        );

        assert.deepEqual(
          await plan(await opening(open), lost),
          NOTHING,
          'better-auth now reports one of these: say so in worker.md',
        );
        assert.deepEqual(await drift(open, lost), [
          '+ constraint invitation invitation_inviterId_fkey: FOREIGN KEY ("inviterId") REFERENCES "user"(id)',
          '- constraint invitation invitation_inviterId_fkey: FOREIGN KEY ("inviterId") REFERENCES "user"(id) ON DELETE CASCADE',
          `+ constraint ${ADDED}`,
          '- constraint session session_token_key: UNIQUE (token)',
          `+ index ${ADDED_INDEX}`,
          '- index member_userId_idx: CREATE INDEX "member_userId_idx" ON member USING btree ("userId")',
          '- index session_token_key: CREATE UNIQUE INDEX session_token_key ON session USING btree (token)',
        ]);
      });

      // better-auth builds its context on a schema that is wrong, and rejects the first request
      // (measured). `startAuth` asks for that request before it says « ready ».
      it('refuses to call better-auth ready on a schema that lost a column, and names the column', async () => {
        const lost = plantedAfterTheMigrations('ALTER TABLE "session" DROP COLUMN "activeOrganizationId"');
        const { options } = await optionsOn(await opening(open), lost);

        await assert.rejects(startAuth(options), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /not the one better-auth expects \(missing-column session\.activeOrganizationId\)/,
          );
          assert.match(error.message, /never run `auth migrate` on this database/);
          // The advice of better-auth itself, which is the second migration tool the worker must not have.
          assert.doesNotMatch(error.message, /npx auth migrate/);

          return true;
        });
      });

      it('refuses a second row for one person in one workspace', async () => {
        const database = await opening(open);
        await optionsOn(database);
        await rowsOf(
          database,
          `INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ('acc_1', 'Alice', 'alice@acme.dev', true)`,
        );
        await rowsOf(
          database,
          `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('ws_1', 'Acme', 'acme', now())`,
        );
        await rowsOf(
          database,
          `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ('mem_1', 'ws_1', 'acc_1', 'guest', now())`,
        );

        const second = await rowsOf(
          database,
          sql`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
              VALUES (${'mem_2'}, ${'ws_1'}, ${'acc_1'}, ${'admin'}, now())`,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );

        assert.equal((second as { code?: string } | undefined)?.code, '23505', 'one person has two rows, so two roles');
      });

      it('gives every table of better-auth an id of the worker, and keeps acc_ and ws_', async () => {
        const { create: tables } = await plan(await opening(open), EMPTY);

        assert.equal(tables.length, 7);
        for (const table of tables) assert.match(authId(table), /^[a-z]{2,3}_[0-9a-f]{20}$/, table);
        assert.match(authId('user'), /^acc_/);
        assert.match(authId('organization'), /^ws_/);
        // The control: a table that has no prefix is refused, and is not given a default one.
        assert.throws(() => authId('team'), /« team ».*no prefix/);
      });
    },
  );
}
