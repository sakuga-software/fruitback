import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { type Visibility, WRITERS, type Writers } from './accounts.ts';
import { createPairingCommand } from './app.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { pairingLink } from './pair-page.ts';
import { databaseOn, newPglite } from './pglite.fixture.ts';
import { DEFAULT_DATABASE_SCHEMA, DEV_DATABASE, type PgDatabase, provideDevDatabase } from './postgres.ts';
import { migrate } from './postgres-migrate.ts';
import { startServer } from './server.ts';

/**
 * The worker of development (FRU-223): the worker of `main.ts`, on a PostgreSQL in the process.
 *
 * `pnpm dev` and the E2E suite start this file. It makes a PGlite, applies the migrations, gives the
 * database to the process (`provideDevDatabase`), and starts the server of production on it: the
 * stores, the routes and the configuration are the ones of a worker with `FRUITBACK_DATABASE_URL`.
 * Nothing is installed, and everything dies with the process. The sites, the sessions and the
 * accounts are in that database. The notes are where `FRUITBACK_STORE` says: the Linear in memory
 * unless the environment names another store, and `postgres` puts them in the same database.
 *
 * **Not in the image.** The bundle starts at `main.ts`, which does not import this file, and PGlite
 * is a development dependency. The switch it sets, `FRUITBACK_DEV_DATABASE`, is refused under
 * `NODE_ENV=production`, and this file refuses that environment too.
 *
 * What it adds to the worker:
 *
 * - **One workspace and one site**, `playground`, at the origin of the playground. A worker with a
 *   database serves the sites of its workspaces and nothing else, and the playground signs nobody in.
 *   `FRUITBACK_DEV_VISIBILITY=members` makes the site one that only a session of the workspace reads.
 * - **`POST /__dev/stage`** `{ note, stage }` (FRU-300), which moves a note of the database to a
 *   stage, as a team moves an issue in its tracker. No route of the worker does it: the store is the
 *   tracker's. The specs of « Looks fixed » need a note the team marked done.
 * - **`POST /__dev/pair`**, which answers a pairing code and its link for the workspace. The `pair`
 *   command is another process: it cannot reach a database that lives in this one.
 * - **`POST /__dev/writers`** `{ writers }` (FRU-330), who may leave a note on the site: `members`,
 *   the default of a new site, or `anyone`. A spec about one of the two says it, rather than
 *   reading the default. Through `addSite`, as the console writes it.
 */

/** The site of the playground: the id that `apps/playground` and the specs name. */
export const DEV_SITE = 'playground';
export const DEV_PLAYGROUND = 'http://localhost:5177';
export const DEV_CONSOLE = 'http://localhost:5178';
/** The person of the workspace: its owner, and whoever pairs through `/__dev/pair`. */
export const DEV_OWNER = 'dev@fruitback.test';

/** What the environment of a developer need not say. A variable that is set wins. */
export function devEnvironment(given: WorkerEnv): WorkerEnv {
  const port = given.PORT ?? '8788';

  return {
    // The notes of a site with no destination go to the store of the worker. In development that
    // is the Linear in memory, which gives a note a state, replies and a link, so the playground
    // shows every colour of a pin. `FRUITBACK_STORE=postgres` keeps them in the database instead.
    FRUITBACK_STORE: 'memory',
    PORT: '8788',
    // This machine only (raised in review). The worker listens on every interface by default, and
    // `/__dev/pair` gives a session of the workspace to whoever asks: not to the network.
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: DEV_PLAYGROUND,
    FRUITBACK_CONSOLE_URL: DEV_CONSOLE,
    // A value of development, in a public repository: it signs nothing outside this machine.
    FRUITBACK_IDENTITY_SECRET: 'dev-only-identity-secret-never-deployed',
    // FRU-225: a worker with a database has its console and its sign-in, in development too. A value
    // of development as well, and not the identity secret: the worker refuses one secret for two jobs.
    FRUITBACK_AUTH_SECRET: 'dev-only-sign-in-secret-never-deployed',
    // The seeded owner is the first account, so `invited` would refuse every other address of the specs.
    FRUITBACK_SIGN_UP: 'anyone',
    // The address the console and a sign-in link call this worker at: its own port, on this machine.
    FRUITBACK_PUBLIC_URL: `http://localhost:${port}`,
    ...given,
    FRUITBACK_DEV_DATABASE: DEV_DATABASE,
  };
}

