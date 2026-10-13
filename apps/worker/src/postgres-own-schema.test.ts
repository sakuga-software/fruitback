import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { canonicalizePageUrl } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { databasesOfACase } from './auth.fixture.ts';
import { envWith, workerOf } from './auth-worker.fixture.ts';
import type { ClientPolicy } from './clients.ts';
import { DATABASE_SCHEMA_REFUSED, readConfig } from './env.ts';
import {
  type Database,
  type PgDatabase,
  WORDS_POSTGRESQL_QUOTES,
  createPgDatabase,
  readDatabaseSchema,
} from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  TEST_DATABASE_URL,
  createPgliteDatabase,
  createRealDatabase,
  ownDatabase,
  rowsOf,
} from './postgres.fixture.ts';
import { APPLIED, inSchema, migrate, migrationsFolder } from './postgres-migrate.ts';
import { createPostgresSeedStore } from './seeds-postgres.ts';
import { StoreError } from './store.ts';

/**
 * A worker in a schema of its own, in a database that another application uses too (FRU-219):
 * `FRUITBACK_DATABASE_SCHEMA`. Its tables and its journal of migrations are in that schema, and it
 * writes nowhere else.
 */

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' };
const SCHEMA = 'fruitback';
const { opening } = databasesOfACase();

/** Every table of a schema, with its number of rows and a digest of them, and every index and constraint. */
async function whatIsIn(database: Database, schema: string): Promise<string[]> {
  const tables = (
    await rowsOf(database, `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY tablename`)
  ).map((row) => String(row.tablename));
  const lines: string[] = [];
  for (const table of tables) {
    const [row] = await rowsOf(
      database,
      `SELECT count(*)::int AS rows, coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '-') AS digest FROM "${schema}"."${table}" t`,
    );
    lines.push(`table ${table}: ${String(row?.rows)} rows, ${String(row?.digest)}`);
  }
  const columns = await rowsOf(
    database,
    `SELECT table_name || '.' || column_name || ' ' || data_type AS line FROM information_schema.columns WHERE table_schema = '${schema}' ORDER BY 1`,
  );
  const indexes = await rowsOf(
    database,
    `SELECT indexdef AS line FROM pg_indexes WHERE schemaname = '${schema}' ORDER BY 1`,
  );

  return [...lines, ...[...columns, ...indexes].map((row) => String(row.line))];
}

/** The tables of a schema, by name. */
async function tablesOf(database: Database, schema: string): Promise<string[]> {
  return (
    await rowsOf(database, `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY tablename`)
  ).map((row) => String(row.tablename));
}

/** What another application keeps in `public`: tables with the names of better-auth, and rows. */
async function anotherApplicationIn(database: Database): Promise<void> {
  for (const statement of [
    `CREATE TABLE public."user" (id integer PRIMARY KEY, login text NOT NULL UNIQUE)`,
    `CREATE TABLE public."session" (sid text PRIMARY KEY, user_id integer NOT NULL REFERENCES public."user" (id), data text)`,
    `CREATE TABLE public.sites (id integer PRIMARY KEY, hostname text)`,
    `INSERT INTO public."user" (id, login) VALUES (1, 'ada'), (2, 'grace')`,
    `INSERT INTO public."session" (sid, user_id, data) VALUES ('s1', 1, '{"cart":3}')`,
    `INSERT INTO public.sites (id, hostname) VALUES (1, 'shop.example')`,
  ]) {
    await rowsOf(database, statement);
  }
}

