import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  DEFAULT_SEED_STAGE,
  SEED_STAGES,
  SEED_STAGE_STYLES,
  type Seed,
  type SeedComment,
  type SeedIssue,
  type SeedStage,
  buildIssueTitle,
  seedIssueSchema,
  seedSchema,
} from '@fruitback/shared';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { type CreatedIssue, type SeedIssueQuery, type SeedStore, StoreError } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

/**
 * Seeds in a SQLite file, so self-hosting needs nobody's account (SKG-524).
 *
 * **This is the connector that had to be uncomfortable.** One implementation of `SeedStore` proved
 * nothing — an abstraction with a single implementation is an abstraction imagined. GitHub Issues
 * would have proved almost as little: markdown bodies, labels and full-text search are Linear's
 * shape wearing another name, so a still-Linear-shaped interface would have passed unnoticed.
 *
 * SQLite shares none of it. No markdown body, no `contains` filter, no labels, no workflow states.
 * Two places it genuinely did not fit, and both were the interface leaking rather than SQLite being
 * awkward:
 *
 * - **`SeedIssue.url` was required.** There is no page to open here, and the only way to satisfy the
 *   schema was to invent a URL. It is optional now, and the widget renders the link conditionally.
 * - **The widget's thread said "sur Linear".** A vendor name in the UI of a widget that is not
 *   supposed to know which store answers — the same defect `store-unavailable` fixed in the error
 *   codes (SKG-522).
 *
 * Everything else fitted, which is the result this ticket was for.
 *
 * **`node:sqlite`, so there is no dependency.** Native since Node 22 and non-experimental on the
 * Node 26 the image runs. A self-hosting story that begins with compiling a native module is not one.
 */

const sqliteConfigSchema = z.object({
  /** The database file. A directory that does not exist is an error, not something to create. */
  path: z.string().min(1),
});

export type SqliteConfig = z.infer<typeof sqliteConfigSchema>;

/**
 * The schema, one statement per version, applied in order.
 *
 * Hand-written and versioned through `PRAGMA user_version`, because an ORM for two tables is a
 * dependency and a build step bought with nothing. Append to this array; never edit an entry that
 * has shipped, or a database in the field is left at a version whose meaning changed underneath it.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE seeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT,
    page_url TEXT NOT NULL,
    stage TEXT NOT NULL,
    seed TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- The hot query, and the only one: every seed of one page, for one client. Indexed in that order
  -- because the URL is always known and the client is not, on a single-client worker.
  CREATE INDEX seeds_by_page ON seeds (page_url, client_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed_id INTEGER NOT NULL REFERENCES seeds (id) ON DELETE CASCADE,
    author TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX comments_by_seed ON comments (seed_id, created_at);
  `,
];

/** How many replies travel with a pin. A longer thread belongs wherever the team actually talks. */
const COMMENTS_PER_ISSUE = 20;

/**
 * One connection per file, for the lifetime of the process.
 *
 * `SeedStore` objects are cheap and the transport builds one per call on purpose — see
 * `RequestContext.store`. A **connection** is not cheap, and `handleRequest` still has a fallback
 * that builds a store when the transport did not provide one. Without this map that fallback opens a
 * database handle per request, which is the exact hazard SKG-522 was written to prevent and which
 * nothing observable would have reported.
 */
const connections = new Map<string, DatabaseSync>();

/**
 * How many handles this process has actually opened.
 *
 * A counter and not `connections.size`, because the map is keyed by path: a `connect` that stopped
 * reusing would overwrite the same entry and leave the size at one. That is not a hypothetical — the
 * first version of this test asserted the size, and the mutation that removes the reuse passed it.
 */
let opened = 0;

function connect(path: string): DatabaseSync {
  const open = connections.get(path);
  if (open !== undefined) return open;

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch (error) {
    // A missing directory or a read-only volume, which is a misconfiguration the operator can fix —
    // so it reads as the store being unavailable rather than as the reporter's note being bad.
    throw new StoreError(`SQLite could not open ${path}: ${String(error)}`);
  }

  // WAL so a read is not blocked by a write. `foreign_keys` is off by default in SQLite, and the
  // cascade that deletes a seed's comments depends on it being on.
  opened += 1;

  // Closed on failure, and that is not defensive tidiness. The constructor succeeds on a file that
  // is not a database at all — a bad restore, a truncated volume — and the first PRAGMA is what
  // throws. The handle is open by then, and since `handleRequest` falls back to building a store per
  // request, an unclosed one here leaks a file descriptor **per request** until the process runs out.
  // Reproduced: `new DatabaseSync` returns, `PRAGMA journal_mode` throws `file is not a database`.
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    migrate(database);
  } catch (error) {
    database.close();
    throw new StoreError(`SQLite could not initialise ${path}: ${String(error)}`);
  }

  connections.set(path, database);

  return database;
}

