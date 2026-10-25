import { type Note, type NoteInput, buildNoteBlock, createNote, parseNoteFromDescription } from '@fruitback/shared';
import type { AccountStore } from './accounts.ts';
import type { ClientConfig } from './clients.ts';
import { createConnectorStores } from './connectors.ts';
import { readConfig, type WorkerConfig, type WorkerEnv } from './env.ts';
import { githubAppFor } from './github-connector.ts';
import { type Database, databaseFor } from './postgres.ts';
import { rewriteRows, workspacesWithConnectors } from './postgres-stores.ts';
import type { NoteStore, RewrittenIssue } from './store.ts';
import { accountStoreFor, storeFor } from './worker-stores.ts';

/**
 * `node server.mjs rewrite-notes [--dry-run]` (FRU-378): the notes written before FRU-378, turned once
 * into the note of now. Mathieu's decision of 2026-10-25: no reader of the worker, the widget or the
 * extension takes the payload of before, so this command is the only code that knows it. FRU-449
 * removes it, with this file, once it has run on every instance.
 *
 * It rewrites, in place:
 *
 * - **the block of each issue** of Linear and of GitHub that holds one: of the store of the
 *   environment, and of each `linear` and `github` connector, in the team or the repository of each
 *   destination of a site. The rest of the description stays as it is: the words of the reporter are
 *   the same, and a person may have written beside them;
 * - **the column `payload` of `notes`**, the notes that the worker keeps;
 * - **the body of each delivery** of the queue of a REST connector: version 2, with `note`.
 *
 * **It can run twice**: what it wrote holds no payload of before, so a second run finds nothing. A
 * pin of before is not drawn between the upgrade and the run of this command:
 * `docs/self-hosting/upgrade.md` says to run it at once.
 */

/** The kind of a note of before FRU-378, versions 1 and 2. */
export const LEGACY_KIND = 'fruitback.seed';

/**
 * A payload of before FRU-378 as the note it is now: `kind` and `v` of now, its words in `text`
 * instead of `note`. `undefined` for anything else, a payload of now included, or one that would not
 * be a valid note.
 */
export function fromLegacy(value: unknown): Note | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { kind, v, note: text, ...rest } = value as Record<string, unknown>;
  if (kind !== LEGACY_KIND || (v !== 1 && v !== 2) || typeof text !== 'string') return undefined;
  try {
    return createNote({ ...rest, text } as NoteInput);
  } catch {
    return undefined;
  }
}

/** The fenced block of JSON that `buildNoteBlock` writes, with what is between its fences. */
const BLOCK = /```json\n([\s\S]*?)\n```/g;

/**
 * The description with each block of before turned into the block of now, or `undefined` when it holds
 * none. A description that would not read back as a note after it is left as it is.
 */
export function rewriteDescription(description: string): string | undefined {
  let changed = false;
  const next = description.replace(BLOCK, (block, json: string) => {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return block;
    }
    const note = fromLegacy(value);
    if (note === undefined) return block;
    changed = true;

    return buildNoteBlock(note);
  });
  if (!changed || !parseNoteFromDescription(next).ok) return undefined;

  return next;
}

/** A row of `notes.payload` of before, as the store writes a note now; `undefined` for any other. */
export function rewritePayload(payload: string): string | undefined {
  const note = fromLegacy(readJson(payload));

  return note === undefined ? undefined : JSON.stringify(note);
}

/**
 * A body of the queue of deliveries of before FRU-378, version 1 with `seed`, as version 2 with `note`.
 * `undefined` for any other.
 */