for (const { label, open, skip } of [
  { label: 'PGlite', open: () => createPgliteDatabase(SCHEMA), skip: false as string | false },
  { label: 'a real server', open: () => createRealDatabase(SCHEMA), skip: NO_REAL_POSTGRES },
]) {
  describe(`a worker in a schema of its own, on ${label} (FRU-219)`, { skip }, () => {
    it('signs a person in and keeps a note, in its schema, and changes no table and no row of public', async () => {
      const database = await opening(open);
      await anotherApplicationIn(database);
      const before = await whatIsIn(database, 'public');
      assert.equal(before.filter((line) => line.startsWith('table ')).length, 3);

      // A worker starts: its migrations, better-auth on its pool, a sign-in by a link, and a note.
      const worker = await workerOf(database);
      const cookie = await worker.signIn('alice@acme.dev');
      const me = await worker.call('/console/me', { headers: { Cookie: cookie } });
      assert.equal(me.status, 200, await me.clone().text());
      const page = canonicalizePageUrl('https://staging.acme.dev/pricing');
      const seed = seedFixture({ id: 'sd_1', page: { url: page, path: '/pricing', title: 'Pricing' } });
      const store = createPostgresSeedStore(database);
      await store.create({ ...seed, client: { id: 'site_1', name: 'Acme' } }, undefined, POLICY);
      assert.equal((await store.findForPage({ url: page, clientId: 'site_1' }, undefined, POLICY)).length, 1);

      // Its tables, the ones of better-auth among them, and its journal are in its schema.
      const mine = await tablesOf(database, SCHEMA);
      for (const table of ['user', 'session', 'account', 'organization', 'sites', 'seeds', APPLIED.migrationsTable]) {
        assert.ok(mine.includes(table), `no table ${SCHEMA}.${table}`);
      }
      assert.deepEqual(await rowsOf(database, `SELECT email FROM "${SCHEMA}"."user"`), [{ email: 'alice@acme.dev' }]);
      // Nothing of public changed: the same tables, the same rows, the same columns and indexes.
      assert.deepEqual(await whatIsIn(database, 'public'), before);
    });

    it('writes in its journal the digest of each migration as its file is written', async () => {
      const database = await opening(open);
      await migrate(database);

      const journal = await rowsOf(
        database,
        `SELECT hash, created_at FROM "${SCHEMA}"."${APPLIED.migrationsTable}" ORDER BY created_at`,
      );
      const { readMigrationFiles } = await import('drizzle-orm/migrator');
      const files = readMigrationFiles({ migrationsFolder: migrationsFolder() });

      assert.deepEqual(
        journal.map((row) => [row.hash, Number(row.created_at)]),
        files.map((file) => [file.hash, file.folderMillis]),
      );
      // A second start applies nothing, and refuses nothing.
      await migrate(database);
      assert.equal(
        (await rowsOf(database, `SELECT 1 FROM "${SCHEMA}"."${APPLIED.migrationsTable}"`)).length,
        files.length,
      );
    });

    it('keeps each foreign key in its schema: a row of public cannot stand for one of its own', async () => {
      const database = await opening(open);
      await rowsOf(database, `CREATE TABLE public.organization (id text PRIMARY KEY)`);
      await rowsOf(database, `INSERT INTO public.organization (id) VALUES ('ws_of_another_application')`);
      await migrate(database);

      const keys = await rowsOf(
        database,
        `SELECT DISTINCT n.nspname AS referenced FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_namespace own ON own.oid = c.connamespace
          WHERE c.contype = 'f' AND own.nspname = '${SCHEMA}'`,
      );
      assert.deepEqual(keys, [{ referenced: SCHEMA }]);
      // A site of a workspace that only public knows is refused.
      await assert.rejects(
        rowsOf(
          database,
          `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_1', 'ws_of_another_application', 'https://a.test', 'everyone', 1)`,
        ),
        /sites_workspace_id_fkey/,
      );
    });
  });
}

describe('a database of today, with no schema named (FRU-219)', () => {
  for (const { label, open, skip } of [
    { label: 'PGlite', open: () => createPgliteDatabase(), skip: false as string | false },
    { label: 'a real server', open: () => createRealDatabase(), skip: NO_REAL_POSTGRES },
  ]) {
    it(`starts with nothing run again, when Drizzle itself made it in public, on ${label}`, { skip }, async () => {
      const database = await opening(open);
      // As every image did until this one: `migrate` of Drizzle, in `public`.
      await database.alone((_, apply) => apply({ migrationsFolder: migrationsFolder(), ...APPLIED }));
      const accounts = createPostgresAccountStore(database);
      await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
      const journal = () =>
        rowsOf(database, `SELECT id, hash, created_at FROM public."${APPLIED.migrationsTable}" ORDER BY id`);
      const before = { journal: await journal(), tables: await whatIsIn(database, 'public') };
      assert.ok(before.journal.length >= 6);

      await migrate(database);

      assert.deepEqual({ journal: await journal(), tables: await whatIsIn(database, 'public') }, before);
      assert.equal(database.schema, 'public');
    });
  }
});

