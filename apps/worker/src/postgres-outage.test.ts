import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { type Database, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, ownDatabase, rowsOf } from './postgres.fixture.ts';

/**
 * A worker whose PostgreSQL closes a connection in the middle of a transaction (FRU-187).
 *
 * A restart of PostgreSQL, an update or a failover does this. The call on that connection must fail,
 * and the worker must stay up for the next one. A connection that a transaction holds had no listener
 * for its `error` event: the process stopped, and the request that was in progress got no answer.
 *
 * The case runs a real worker, as a process of its own, on a real server: the defect stops a process,
 * and only a process shows it.
 */

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL('..', import.meta.url));

/** A worker on a database: its sessions are in it. */
function envOf(url: string, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: 'a-worker-secret-of-exactly-enough',
    FRUITBACK_DATABASE_URL: url,
    FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
    FRUITBACK_PUBLIC_URL: 'https://api.fruitback.test',
    FRUITBACK_AUTH_SECRET: 'a-secret-of-better-auth-that-signs-nothing-here',
    HOST: '127.0.0.1',
    PORT: String(port),
  };
}

/** A port that nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  assert.ok(address !== null && typeof address === 'object');

  return address.port;
}

/**
 * An account that owns a workspace with a site: `pair` mints only for a member of such a workspace
 * (FRU-277). The store migrates the database at its first call.
 */
async function owner(url: string, email: string): Promise<{ id: string; workspace: string }> {
  const database = createPgDatabase(url, 'public', { max: 1 });
  try {
    const accounts = createPostgresAccountStore(database);
    const id = (await accounts.signIn({ provider: 'email', subject: email, email })).id;
    const workspace = (await accounts.createWorkspace(email, id)).id;
    await accounts.addSite(workspace, { origin: `https://${email.split('@')[0]}.test`, visibility: 'everyone' });

    return { id, workspace };
  } finally {
    await database.close();
  }
}

/** A pairing code for `subject` in `workspace`, minted by the command of the worker. */
async function pairingCode(env: NodeJS.ProcessEnv, subject: string, workspace: string): Promise<string> {
  const args = ['src/main.ts', 'pair', '--subject', subject, '--workspace', workspace];
  const { stdout } = await run(process.execPath, args, {
    cwd: WORKER,
    env,
    timeout: 8_000,
  });
  const code = /^ {4}(\S+)$/m.exec(stdout)?.[1];
  assert.ok(code !== undefined, stdout);

  return code;
}

/** `true` when `predicate` holds within `ms`, polled every 50 ms. */
async function within(ms: number, predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(50);
  }

  return false;
}

describe('a worker whose PostgreSQL closes a connection in a transaction (FRU-187)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it(
    'answers an error for that request, stays up, and serves the next one',
    { skip: NO_REAL_POSTGRES, timeout: 30_000 },
    async () => {
      const own = await ownDatabase();
      cleanups.push(own.drop);
      const port = await freePort();
      const env = envOf(own.url, port);
      const alice = await owner(own.url, 'alice@acme.test');
      const bob = await owner(own.url, 'bob@acme.test');
      const first = await pairingCode(env, alice.id, alice.workspace);
      const second = await pairingCode(env, bob.id, bob.workspace);

      const worker: ChildProcess = spawn(process.execPath, ['src/main.ts'], { cwd: WORKER, env });
      let output = '';
      worker.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      worker.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      cleanups.push(async () => {
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        worker.kill('SIGKILL');
        await once(worker, 'exit');
      });
      assert.ok(await within(10_000, () => output.includes('[fruitback] listening on')), output);

      // Another session holds the row of the first code. The transaction of the redeem reads it, then
      // waits on that row in its UPDATE: there its connection is in the middle of a transaction.
      const admin: Database = createPgDatabase(own.url, 'public', { max: 2 });
      cleanups.push(() => admin.close());
      let letGo = (): void => {};
      const held = new Promise<void>((resolve) => (letGo = resolve));
      let holding = false;
      const holder = admin.alone(async (db) => {
        await db.execute(sql`BEGIN`);
        await db.execute(sql`SELECT 1 FROM pairings WHERE subject = ${alice.id} FOR UPDATE`);
        holding = true;
        await held;
        await db.execute(sql`COMMIT`);
      });

      assert.ok(await within(5_000, () => holding));
      const redeem = (code: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/session/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(10_000),
        });
      const answer = redeem(first).then(
        (response) => response,
        (error: unknown) => error,
      );

      const waiting = async (): Promise<number[]> =>
        (
          await rowsOf(
            admin,
            `SELECT pid FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update "pairings"%'`,
          )
        ).map((row) => Number(row.pid));
      assert.ok(await within(5_000, async () => (await waiting()).length === 1), 'the redeem never waited');
      const [pid] = await waiting();
      await rowsOf(admin, sql`SELECT pg_terminate_backend(${pid})`);

      const response = await answer;
      letGo();
      await holder;
      assert.ok(response instanceof Response, `the worker gave no answer: ${String(response)}\n${output}`);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'store-unavailable' });

      // The client emits its `error` when the socket ends, which may come after the answer.
      await sleep(500);
      assert.equal(worker.exitCode, null, output);
      assert.equal(worker.signalCode, null, output);
      assert.match(output, /a PostgreSQL connection failed: Error: Connection terminated unexpectedly/);
      assert.ok(!output.includes(own.url) && !output.includes(decodeURIComponent(new URL(own.url).password)), output);

      const next = await redeem(second);
      assert.equal(next.status, 200, output);
      assert.deepEqual(((await next.json()) as { identity: unknown }).identity, {
        subject: bob.id,
        workspace: bob.workspace,
      });
    },
  );
});