/** Applied on open rather than by a separate command: a self-hoster runs one container, not two. */
function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    // One transaction, because the migration and the version it records are otherwise two
    // autocommitted statements. A crash between them leaves the tables created with the version
    // still at 0, so the next open re-runs `CREATE TABLE seeds`, fails, and answers 502 for ever —
    // an unrecoverable database from one badly timed restart. Measured: `PRAGMA user_version` is
    // transactional, and a rollback takes the tables and the version back together.
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[index] as string);
      // Interpolated because PRAGMA does not take a bound parameter, and the value is a loop counter
      // rather than anything a caller can influence.
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

/** How many handles have been opened since the last close. Asserted by a test; see `opened`. */
export function sqliteConnectionsOpened(): number {
  return opened;
}

/** Test seam, and what lets a suite point several stores at one in-memory database in turn. */
export function closeSqliteConnections(): void {
  for (const database of connections.values()) database.close();
  connections.clear();
  opened = 0;
}

type SeedRow = {
  id: number;
  page_url: string;
  stage: string;
  seed: string;
  updated_at: string;
};

type CommentRow = { id: number; seed_id: number; author: string | null; body: string; created_at: string };

/**
 * The states are ours, so there is nothing to project.
 *
 * Linear needs `stageForLinearState` because its vocabulary is its own and the contract's is the
 * contract's. Here the column *is* a `SeedStage`, and the only translation left is the one the
 * contract already owns: an unrecognised value colours the pin rather than hiding someone's note.
 */
function stageOf(value: string): SeedStage {
  return (SEED_STAGES as readonly string[]).includes(value) ? (value as SeedStage) : DEFAULT_SEED_STAGE;
}

/**
 * A row back into the read envelope.
 *
 * Parsed through `seedSchema` rather than trusted: the column holds JSON this worker wrote, but a
 * file on a volume is something an operator can edit, a restore can be older than the code, and a
 * malformed row must cost that one pin instead of the whole page. Same reasoning as the tolerant
 * parser on Linear descriptions.
 */
function toSeedIssue(row: SeedRow, comments: SeedComment[] | undefined): SeedIssue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.seed);
  } catch {
    return null;
  }

  const seed = seedSchema.safeParse(parsed);
  if (!seed.success) return null;

  // The row was selected on `page_url`, and the seed carries its own `page.url`. They are written
  // together and can only drift through an edit or a restore — but if they do, this seed belongs to
  // another page, and returning it puts one page's note on top of another's element. The Linear
  // connector keeps the same invariant, there because its filter is a substring match and here
  // because a file is something a human can open. Same promise, different reason.
  if (seed.data.page.url !== row.page_url) return null;

  const stage = stageOf(row.stage);
  const candidate = {
    id: String(row.id),
    identifier: identifierFor(row.id),
    // No `url`: there is no interface to open. See the field's own note in the contract.
    title: buildIssueTitle(seed.data),
    stage,
    // The stage's own label, because the state and the stage are the same thing in this store.
    stateName: SEED_STAGE_STYLES[stage].label,
    updatedAt: row.updated_at,
    ...(comments === undefined ? {} : { comments }),
    seed: seed.data,
  };

  const result = seedIssueSchema.safeParse(candidate);

  return result.success ? result.data : null;
}

/** `FB-12`, because a reporter quoting a number to their team needs something to say out loud. */
function identifierFor(id: number): string {
  return `FB-${id}`;
}

export function createSqliteStore(config: SqliteConfig): SeedStore {
  return {
    name: 'sqlite',
    // One file, one tenant's worth of data, whatever the client id says. The worker keeps the client
    // in the read cache key regardless, which is what stops two clients sharing an entry.
    scope: () => config.path,
    create: (seed, _client, _policy) => insert(config, seed),
    findForPage: (query, _client, policy) => select(config, query, policy),
  };
}

/**
 * `async`, so a failure to open the file is a **rejection** and not a synchronous throw.
 *
 * `SeedStore.create` promises a promise. `app.ts` happens to `await` inside a `try` and would have
 * caught either, but any caller reaching for `.catch()` would have been bypassed entirely — and
 * `connect` throws before the first `await` on the very path that matters, a volume the operator did
 * not mount. Caught by `reports a path it cannot open`, which fails against the synchronous version.
 */
