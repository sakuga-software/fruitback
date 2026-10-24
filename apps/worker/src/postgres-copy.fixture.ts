import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_NOTE_STAGE, type Note, type NoteIssue } from '@fruitback/shared';
import type { ClientPolicy } from './clients.ts';
import { identifierFor, threadsOf, toNoteIssue } from './note-rows.ts';
import type { CreatedIssue, NoteIssueQuery } from './store.ts';

/**
 * The three SQLite files of the last worker that wrote them, frozen: what `migrate-to-postgres` reads
 * (FRU-226). The stores that wrote these files are gone, so the schema of each file is written here
 * as their migrations left it, and the rows are written with plain statements.
 *
 * Each file is in WAL mode, and its connection stays open until `closeFrozenFiles`: the rows stay in
 * the `-wal`, as on a worker that was just stopped.
 */

/** The `user_version` of each file. The copy takes these versions and no other. */
export const FROZEN_VERSIONS = { accounts: 8, sessions: 3, seeds: 1 } as const;

export type FrozenKind = keyof typeof FROZEN_VERSIONS;

const SCHEMAS: Record<FrozenKind, string> = {
  accounts: `
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at INTEGER NOT NULL,
      locale TEXT
    );
    CREATE TABLE logins (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subject)
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE members (
      workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, account_id)
    );
    CREATE INDEX members_by_account ON members (account_id);
    CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      visibility TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      connector_id TEXT REFERENCES connectors (id) ON DELETE SET NULL,
      team_id TEXT,
      project_id TEXT,
      UNIQUE (workspace_id, origin)
    );
    CREATE TABLE email_links (
      code_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      spent_at INTEGER
    );
    CREATE TABLE connectors (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      sealed TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attention TEXT,
      attention_at INTEGER,
      settings TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX connectors_by_workspace ON connectors (workspace_id);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER,
      last_at INTEGER,
      last_status INTEGER,
      last_error TEXT
    );
    CREATE INDEX deliveries_due ON deliveries (next_at);
    CREATE INDEX deliveries_by_connector ON deliveries (connector_id);
    CREATE TABLE site_destinations (
      site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
      team_id TEXT,
      project_id TEXT,
      label TEXT,
      PRIMARY KEY (site_id, position)
    );
    CREATE INDEX site_destinations_by_connector ON site_destinations (connector_id);
    CREATE TABLE domains (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      verified_at INTEGER,
      lost_at INTEGER,
      checked_at INTEGER,
      previews_site_id TEXT REFERENCES sites (id) ON DELETE SET NULL,
      UNIQUE (workspace_id, domain)
    );
  `,
  sessions: `
    CREATE TABLE pairings (
      code_hash TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      name TEXT,
      email TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER,
      workspace TEXT
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      name TEXT,
      email TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      rotated_at INTEGER,
      predecessor_hash TEXT,
      root_hash TEXT,
      workspace TEXT
    );
    CREATE INDEX pairings_by_expiry ON pairings (expires_at);
    CREATE INDEX sessions_by_expiry ON sessions (expires_at);
    CREATE INDEX sessions_by_root ON sessions (root_hash);
  `,
  seeds: `
    CREATE TABLE seeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT,
      page_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      seed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
};

const open = new Map<string, DatabaseSync>();

/** A new file of this kind at `path`, with its schema and its version. Its connection stays open. */
export function frozenFile(path: string, kind: FrozenKind): DatabaseSync {
  const file = new DatabaseSync(path);
  file.exec('PRAGMA journal_mode = WAL');
  file.exec('PRAGMA foreign_keys = ON');
  file.exec(`BEGIN; ${SCHEMAS[kind]} PRAGMA user_version = ${FROZEN_VERSIONS[kind]}; COMMIT;`);
  open.set(path, file);

  return file;
}

/** Closes every file that `frozenFile` opened. The last close writes the `-wal` into its file. */
export function closeFrozenFiles(): void {
  for (const file of open.values()) file.close();
  open.clear();
}

/** A note, as the SQLite store wrote it: at the first stage, with its number given by the file. */
export function writeNote(file: DatabaseSync, seed: Note): CreatedIssue {
  const now = new Date().toISOString();
  const result = file
    .prepare('INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seed.client?.id ?? null, seed.page.url, DEFAULT_NOTE_STAGE, JSON.stringify(seed), now, now);
  const id = Number(result.lastInsertRowid);

  return { id: String(id), identifier: identifierFor(id) };
}

type NoteRecord = { id: number; page_url: string; stage: string; seed: string; updated_at: string };
type CommentRow = { id: number; seed_id: number; author: string | null; body: string; created_at: string };

/**
 * The notes of a page that the SQLite store gave a reader: every note of the page when the query
 * names no client. The replies are read the newest first, so the cap keeps the newest.
 */
export function issuesOfFile(path: string, query: NoteIssueQuery, policy: ClientPolicy): NoteIssue[] {
  const file = open.get(path) ?? new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (
      query.clientId === undefined
        ? file.prepare('SELECT id, page_url, stage, seed, updated_at FROM seeds WHERE page_url = ?').all(query.url)
        : file
            .prepare('SELECT id, page_url, stage, seed, updated_at FROM seeds WHERE page_url = ? AND client_id = ?')
            .all(query.url, query.clientId)
    ) as NoteRecord[];
    const placeholders = rows.map(() => '?').join(', ');
    const replies =
      !policy.showComments || rows.length === 0
        ? []
        : (file
            .prepare(
              `SELECT id, seed_id, author, body, created_at FROM comments WHERE seed_id IN (${placeholders}) ORDER BY seed_id, created_at DESC, id DESC`,
            )
            .all(...rows.map((row) => row.id)) as CommentRow[]);
    const threads = threadsOf(
      replies.map((reply) => ({
        id: reply.id,
        seed_id: reply.seed_id,
        author: reply.author,
        body: reply.body,
        createdAt: reply.created_at,
      })),
    );

    return rows
      .map((row) =>
        toNoteIssue(
          { id: row.id, page_url: row.page_url, stage: row.stage, seed: row.seed, updatedAt: row.updated_at },
          threads.get(row.id) ?? (policy.showComments ? [] : undefined),
        ),
      )
      .filter((issue): issue is NoteIssue => issue !== null);
  } finally {
    if (!open.has(path)) file.close();
  }
}
