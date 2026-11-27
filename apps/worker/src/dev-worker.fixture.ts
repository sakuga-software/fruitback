import { isOneOf } from './one-of.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { VISITOR_NOTE_LIMITS, type Visibility, WRITERS, type Writers } from './accounts.ts';
import { createPairingCommand } from './app.ts';
import { newAgentKey } from './agent-keys.ts';
import { digest } from './session.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { createLinearFake, installLinearFake, LINEAR_FAKE_TEAM, type LinearFake } from './linear-fake.fixture.ts';
import { pairingLink } from './pair-page.ts';
import { databaseOn, newPglite } from './pglite.fixture.ts';
import { DEFAULT_DATABASE_SCHEMA, DEV_DATABASE, type PgDatabase, provideDevDatabase } from './postgres.ts';
import { migrate } from './postgres-migrate.ts';
import { seal } from './secrets.ts';
import { startServer } from './server.ts';
import type { MailMessage } from './mail.ts';
import { provideDevDoneMailer } from './worker-stores.ts';
import { TURNSTILE_TEST_KEYS } from './bot-check.ts';
import { setMemoryNoteStage } from './linear-memory.ts';

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
 *   stage, as a team moves an issue in its tracker, or a note of the Linear in memory (FRU-604). No route of the worker does it: the store is the
 *   tracker's. The specs of « Looks fixed » need a note the team marked done.
 * - **`POST /__dev/pair`**, which answers a pairing code and its link for the workspace. The `pair`
 *   command is another process: it cannot reach a database that lives in this one.
 * - **`POST /__dev/agent-key`** `{ write?, verifiedOnly? }` (FRU-463): an agent key of the owner on the
 *   site, which it answers once, for `claude mcp add` and the specs of `/mcp`.
 * - **`POST /__dev/writers`** `{ writers, notifyDone? }` (FRU-330), who may leave a note on the site: `members`,
 *   the default of a new site, or `anyone`. A spec about one of the two says it, rather than
 *   reading the default. Through `addSite`, as the console writes it.
 * - **`POST /__dev/guards`** `{ visitorNotesPerHour?, holdVisitorNotes?, keepNoteVersions?, botCheck? }` (FRU-704): the site `guards`, made at the first
 *   call, and the safeguards of the card « Safeguards » set on it. Its own workspace, of its own
 *   owner, at the origin of the playground: a spec of a safeguard mounts the widget with this id, and
 *   the other specs, which share the site `playground`, are never counted by it. The site `playground`
 *   says « No limit »: the suite sends many notes from one address. Neither asks for the bot check
 *   until a spec says `botCheck: true`; the worker has the keys of test of Cloudflare, and checks a
 *   token with `verifyTestTurnstile` (FRU-704), which calls nobody.
 * - **`GET /__dev/mail`** (FRU-604): the messages of a note done that the worker would have sent,
 *   oldest first. The worker of development has no provider: it keeps them in this process. Only
 *   these messages: the sign-in by link stays off.
 * - **`FRUITBACK_DEV_LINEAR=fake`** (FRU-426): the site sends its notes through a Linear connector
 *   of the workspace, to the fake Linear of `linear-fake.fixture.ts`. `GET /__dev/tracker` answers
 *   what that fake received. It needs `FRUITBACK_SECRETS_KEY`, which seals the key of the connector.
 */

/** The site of the playground: the id that `apps/playground` and the specs name. */
export const DEV_SITE = 'playground';
export const DEV_PLAYGROUND = 'http://localhost:5177';
export const DEV_CONSOLE = 'http://localhost:5178';
/** The site of the specs of the safeguards (FRU-704), in a workspace of its own. */
export const DEV_GUARDS_SITE = 'guards';
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
    // FRU-704: the keys of test of Cloudflare, public, that always pass. `turnstileVerifierFor` checks
    // the token of this worker with `verifyTestTurnstile`, which calls nobody.
    FRUITBACK_TURNSTILE_SECRET: TURNSTILE_TEST_KEYS.secretPasses,
    FRUITBACK_TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKeyPasses,
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
  // FRU-704: « No limit », and no bot check. Every spec of the suite sends its notes to this site, from
  // one address, and only the specs of the safeguards draw the check.
  const made = await accounts.addSite(workspace.id, { ...site, visitorNotesPerHour: 0, botCheck: false });
  await renameSite(database, made.id, DEV_SITE);

  return { workspace: workspace.id, owner: owner.id };
}