describe('two workers in two schemas of one database (FRU-219)', { skip: NO_REAL_POSTGRES }, () => {
  /** One database, a pool in `tenant_a` and one in `tenant_b`. */
  async function twoWorkers(use: (a: PgDatabase, b: PgDatabase, admin: PgDatabase) => Promise<void>): Promise<void> {
    const own = await ownDatabase();
    const admin = createPgDatabase(own.url, 'public', { max: 1 });
    const a = createPgDatabase(own.url, 'tenant_a', { max: 4 });
    const b = createPgDatabase(own.url, 'tenant_b', { max: 4 });
    try {
      await use(a, b, admin);
    } finally {
      for (const database of [a, b, admin]) await database.close();
      await own.drop();
    }
  }

  it('do not see each other: each has its tables, its journal and its people', async () => {
    await twoWorkers(async (a, b, admin) => {
      // Both start at the same moment, as two deployments on one server would.
      await Promise.all([migrate(a), migrate(b)]);

      const alice = await createPostgresAccountStore(a).signIn({
        provider: 'email',
        subject: 'alice@acme.dev',
        email: 'alice@acme.dev',
      });
      const seed = seedFixture({ id: 'sd_a' });
      await createPostgresSeedStore(a).create(seed, undefined, POLICY);

      assert.equal((await createPostgresAccountStore(b).account(alice.id)) === undefined, true);
      assert.deepEqual(
        await createPostgresSeedStore(b).findForPage(
          { url: seed.page.url, clientId: seed.client?.id },
          undefined,
          POLICY,
        ),
        [],
      );
      assert.deepEqual(await rowsOf(b, 'SELECT email FROM "user"'), []);
      assert.deepEqual(await rowsOf(a, 'SELECT email FROM "user"'), [{ email: 'alice@acme.dev' }]);

      // The same tables in each, the journal of each with every migration, and nothing in public.
      assert.deepEqual(await tablesOf(admin, 'tenant_a'), await tablesOf(admin, 'tenant_b'));
      const journals = await rowsOf(
        admin,
        `SELECT (SELECT count(*)::int FROM tenant_a."${APPLIED.migrationsTable}") AS a,
                (SELECT count(*)::int FROM tenant_b."${APPLIED.migrationsTable}") AS b`,
      );
      assert.equal(journals[0]?.a, journals[0]?.b);
      assert.ok(Number(journals[0]?.a) >= 6);
      assert.deepEqual(await tablesOf(admin, 'public'), []);
    });
  });

  it('gives every connection of a pool its schema, whatever the role and the database say', async () => {
    await twoWorkers(async (a, b, admin) => {
      const name = String((await rowsOf(admin, 'SELECT current_database() AS name'))[0]?.name);
      // The search path of another tenant: the database and the role both say `tenant_b` first.
      await rowsOf(admin, `CREATE SCHEMA tenant_a`);
      await rowsOf(admin, `CREATE SCHEMA tenant_b`);
      await rowsOf(admin, `ALTER DATABASE ${name} SET search_path TO tenant_b, public`);
      await rowsOf(admin, `ALTER ROLE CURRENT_USER IN DATABASE ${name} SET search_path TO tenant_b, public`);

      // More calls at once than a pool has connections, each one holding its connection: the four
      // connections of the pool are all opened, and all asked.
      const seen = await Promise.all(
        Array.from({ length: 12 }, () =>
          a.transaction(async (tx) => {
            const answer = await tx.execute(sql`SELECT current_schema() AS s, pg_backend_pid() AS pid, pg_sleep(0.05)`);

            return (answer as unknown as { rows: { s: string; pid: number }[] }).rows[0];
          }),
        ),
      );
      assert.deepEqual([...new Set(seen.map((row) => row?.s))], ['tenant_a']);
      assert.equal(new Set(seen.map((row) => row?.pid)).size, 4, 'the pool did not open its four connections');
      assert.deepEqual(await rowsOf(b, 'SELECT current_schema() AS s'), [{ s: 'tenant_b' }]);

      await migrate(a);
      assert.ok((await tablesOf(admin, 'tenant_a')).includes('sites'));
      assert.deepEqual(await tablesOf(admin, 'tenant_b'), []);
    });
  });
});