export function rewriteDeliveryBody(body: string): string | undefined {
  const parsed = readJson(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { version, event, workspace, site, identifier, seed, ...rest } = parsed as Record<string, unknown>;
  const note = fromLegacy(seed);
  if (version !== 1 || note === undefined) return undefined;

  return JSON.stringify({ version: 2, event, workspace, site, identifier, note, ...rest });
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A tracker to read: a store, and the clients that name its teams or its repositories. */
export type RewriteSource = { name: string; store: NoteStore; clients: readonly (ClientConfig | undefined)[] };

export type RewriteInput = { database: Database | undefined; sources: readonly RewriteSource[]; dryRun: boolean };

/** What `rewrite-notes` does, given where to look. Each line says what it found and did. */
export async function rewriteNotes({
  database,
  sources,
  dryRun,
}: RewriteInput): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let failed = 0;
  const verb = dryRun ? 'to rewrite' : 'rewritten';

  if (database !== undefined) {
    const rows = await rewriteRows(database, { payload: rewritePayload, body: rewriteDeliveryBody, dryRun });
    lines.push(`notes kept by the worker: ${rows.notes.rewritten} ${verb}, of ${rows.notes.of}`);
    lines.push(`deliveries in the queue: ${rows.deliveries.rewritten} ${verb}, of ${rows.deliveries.of}`);
  }

  for (const { name, store, clients } of sources) {
    if (store.rewriteBlocks === undefined || clients.length === 0) continue;
    let issues: RewrittenIssue[];
    try {
      issues = await store.rewriteBlocks(clients, { marker: LEGACY_KIND, rewrite: rewriteDescription, dryRun });
    } catch (error) {
      failed += 1;
      lines.push(`${name}: not read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const of = (outcome: RewrittenIssue['outcome']) => issues.filter((issue) => issue.outcome === outcome);
    const changed = of(dryRun ? 'to-rewrite' : 'rewritten');
    lines.push(
      `${name}: ${changed.length} issue(s) ${verb}${changed.length === 0 ? '' : `: ${changed.map((issue) => issue.reference).join(', ')}`}`,
    );
    const unchanged = of('unchanged');
    if (unchanged.length > 0) {
      lines.push(
        `${name}: ${unchanged.length} issue(s) name the kind of before and hold no block to rewrite: ${unchanged.map((issue) => issue.reference).join(', ')}`,
      );
    }
    for (const issue of of('failed')) {
      failed += 1;
      lines.push(`${name}: ${issue.reference} failed: ${issue.error ?? 'no reason given'}`);
    }
  }

  if (dryRun) lines.push('dry run: nothing was written.');
  if (failed > 0)
    lines.push(`${failed} failure(s): run the command again once the tracker answers; what is done stays done.`);

  return { ok: failed === 0, lines };
}

const USAGE = 'usage: rewrite-notes [--dry-run]';

/** `node server.mjs rewrite-notes [--dry-run]`, on the environment of the worker. */
export async function runRewriteNotes(
  argv: readonly string[],
  env: WorkerEnv,
): Promise<{ ok: boolean; lines: string[] }> {
  const unknown = argv.filter((flag) => flag !== '--dry-run');
  // Refused rather than ignored: `--dryrun` must not write what `--dry-run` would only list.
  if (unknown.length > 0) return { ok: false, lines: [USAGE, `unexpected: ${unknown.join(' ')}`] };
  const dryRun = argv.includes('--dry-run');

  const read = readConfig(env);
  if (!read.ok) return { ok: false, lines: [`misconfigured: ${read.missing.join(', ')}`] };
  const config = read.config;
  const database =
    config.databaseUrl === undefined ? undefined : databaseFor(config.databaseUrl, config.databaseSchema);
  const own = storeFor(config);
  const accounts = accountStoreFor(config);

  return rewriteNotes({
    database,
    sources: [
      { name: `the store ${config.store.provider}`, store: own, clients: [undefined] },
      ...(await connectorSources(config, accounts, database, own)),
    ],
    dryRun,
  });
}

/** The `linear` and `github` connectors of every workspace, with the destinations that name each one. */
async function connectorSources(
  config: WorkerConfig,
  accounts: AccountStore | undefined,
  database: Database | undefined,
  own: NoteStore,
): Promise<RewriteSource[]> {
  if (accounts === undefined || database === undefined) return [];
  const stores = createConnectorStores(accounts, config.secretsKey, Date.now, config.linearOAuth, {
    ...(config.githubConnector === undefined ? {} : { githubApp: githubAppFor(config.githubConnector) }),
  });
  const sources: RewriteSource[] = [];
  for (const workspace of await workspacesWithConnectors(database)) {
    const sites = await accounts.sites(workspace);
    for (const connector of await accounts.connectors(workspace)) {
      if (connector.kind !== 'linear' && connector.kind !== 'github') continue;
      const clients = sites.flatMap((site) =>
        site.destinations
          .filter((destination) => destination.connector === connector.id)
          .map((destination): ClientConfig => ({
            connector: connector.id,
            ...(destination.teamId === undefined ? {} : { teamId: destination.teamId }),
            ...(destination.projectId === undefined ? {} : { projectId: destination.projectId }),
          })),
      );
      try {
        sources.push({
          name: `the connector ${connector.label} (${connector.kind})`,
          store: await stores(connector.id, workspace, own),
          clients,
        });
      } catch (error) {
        sources.push({
          name: `the connector ${connector.label} (${connector.kind})`,
          store: {
            ...own,
            rewriteBlocks: async () => {
              throw error;
            },
          },
          clients,
        });
      }
    }
  }

  return sources;
}