/**
 * The store gives a site an id of its own. The playground and the specs name `playground`, as the
 * client of `FRUITBACK_CLIENTS` was named: one statement, on a table that nothing references yet.
 */
async function renameSite(database: PgDatabase, from: string, to: string): Promise<void> {
  const pool = await database.pool();
  const client = await pool.connect();
  try {
    await client.query('UPDATE sites SET id = $1 WHERE id = $2', [to, from]);
  } finally {
    client.release();
  }
}

/** The owner of the workspace of the site `guards` (FRU-704): another person than `DEV_OWNER`. */
const DEV_GUARDS_OWNER = 'guards@fruitback.test';

/**
 * `POST /__dev/guards` (FRU-704): the site `guards`, made at the first call, with the safeguards the
 * body names. Anybody reads it and leaves a note there. `400` for a value the console would not send.
 */
async function setGuards(
  database: PgDatabase,
  made: { workspace?: Promise<string> },
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const asked = await bodyOf(incoming);
  if (asked.visitorNotesPerHour !== undefined && !isOneOf(asked.visitorNotesPerHour, VISITOR_NOTE_LIMITS)) {
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid-visitor-notes-per-hour' }));

    return;
  }
  if (asked.holdVisitorNotes !== undefined && typeof asked.holdVisitorNotes !== 'boolean') {
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid-hold-visitor-notes' }));

    return;
  }
  if (asked.keepNoteVersions !== undefined && typeof asked.keepNoteVersions !== 'boolean') {
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid-keep-note-versions' }));

    return;
  }
  if (asked.botCheck !== undefined && typeof asked.botCheck !== 'boolean') {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid-bot-check' }));

    return;
  }
  const accounts = createPostgresAccountStore(database);
  // One workspace for the life of the process, whichever call comes first.
  made.workspace ??= (async () => {
    const owner = await accounts.signIn({
      provider: 'email',
      subject: DEV_GUARDS_OWNER,
      email: DEV_GUARDS_OWNER,
      name: 'Guards',
    });
    const workspace = await accounts.createWorkspace('Guards', owner.id);
    // FRU-704: no bot check until a spec asks for it: a spec of another safeguard draws none.
    const site = await accounts.addSite(workspace.id, {
      origin: DEV_PLAYGROUND,
      visibility: 'everyone',
      writers: 'anyone',
      botCheck: false,
    });
    await renameSite(database, site.id, DEV_GUARDS_SITE);

    return workspace.id;
  })();
  const site = await accounts.addSite(await made.workspace, {
    origin: DEV_PLAYGROUND,
    visibility: 'everyone',
    writers: 'anyone',
    ...(asked.visitorNotesPerHour === undefined
      ? {}
      : { visitorNotesPerHour: asked.visitorNotesPerHour as (typeof VISITOR_NOTE_LIMITS)[number] }),
    ...(asked.holdVisitorNotes === undefined ? {} : { holdVisitorNotes: asked.holdVisitorNotes as boolean }),
    ...(asked.keepNoteVersions === undefined ? {} : { keepNoteVersions: asked.keepNoteVersions as boolean }),
    ...(asked.botCheck === undefined ? {} : { botCheck: asked.botCheck as boolean }),
  });
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: site.id,
      visitorNotesPerHour: site.visitorNotesPerHour,
      holdVisitorNotes: site.holdVisitorNotes,
      keepNoteVersions: site.keepNoteVersions,
      botCheck: site.botCheck,
    }),
  );
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
  if (!isOneOf(asked.writers, WRITERS)) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid-writers' }));

    return;
  }
  if (asked.notifyDone !== undefined && typeof asked.notifyDone !== 'boolean') {
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid-notify-done' }));

    return;
  }
  const site = await createPostgresAccountStore(database).addSite(workspace, {
    origin: DEV_PLAYGROUND,
    visibility,
    writers: asked.writers as Writers,
    ...(asked.notifyDone === undefined ? {} : { notifyDone: asked.notifyDone }),
  });
  response
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ id: site.id, writers: site.writers, notifyDone: site.notifyDone }));
}

/**
 * `POST /__dev/agent-key` `{ write?, verifiedOnly? }` (FRU-463): an agent key of the owner on the site of
 * the playground, as the console makes one. It answers the key, for `claude mcp add` and the specs of `/mcp`.
 */
