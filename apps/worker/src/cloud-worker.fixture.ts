import { createServer } from 'node:http';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { authConfigOf, authOptions, startAuth } from './auth.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { createMemoryKv } from './kv.ts';
import type { MailMessage } from './mail.ts';
import { databaseOn, newPglite } from './pglite.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresSessionStore } from './session-postgres.ts';

/**
 * A worker of the Cloud for a test that drives the console in a browser (FRU-148): accounts and
 * sessions in PostgreSQL (PGlite), and a mailer that keeps what it was asked to send.
 *
 * **Run as a process, it listens on a port of its own** (`node cloud-worker.fixture.ts`, with
 * `CLOUD_WORKER` as JSON): Playwright compiles a spec as CommonJS and cannot import the worker, which
 * is ES modules. The spec starts this file, and hands it each request the console sends to the
 * address of the worker. `/__test/sent` and `/__test/received` answer what a test reads: the mail,
 * and the requests. It imports nothing of `node:test`.
 */
export async function cloudWorker(options: { consoleUrl: string; publicUrl: string }) {
  const instance = newPglite();
  const database = await databaseOn(instance);
  await migrate(database);
  const env: WorkerEnv = {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: options.consoleUrl,
    FRUITBACK_IDENTITY_SECRET: 'an-identity-secret-of-a-browser-test!!',
    // Port 1 of this machine: nothing listens there. The stores of the case are handed to each request.
    FRUITBACK_DATABASE_URL: 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback',
    FRUITBACK_CONSOLE_URL: options.consoleUrl,
    FRUITBACK_PUBLIC_URL: options.publicUrl,
    RATE_LIMIT_PER_MINUTE: '2000',
    FRUITBACK_AUTH_SECRET: 'a-secret-of-better-auth-for-a-browser-test',
  };
  const config = readConfig(env);
  if (!config.ok) throw new Error(`The worker of a test is misconfigured: ${config.missing.join(', ')}`);
  const settings = authConfigOf(config.config);
  const accounts = createPostgresAccountStore(database);
  const sessions = createPostgresSessionStore(database);
  const auth =
    settings === undefined ? undefined : await startAuth(await authOptions(settings, await database.pool(), sessions));
  const kv = createMemoryKv();
  const sent: MailMessage[] = [];
  const received: { method: string; path: string; authorization: boolean; cookie: boolean }[] = [];

  return {
    /** Every message the worker was asked to send, in order: a test reads its link here. */
    sent,
    /** Every request the worker answered: its path, and whether it had a token or a cookie. */
    received,
    handle(request: Request): Promise<Response> {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.has('Authorization'),
        cookie: request.headers.has('Cookie'),
      });

      return handleRequest(request, env, {
        clientIp: '127.0.0.1',
        accounts,
        sessionStore: sessions,
        mailer: { send: async (message) => void sent.push(message) },
        kv,
        ...(auth === undefined ? {} : { auth }),
      });
    },
    async close(): Promise<void> {
      await instance.close();
    },
  };
}

/** The process a spec starts: see the header. It prints its port, and stops with its parent. */
if (process.argv[1] === import.meta.filename) {
  const options = JSON.parse(process.env.CLOUD_WORKER ?? '{}') as Parameters<typeof cloudWorker>[0];
  const worker = await cloudWorker(options);
  const server = createServer(async (incoming, outgoing) => {
    const path = incoming.url ?? '/';
    if (path === '/__test/sent' || path === '/__test/received') {
      const body = JSON.stringify(path === '/__test/sent' ? worker.sent : worker.received);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(body);

      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (name === 'host') continue;
      for (const each of Array.isArray(value) ? value : [value ?? '']) headers.append(name, each);
    }
    const answer = await worker.handle(
      new Request(new URL(path, options.publicUrl), {
        method: incoming.method ?? 'GET',
        headers,
        ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }),
      }),
    );
    const out: Record<string, string | string[]> = {};
    answer.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value;
    });
    const cookies = answer.headers.getSetCookie();
    if (cookies.length > 0) out['set-cookie'] = cookies;
    outgoing.writeHead(answer.status, out).end(Buffer.from(await answer.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    console.log(`cloud-worker listening on ${typeof address === 'object' && address !== null ? address.port : ''}`);
  });
  process.on('disconnect', () => process.exit(0));
}