describe('a role that has its schema and nothing else (FRU-219)', { skip: NO_REAL_POSTGRES }, () => {
  it('is enough: no right on public, none on the database, and the worker signs a person in', async () => {
    const own = await ownDatabase();
    const admin = createPgDatabase(own.url, 'public', { max: 1 });
    const role = `r_${new URL(own.url).pathname.slice(1)}`;
    const lesser = new URL(own.url);
    lesser.username = role;
    lesser.password = 'not-a-secret-of-a-test';
    const database = createPgDatabase(lesser.href, SCHEMA, { max: 3 });
    try {
      await anotherApplicationIn(admin);
      // What an operator of a shared database does, once: a role, a schema, and the role's rights on it.
      for (const statement of [
        `CREATE ROLE ${role} LOGIN PASSWORD 'not-a-secret-of-a-test'`,
        `CREATE SCHEMA ${SCHEMA}`,
        `GRANT USAGE, CREATE ON SCHEMA ${SCHEMA} TO ${role}`,
        `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
        `REVOKE CREATE ON DATABASE ${new URL(own.url).pathname.slice(1)} FROM PUBLIC`,
      ]) {
        await rowsOf(admin, statement);
      }
      assert.deepEqual(
        await rowsOf(
          database,
          `SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
                  has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
                  has_database_privilege(current_user, current_database(), 'CREATE') AS in_database`,
        ),
        [{ public_usage: false, public_create: false, in_database: false }],
        'the role has a right this test says it has not',
      );
      const before = await whatIsIn(admin, 'public');

      const worker = await workerOf(database);
      const cookie = await worker.signIn('alice@acme.dev');
      assert.equal((await worker.call('/console/me', { headers: { Cookie: cookie } })).status, 200);

      assert.ok((await tablesOf(admin, SCHEMA)).includes(APPLIED.migrationsTable));
      assert.deepEqual(await whatIsIn(admin, 'public'), before);
      // And it reads nothing of the other application.
      await assert.rejects(rowsOf(database, 'SELECT login FROM public."user"'), /permission denied for schema public/);
    } finally {
      await database.close();
      await admin.close();
      await own.drop();
      const server = createPgDatabase(TEST_DATABASE_URL ?? '', 'public', { max: 1 });
      await rowsOf(server, `DROP ROLE IF EXISTS ${role}`);
      await server.close();
    }
  });

  it('is refused, with what to grant, when it may not create in its schema', async () => {
    const own = await ownDatabase();
    const admin = createPgDatabase(own.url, 'public', { max: 1 });
    const role = `r_${new URL(own.url).pathname.slice(1)}`;
    const lesser = new URL(own.url);
    lesser.username = role;
    lesser.password = 'not-a-secret-of-a-test';
    const database = createPgDatabase(lesser.href, SCHEMA, { max: 2 });
    try {
      await rowsOf(admin, `CREATE ROLE ${role} LOGIN PASSWORD 'not-a-secret-of-a-test'`);
      await rowsOf(admin, `CREATE SCHEMA ${SCHEMA}`);
      await rowsOf(admin, `GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);

      await assert.rejects(migrate(database), (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.match(error.message, /cannot create in the schema « fruitback »/);
        assert.match(error.message, /grant that role CREATE and USAGE on the schema/);
        assert.doesNotMatch(error.message, /r_t_/);

        return true;
      });
      assert.deepEqual(await tablesOf(admin, SCHEMA), []);
    } finally {
      await database.close();
      await admin.close();
      await own.drop();
      const server = createPgDatabase(TEST_DATABASE_URL ?? '', 'public', { max: 1 });
      await rowsOf(server, `DROP ROLE IF EXISTS ${role}`);
      await server.close();
    }
  });
});

describe('the name of the schema (FRU-219)', () => {
  it('is `public` when none is named, and a plain name otherwise', () => {
    assert.deepEqual([undefined, '', '  ', 'public', 'fruitback', ' fruitback_2 ', '_f'].map(readDatabaseSchema), [
      'public',
      'public',
      'public',
      'public',
      'fruitback',
      'fruitback_2',
      '_f',
    ]);
  });

  it('refuses a name that needs a quote, a name of PostgreSQL itself, and one that PostgreSQL would cut', () => {
    for (const name of [
      'Fruitback',
      'fruit-back',
      'fruit back',
      '2fruit',
      'fruitback"; DROP SCHEMA public CASCADE; --',
      'a.b',
      'pg_catalog',
      'pg_temp',
      'information_schema',
      'f'.repeat(64),
      // Key words that PostgreSQL prints between quotes (raised in review).
      'user',
      'order',
      'table',
      'between',
    ]) {
      assert.equal(readDatabaseSchema(name), undefined, name);
    }
    assert.equal(readDatabaseSchema('f'.repeat(63)), 'f'.repeat(63));
    assert.throws(() => createPgDatabase('postgres://u:p@127.0.0.1:1/d', 'Not Plain'), StoreError);
  });

  it(
    'refuses every word that this PostgreSQL prints between quotes, and no other word',
    { skip: NO_REAL_POSTGRES },
    async () => {
      const database = await createRealDatabase();
      try {
        const quoted = await rowsOf(
          database,
          `SELECT word FROM pg_get_keywords() WHERE quote_ident(word) <> word AND word ~ '^[a-z_][a-z0-9_]*$' ORDER BY word`,
        );
        assert.deepEqual(
          quoted.map((row) => row.word),
          [...WORDS_POSTGRESQL_QUOTES].sort(),
        );
        // And a name the worker takes is one PostgreSQL prints as it is.
        for (const name of ['fruitback', 'fruitback_2', '_f', 'public', 'users', 'name', 'value']) {
          assert.equal(readDatabaseSchema(name), name);
          assert.deepEqual(await rowsOf(database, `SELECT quote_ident('${name}') AS printed`), [{ printed: name }]);
        }
      } finally {
        await database.close();
      }
    },
  );

  it('is read by the worker, refused with its rule and not its value, and refused with no database', () => {
    const named = readConfig(envWith({ FRUITBACK_DATABASE_SCHEMA: 'fruitback' }));
    assert.ok(named.ok, named.ok ? '' : named.missing.join(', '));
    assert.equal(named.config.databaseSchema, 'fruitback');
    const none = readConfig(envWith());
    assert.ok(none.ok && none.config.databaseSchema === 'public');

    const refused = readConfig(envWith({ FRUITBACK_DATABASE_SCHEMA: 'Fruit Back' }));
    assert.deepEqual(refused.ok ? [] : refused.missing, [DATABASE_SCHEMA_REFUSED]);
    assert.doesNotMatch(DATABASE_SCHEMA_REFUSED, /Fruit Back/);

    // Said with whatever else is wrong, and once (raised in review): the store `postgres` reads the
    // same variable.
    const two = readConfig(
      envWith({ FRUITBACK_DATABASE_SCHEMA: 'Fruit Back', FRUITBACK_STORE: 'postgres', ALLOWED_ORIGINS: '' }),
    );
    const said = two.ok ? [] : two.missing;
    assert.deepEqual(
      said.filter((name) => name.startsWith('FRUITBACK_DATABASE_SCHEMA')),
      [DATABASE_SCHEMA_REFUSED],
    );
    assert.ok(
      said.some((name) => name.startsWith('ALLOWED_ORIGINS')),
      said.join(' | '),
    );

    const alone = readConfig({
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: 'https://acme.test',
      FRUITBACK_DATABASE_SCHEMA: 'fruitback',
    });
    assert.ok(!alone.ok && alone.missing.some((name) => name.startsWith('FRUITBACK_DATABASE_URL')));
  });
});

describe('the migrations, for a schema that is not public (FRU-219)', () => {
  it('names « public » in the migrations only where a statement names a schema', () => {
    const folder = migrationsFolder();
    for (const file of readdirSync(folder).filter((name) => name.endsWith('.sql'))) {
      const text = readFileSync(join(folder, file), 'utf8');
      const named = text.match(/public/gi)?.length ?? 0;
      const asASchema = text.match(/"public"\./g)?.length ?? 0;

      assert.equal(named, asASchema, `${file} writes « public » where it is not the schema of a statement`);
    }
  });

  it('writes the schema of the worker in place of it, and nothing for public', () => {
    const statement =
      'ALTER TABLE "sites" ADD CONSTRAINT "k" FOREIGN KEY ("w") REFERENCES "public"."organization"("id");';

    assert.equal(inSchema(statement, 'public'), statement);
    assert.equal(
      inSchema(statement, 'fruitback'),
      'ALTER TABLE "sites" ADD CONSTRAINT "k" FOREIGN KEY ("w") REFERENCES "fruitback"."organization"("id");',
    );
  });
});
