import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { envWith } from './auth-worker.fixture.ts';
import { DEV_PLAYGROUND, DEV_SITE, devEnvironment, seedDevWorkspace } from './dev-worker.fixture.ts';
import { databaseOn, newPglite } from './pglite.fixture.ts';
import { DATABASE_REQUIRED, type WorkerEnv, hasAccounts, hasAuth, readConfig } from './env.ts';
import { createMemoryKv } from './kv.ts';
import { DEV_DATABASE_URL, databaseFor } from './postgres.ts';
import { createPgliteDatabase, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { StoreError } from './store.ts';

/**
 * The database of development (FRU-223): the switch `FRUITBACK_DEV_DATABASE`, which production
 * refuses, and the worker that `pnpm dev` and the E2E suite start, as a process.
 */

/** The sources of the worker: this directory. */
const SOURCES = new URL('./', import.meta.url);

function missing(env: WorkerEnv): string[] {
  const config = readConfig(env);

  return config.ok ? [] : config.missing;
}

describe('the switch of the database of development (FRU-223)', () => {
  it('gives the worker a database, its sites and its sessions, with no address', () => {
    const config = readConfig(devEnvironment({}));
    assert.ok(config.ok, config.ok ? '' : config.missing.join(', '));
    assert.equal(config.config.databaseUrl, DEV_DATABASE_URL);
    // It listens on this machine alone: `/__dev/pair` gives a session to whoever can reach it.
    assert.equal(devEnvironment({}).HOST, '127.0.0.1');
    assert.equal(devEnvironment({ HOST: '0.0.0.0' }).HOST, '0.0.0.0');
    // The notes stay on the Linear in memory, unless the environment names a store.
    assert.equal(config.config.store.provider, 'memory');
    const inDatabase = readConfig(devEnvironment({ FRUITBACK_STORE: 'postgres' }));
    assert.ok(inDatabase.ok && inDatabase.config.store.provider === 'postgres');
    assert.ok(hasAccounts(config.config));
    // FRU-225: its console signs a person in, as every worker with a database does, at its own address.
    assert.ok(hasAuth(config.config));
    assert.equal(config.config.publicUrl, 'http://localhost:8788');
    const second = readConfig(devEnvironment({ PORT: '8790' }));
    assert.ok(second.ok && second.config.publicUrl === 'http://localhost:8790');
  });

  it('is refused in production, by its name, whatever else is set', () => {
    for (const env of [
      devEnvironment({ NODE_ENV: 'production' }),
      { ...devEnvironment({}), NODE_ENV: 'production', FRUITBACK_DATABASE_URL: 'postgres://u:p@db.test:5432/d' },
      { NODE_ENV: 'production', FRUITBACK_DEV_DATABASE: 'pglite', ALLOWED_ORIGINS: 'https://a.test' },
    ]) {
      const said = missing(env);
      assert.equal(said.filter((name) => name.startsWith('FRUITBACK_DEV_DATABASE (')).length, 1, said.join(' | '));
      assert.match(said.join(' | '), /dev-only and NODE_ENV is production/);
    }
  });

  it('is refused beside an address, and with a value that is not its one value', () => {
    assert.match(
      missing({ ...devEnvironment({}), FRUITBACK_DATABASE_URL: 'postgres://u:p@db.test:5432/d' }).join(' | '),
      /^FRUITBACK_DATABASE_URL \(FRUITBACK_DEV_DATABASE is set/,
    );
    assert.match(
      missing({ ...devEnvironment({}), FRUITBACK_DEV_DATABASE: 'true' }).join(' | '),
      /^FRUITBACK_DEV_DATABASE \(« pglite » is its one value\)/,
    );
    // A schema of its own is taken too (FRU-219): the database of the process is made in it.
    const named = readConfig(devEnvironment({ FRUITBACK_DATABASE_SCHEMA: 'fruitback' }));
    assert.ok(named.ok && named.config.databaseSchema === 'fruitback');
    // Empty is absent, as for every variable of the worker: the worker has no database then, and is
    // refused for that (FRU-225), never for the switch.
    const blank = missing({
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: 'https://a.test',
      FRUITBACK_DEV_DATABASE: ' ',
    });
    assert.ok(blank.includes(DATABASE_REQUIRED), blank.join(' | '));
    assert.ok(!blank.some((name) => name.startsWith('FRUITBACK_DEV_DATABASE')), blank.join(' | '));
  });

  it('opens no connection in a process that has the switch and no database', () => {
    assert.throws(
      () => databaseFor(DEV_DATABASE_URL, 'public'),
      (error: unknown) => error instanceof StoreError && /pnpm dev/.test(error.message),
    );
    // The host of that address is one no DNS answers (RFC 6761).
    assert.equal(new URL(DEV_DATABASE_URL).hostname.split('.').at(-1), 'invalid');
  });

  it('is in no file that the bundle of the image starts from', () => {
    // The bundle is `main.ts` and what it imports. A fixture is not one of them: the linter refuses
    // PGlite outside `*.fixture.ts` and `*.test.ts`, and this refuses the import of the fixture.
    const build = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts.build;
    assert.match(build ?? '', /esbuild src\/main\.ts /);
    for (const file of ['main.ts', 'server.ts', 'app.ts', 'cli.ts', 'postgres.ts', 'postgres-stores.ts', 'env.ts']) {
      const source = readFileSync(new URL(file, SOURCES), 'utf8');
      assert.doesNotMatch(source, /from '\.\/[a-z-]+\.fixture\.ts'|import\('\.\/[a-z-]+\.fixture/, file);
    }
  });
});

/** A port that is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

describe('the worker of development, as a process (FRU-223)', () => {
  const started: ChildProcess[] = [];
  afterAll(() => {
    for (const child of started) child.kill();
  });

  /** Starts `dev-worker.fixture.ts` with nothing of the environment of this run but its PATH. */
  async function start(
    env: Record<string, string>,
  ): Promise<{ origin: string; exit: Promise<number | null>; said(): string }> {
    const port = await freePort();
    const child = spawn(process.execPath, ['dev-worker.fixture.ts'], {
      cwd: import.meta.dirname,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(child);
    let said = '';
    child.stdout?.on('data', (chunk: Buffer) => (said += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (said += chunk.toString()));

    return {
      origin: `http://127.0.0.1:${port}`,
      exit: new Promise((resolve) => child.once('exit', resolve)),
      said: () => said,
    };
  }

  async function ready(origin: string, said: () => string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        if ((await fetch(`${origin}/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the worker of development did not start:\n${said()}`);
  }

  const PAGE = `${DEV_PLAYGROUND}/pricing`;
  const read = (origin: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${origin}/feedback?url=${encodeURIComponent(PAGE)}&client=${DEV_SITE}`, {
      headers: { Origin: DEV_PLAYGROUND, ...headers },
    });

  for (const store of ['memory', 'postgres']) {
    it(`starts with no service, keeps a note and gives it back, with its notes in « ${store} »`, async () => {
      // `memory` is what `pnpm dev` runs with no variable at all.
      const worker = await start(store === 'memory' ? {} : { FRUITBACK_STORE: store });
      await ready(worker.origin, worker.said);
      assert.deepEqual(await (await fetch(`${worker.origin}/health`)).json(), { ok: true, store });
      // With no HOST in its environment, the process says where it listens.
      assert.match(worker.said(), /listening on 127\.0\.0\.1:\d+ /);

      const seed = noteFixture({ page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
      const sent = await fetch(`${worker.origin}/feedback`, {
        method: 'POST',
        headers: { Origin: DEV_PLAYGROUND, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...seed, client: { id: DEV_SITE } }),
      });
      assert.equal(sent.status, 201, await sent.clone().text());

      const answer = (await (await read(worker.origin)).json()) as { issues: { seed: { note: string } }[] };
      assert.deepEqual(
        answer.issues.map((issue) => issue.seed.note),
        [seed.note],
      );
      // A site that the workspace does not hold is not served, as on any worker with a database.
      const other = await fetch(`${worker.origin}/feedback?url=${encodeURIComponent(PAGE)}&client=site_nobody`, {
        headers: { Origin: DEV_PLAYGROUND },
      });
      assert.deepEqual(await other.json(), { error: 'unknown-client' });
    });
  }

  it('keeps its tables, its workspace and its notes in a schema of its own when one is named (FRU-219)', async () => {
    const worker = await start({ FRUITBACK_STORE: 'postgres', FRUITBACK_DATABASE_SCHEMA: 'fruitback' });
    await ready(worker.origin, worker.said);
    const seed = noteFixture({ page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
    const sent = await fetch(`${worker.origin}/feedback`, {
      method: 'POST',
      headers: { Origin: DEV_PLAYGROUND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...seed, client: { id: DEV_SITE } }),
    });
    assert.equal(sent.status, 201, await sent.clone().text());
    assert.equal(((await (await read(worker.origin)).json()) as { issues: unknown[] }).issues.length, 1);
    // The same fixture, in the same process as this test: the tables are in the schema, none in public.
    const instance = newPglite();
    const database = await databaseOn(instance, 'fruitback');
    try {
      await migrate(database);
      await seedDevWorkspace(database, { origin: DEV_PLAYGROUND, visibility: 'everyone' });
      const where = await rowsOf(
        database,
        `SELECT DISTINCT schemaname FROM pg_tables WHERE tablename IN ('sites', 'notes', 'kv')`,
      );
      assert.deepEqual(
        where.map((row) => row.schemaname),
        ['fruitback'],
      );
    } finally {
      await instance.close();
    }
  });

  it('mints a pairing code that opens a session of its workspace, which reads a site for members', async () => {
    const worker = await start({ FRUITBACK_DEV_VISIBILITY: 'members' });
    await ready(worker.origin, worker.said);
    assert.equal((await read(worker.origin)).status, 401);

    const minted = (await (
      await fetch(`${worker.origin}/__dev/pair`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Ana', endpoint: worker.origin }),
      })
    ).json()) as { code: string; link: string };
    assert.equal(minted.link, `${worker.origin}/pair#${minted.code}`);

    const paired = await fetch(`${worker.origin}/session/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code }),
    });
    assert.equal(paired.status, 200, await paired.clone().text());
    const { accessToken } = (await paired.json()) as { accessToken: string };
    assert.equal((await read(worker.origin, { Authorization: `Bearer ${accessToken}` })).status, 200);
  });

  it('sets who may leave a note on its site for members, as a spec asks (FRU-330)', async () => {
    const worker = await start({ FRUITBACK_DEV_VISIBILITY: 'members' });
    await ready(worker.origin, worker.said);
    const said = async () => ((await (await read(worker.origin)).json()) as { canWrite?: unknown }).canWrite;
    const set = (writers: unknown) =>
      fetch(`${worker.origin}/__dev/writers`, { method: 'POST', body: JSON.stringify({ writers }) });

    // A new site is « Members only »: the refused read says that a note would be refused too.
    assert.equal(await said(), false);
    const opened = await set('anyone');
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { id: DEV_SITE, writers: 'anyone' });
    assert.equal(await said(), undefined);
    assert.equal((await set('everyone')).status, 400);
    assert.equal(await said(), undefined);
    assert.equal((await set('members')).status, 200);
    assert.equal(await said(), false);
  });

  it('does not start under NODE_ENV=production', async () => {
    const worker = await start({ NODE_ENV: 'production' });
    assert.equal(await worker.exit, 1);
    assert.match(worker.said(), /NODE_ENV is production/);
    await assert.rejects(fetch(`${worker.origin}/health`));
  });
});

/**
 * What is prepared for a public demonstration on PostgreSQL (FRU-223): `apps/playground/demo/postgres`.
 * The image cannot make its site as `dev-worker.fixture.ts` does, so two files of SQL and shell do.
 * Nobody runs them yet: this is what holds them to the schema until somebody does.
 */
describe('the demonstration on PostgreSQL, as it is prepared (FRU-223)', () => {
  const ORIGIN = 'https://demo.fruitback.test';
  // `psql` writes the variable in place of `:'origin'`. PGlite has no variable: the test does it.
  const statements = (): string[] =>
    readFileSync(new URL('../../playground/demo/postgres/seed.sql', import.meta.url), 'utf8')
      .replaceAll(":'origin'", `'${ORIGIN}'`)
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');

  it('gets its workspace and its site from seed.sql, twice with one result, and the worker serves the site', async () => {
    const database = await createPgliteDatabase();
    try {
      await migrate(database);
      const pool = await database.pool();
      const client = await pool.connect();
      try {
        assert.equal(statements().length, 2);
        for (const statement of [...statements(), ...statements()]) await client.query(statement);
      } finally {
        client.release();
      }
      assert.deepEqual(await rowsOf(database, 'SELECT id, workspace_id, origin, visibility FROM sites'), [
        { id: DEV_SITE, workspace_id: 'ws_demo', origin: ORIGIN, visibility: 'everyone' },
      ]);

      const env = envWith({ ALLOWED_ORIGINS: ORIGIN });
      const context = {
        clientIp: '198.51.100.7',
        accounts: createPostgresAccountStore(database),
        sessionStore: createPostgresSessionStore(database),
        kv: createMemoryKv(),
      };
      const page = `${ORIGIN}/pricing`;
      const read = (site: string): Promise<Response> =>
        handleRequest(
          new Request(`https://api.demo.fruitback.test/feedback?url=${encodeURIComponent(page)}&client=${site}`, {
            headers: { Origin: ORIGIN },
          }),
          env,
          context,
        );
      assert.equal((await read(DEV_SITE)).status, 200);
      assert.deepEqual(await (await read('site_nobody')).json(), { error: 'unknown-client' });
    } finally {
      await database.close();
    }
  });

  it('empties tables that the schema has, and no other, in reset.sh', async () => {
    const script = readFileSync(new URL('../../playground/demo/postgres/reset.sh', import.meta.url), 'utf8');
    const truncate = /'(TRUNCATE [a-z_, ]+ RESTART IDENTITY)'/.exec(script)?.[1];
    assert.equal(truncate, 'TRUNCATE notes, note_comments, screenshots RESTART IDENTITY');
    const database = await createPgliteDatabase();
    try {
      await migrate(database);
      await rowsOf(database, truncate);
      // The site is not in that list: a demonstration that lost it would answer « unknown-client ».
      assert.doesNotMatch(truncate, /sites|organization/);
    } finally {
      await database.close();
    }
  });
});