async function insert(config: SqliteConfig, seed: Seed): Promise<CreatedIssue> {
  const database = connect(config.path);
  const now = new Date().toISOString();

  try {
    const result = database
      .prepare('INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      // `page.url` is already canonicalized by the write path, which is what makes the read find it.
      .run(seed.client?.id ?? null, seed.page.url, DEFAULT_SEED_STAGE, JSON.stringify(seed), now, now);
    const id = Number(result.lastInsertRowid);

    // No `url`: see `CreatedIssue`. An empty string would be a link to the current page.
    return { id: String(id), identifier: identifierFor(id) };
  } catch (error) {
    throw new StoreError(`SQLite could not store the seed: ${String(error)}`);
  }
}

/** `async` for the same reason as `insert`: an unopenable file must reject, never throw. */
async function select(config: SqliteConfig, query: SeedIssueQuery, policy: ClientPolicy): Promise<SeedIssue[]> {
  const database = connect(config.path);

  try {
    // An exact match, where Linear can only filter by substring and has to re-check afterwards. The
    // interface says `findForPage` and not `contains` precisely so this could be the plain thing.
    const rows = (
      query.clientId === undefined
        ? database.prepare('SELECT id, page_url, stage, seed, updated_at FROM seeds WHERE page_url = ?').all(query.url)
        : database
            .prepare('SELECT id, page_url, stage, seed, updated_at FROM seeds WHERE page_url = ? AND client_id = ?')
            .all(query.url, query.clientId)
    ) as SeedRow[];

    const comments = policy.showComments ? commentsFor(database, rows) : undefined;

    return (
      rows
        // `undefined` when the worker was not asked for replies, so the field is left out entirely
        // and the widget says nothing rather than claiming the team never answered.
        .map((row) => toSeedIssue(row, comments?.get(row.id) ?? (policy.showComments ? [] : undefined)))
        .filter((issue): issue is SeedIssue => issue !== null)
    );
  } catch (error) {
    throw new StoreError(`SQLite could not read the seeds: ${String(error)}`);
  }
}

/**
 * Every reply for the seeds on this page, in one statement.
 *
 * One query per pin would be N+1 against a file on a volume — cheap per call and wrong at the shape
 * level, which is the kind of thing that only shows up on the page with forty notes.
 */
function commentsFor(database: DatabaseSync, rows: SeedRow[]): Map<number, SeedComment[]> {
  const byId = new Map<number, SeedComment[]>();
  if (rows.length === 0) return byId;

  const placeholders = rows.map(() => '?').join(', ');
  const found = database
    .prepare(
      // **Newest first**, and the cap therefore keeps the newest. Ordering oldest-first and capping
      // while iterating kept the *oldest* twenty, so past twenty replies every new answer became
      // unreachable — and this store reports no `url`, so the pin's thread is the only interface
      // there is. Linear keeps the newest for the same reason; it just gets them in that order.
      `SELECT id, seed_id, author, body, created_at FROM comments WHERE seed_id IN (${placeholders}) ORDER BY seed_id, created_at DESC, id DESC`,
    )
    .all(...rows.map((row) => row.id)) as CommentRow[];

  for (const row of found) {
    const thread = byId.get(row.seed_id) ?? [];
    if (thread.length >= COMMENTS_PER_ISSUE) continue;

    thread.push({
      id: String(row.id),
      // Plain text, never markup: the widget renders it as `textContent`, and this column holds
      // whatever anyone with write access to the file put there.
      body: row.body,
      createdAt: row.created_at,
      ...(row.author === null ? {} : { author: row.author }),
    });
    byId.set(row.seed_id, thread);
  }

  // Reversed on the way out: selected newest-first so the cap keeps the right end, handed over
  // oldest-first because that is the end a conversation reads from.
  for (const thread of byId.values()) thread.reverse();

  return byId;
}

/**
 * SQLite as a selectable store (SKG-524): `FRUITBACK_STORE=sqlite`.
 *
 * `FRUITBACK_SQLITE_PATH` names its own variable, like every other connector's, so a worker on
 * Linear is never asked for it and a worker on SQLite is never asked for a Linear key.
 */
export function createSqliteStoreSpec(): StoreSpec {
  return defineStore({
    provider: 'sqlite',
    envNames: { path: 'FRUITBACK_SQLITE_PATH' },
    read: (env) => ({ path: env.FRUITBACK_SQLITE_PATH || undefined }),
    schema: sqliteConfigSchema,
    create: createSqliteStore,
  });
}