async function makeAgentKey(
  database: PgDatabase,
  seeded: { workspace: string; owner: string },
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const asked = await bodyOf(incoming);
  const secret = newAgentKey();
  const now = Date.now();
  const made = await createPostgresAccountStore(database).createAgentKey(seeded.workspace, {
    name: 'Dev agent',
    sites: [DEV_SITE],
    write: asked.write === true,
    verifiedOnly: asked.verifiedOnly !== false,
    createdBy: seeded.owner,
    keyHash: await digest(secret),
    createdAt: now,
    expiresAt: now + 86_400_000,
  });
  if (typeof made !== 'object') {
    response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: made }));

    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: made.id, secret }));
}

const STAGES = ['new', 'todo', 'progress', 'done', 'closed'];

/** `POST /__dev/stage`: the note with this id goes to this stage. `404` for no such note. */
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
        "UPDATE notes SET stage = $1, updated_at = $3 WHERE (payload::jsonb ->> 'id') = $2",
        [asked.stage, asked.note, Date.now()],
      );
      // FRU-604: and a note of the Linear in memory, the store of the public site of development. Both
      // stores are moved, and the counts added: an id in both is two notes, and each one moves.
      const count =
        ((moved as { rowCount?: number | null }).rowCount ?? 0) + setMemoryNoteStage(asked.note, asked.stage);
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

/**
 * A Linear connector of the workspace, to the fake Linear, and the site of the playground sends to it.
 * `null` when the worker has no key to seal the connector with.
 */
export async function connectFakeLinear(
  database: PgDatabase,
  workspace: string,
  secretsKey: string | undefined,
): Promise<LinearFake | null> {
  if (secretsKey === undefined) return null;
  const fake = createLinearFake();
  installLinearFake(fake);
  const accounts = createPostgresAccountStore(database);
  const connector = await accounts.addConnector(workspace, {
    kind: 'linear',
    label: 'Linear · Bench',
    sealed: seal('lin_api_fake_key_of_the_bench', secretsKey),
  });
  await accounts.setDestinations(workspace, DEV_SITE, [
    { connector: connector.id, teamId: LINEAR_FAKE_TEAM, label: 'Linear · Bench' },
  ]);

  return fake;
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
  // Refused before the database starts, so a misconfigured bench stops at once and installs nothing.
  if (given.FRUITBACK_DEV_LINEAR === 'fake' && config.config.secretsKey === undefined) {
    console.error(
      '[fruitback] FRUITBACK_DEV_LINEAR=fake needs FRUITBACK_SECRETS_KEY, to seal the key of the connector',
    );
    process.exitCode = 1;

    return;
  }

  // In the schema the configuration names (FRU-219): `public` unless `FRUITBACK_DATABASE_SCHEMA` says.
  const database = await databaseOn(newPglite(), config.config.databaseSchema ?? DEFAULT_DATABASE_SCHEMA);
  await migrate(database);
  provideDevDatabase(database);
  const visibility: Visibility = given.FRUITBACK_DEV_VISIBILITY === 'members' ? 'members' : 'everyone';
  const seeded = await seedDevWorkspace(database, { origin: DEV_PLAYGROUND, visibility });
  const tracker =
    given.FRUITBACK_DEV_LINEAR === 'fake'
      ? ((await connectFakeLinear(database, seeded.workspace, config.config.secretsKey)) ?? undefined)
      : undefined;

  // FRU-704: the workspace of the site `guards`, once a spec asked for it.
  const guards: { workspace?: Promise<string> } = {};
  // FRU-604: what a note done would send, kept here for `GET /__dev/mail`.
  const mailed: MailMessage[] = [];
  provideDevDoneMailer({
    send: async (message) => {
      mailed.push(message);
    },
  });

  const server = startServer(env);
  const serve = server.listeners('request') as ((incoming: IncomingMessage, response: ServerResponse) => void)[];
  server.removeAllListeners('request');
  server.on('request', (incoming: IncomingMessage, response: ServerResponse) => {
    if (incoming.method === 'POST' && incoming.url === '/__dev/stage') {
      void moveStage(database, incoming, response);

      return;
    }
    if (tracker !== undefined && incoming.method === 'GET' && incoming.url === '/__dev/tracker') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(tracker.received()));

      return;
    }
    if (incoming.method === 'GET' && incoming.url === '/__dev/mail') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mailed));

      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/__dev/agent-key') {
      void makeAgentKey(database, seeded, incoming, response);

      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/__dev/writers') {
      void setWriters(database, seeded.workspace, visibility, incoming, response);

      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/__dev/guards') {
      void setGuards(database, guards, incoming, response).catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
      });

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