/** The workspace and its site, on a database that holds none. Answers the id of the workspace and of its owner. */
export async function seedDevWorkspace(
  database: PgDatabase,
  site: { origin: string; visibility: Visibility },
): Promise<{ workspace: string; owner: string }> {
  const accounts = createPostgresAccountStore(database);
  const owner = await accounts.signIn({ provider: 'email', subject: DEV_OWNER, email: DEV_OWNER, name: 'Dev' });
  const workspace = await accounts.createWorkspace('Playground', owner.id);
  const made = await accounts.addSite(workspace.id, site);
  // The store gives a site an id of its own. The playground and the specs name `playground`, as the
  // client of `FRUITBACK_CLIENTS` was named: one statement, on a table that nothing references yet.
  const pool = await database.pool();
  const client = await pool.connect();
  try {
    await client.query('UPDATE sites SET id = $1 WHERE id = $2', [DEV_SITE, made.id]);
  } finally {
    client.release();
  }

  return { workspace: workspace.id, owner: owner.id };
}

/** `POST /__dev/writers`: who may leave a note on the site of the playground (FRU-330). `400` for another value. */
async function setWriters(
  database: PgDatabase,
  workspace: string,
  visibility: Visibility,
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const asked = await bodyOf(incoming);
  if (!(WRITERS as readonly unknown[]).includes(asked.writers)) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid-writers' }));

    return;
  }
  const site = await createPostgresAccountStore(database).addSite(workspace, {
    origin: DEV_PLAYGROUND,
    visibility,
    writers: asked.writers as Writers,
  });
  response
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ id: site.id, writers: site.writers }));
}

const STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'];

/** `POST /__dev/stage`: the note whose seed has this id goes to this stage. `404` for no such note. */
async function moveStage(database: PgDatabase, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const asked = await bodyOf(incoming);
    if (typeof asked.note !== 'string' || typeof asked.stage !== 'string' || !STAGES.includes(asked.stage)) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'note and stage' }));

      return;
    }
    const pool = await database.pool();
    const client = await pool.connect();
    try {
      const moved = await client.query(
        "UPDATE seeds SET stage = $1, updated_at = $3 WHERE (seed::jsonb ->> 'id') = $2",
        [asked.stage, asked.note, Date.now()],
      );
      const count = (moved as { rowCount?: number | null }).rowCount ?? 0;
      response.writeHead(count > 0 ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count }));
    } finally {
      client.release();
    }
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
}

async function bodyOf(incoming: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startDevWorker(given: WorkerEnv = process.env): Promise<void> {
  if (given.NODE_ENV === 'production') {
    console.error('[fruitback] dev-worker.fixture.ts is for development: NODE_ENV is production');
    process.exitCode = 1;

    return;
  }
  const env = devEnvironment(given);
  const config = readConfig(env);
  if (!config.ok) {
    console.error(`[fruitback] the worker of development is misconfigured: ${config.missing.join(', ')}`);
    process.exitCode = 1;

    return;
  }

  // In the schema the configuration names (FRU-219): `public` unless `FRUITBACK_DATABASE_SCHEMA` says.
  const database = await databaseOn(newPglite(), config.config.databaseSchema ?? DEFAULT_DATABASE_SCHEMA);
  await migrate(database);
  provideDevDatabase(database);
  const visibility: Visibility = given.FRUITBACK_DEV_VISIBILITY === 'members' ? 'members' : 'everyone';
  const seeded = await seedDevWorkspace(database, { origin: DEV_PLAYGROUND, visibility });

  const server = startServer(env);
  const serve = server.listeners('request') as ((incoming: IncomingMessage, response: ServerResponse) => void)[];
  server.removeAllListeners('request');
  server.on('request', (incoming: IncomingMessage, response: ServerResponse) => {
    if (incoming.method === 'POST' && incoming.url === '/__dev/stage') {
      void moveStage(database, incoming, response);

      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/__dev/writers') {
      void setWriters(database, seeded.workspace, visibility, incoming, response);

      return;
    }
    if (incoming.method !== 'POST' || incoming.url !== '/__dev/pair') {
      for (const listener of serve) listener(incoming, response);

      return;
    }
    void (async () => {
      const asked = await bodyOf(incoming);
      const name = typeof asked.name === 'string' ? asked.name : 'Dev';
      const endpoint = typeof asked.endpoint === 'string' ? asked.endpoint : `http://localhost:${env.PORT}`;
      const minted = await createPairingCommand(config.config, {
        subject: seeded.owner,
        name,
        workspace: seeded.workspace,
      });
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: minted.code, link: pairingLink(endpoint, minted.code) }));
    })().catch((error: unknown) => {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    });
  });
  console.log(
    `[fruitback] the worker of development: a database in this process, the site « ${DEV_SITE} » at ${DEV_PLAYGROUND} (${visibility})`,
  );
}

if (process.argv[1] === import.meta.filename) await startDevWorker();
