import { OWN_SOURCE } from './site-statuses.ts';
import {
  DEFAULT_SEED_STAGE,
  SEED_STAGES,
  type SeedComment,
  type SeedIssue,
  type SeedStage,
  buildIssueTitle,
  seedIssueSchema,
  seedSchema,
} from '@fruitback/shared';
import type { ForgetSelector } from './store.ts';

/**
 * A row of a store that keeps the notes itself, read (FRU-218): `seeds-postgres.ts`, and the file of
 * before that `postgres-copy.ts` copies, with the same columns. A row is parsed here and never
 * trusted: an operator can edit a row, and a restore can be older than the code.
 *
 * This file imports no database.
 */

/** How many replies travel with a pin. A longer thread belongs wherever the team actually talks. */
export const COMMENTS_PER_ISSUE = 20;

/** A note, as both databases hand it over. `updatedAt` is an ISO date. */
export type SeedRow = {
  id: number;
  page_url: string;
  stage: string;
  /** The status of the note in its site (FRU-365). NULL or absent: the built-in status of its stage. */
  status_key?: string | null;
  seed: string;
  updatedAt: string;
};

/** A reply, as both databases hand it over, the newest first for one note. */
export type CommentRow = { id: number; seed_id: number; author: string | null; body: string; createdAt: string };

/** `FB-12`, because a reporter quoting a number to their team needs something to say out loud. */
export function identifierFor(id: number): string {
  return `FB-${id}`;
}

/**
 * The number of the row that `identifierFor` named, or `undefined`. A tracker can name an issue
 * `FB-12` too: the number is a row to look at, never proof that the row is this note.
 */
export function rowOfIdentifier(identifier: string): number | undefined {
  const id = /^FB-([1-9][0-9]{0,15})$/.exec(identifier)?.[1];

  return id === undefined || !Number.isSafeInteger(Number(id)) ? undefined : Number(id);
}

/**
 * The row of `seeds` that a note of the index names, when the worker's store keeps it (FRU-384): in
 * Fruitback, or sent on to an address (a `rest` connector), whose notes the worker keeps too and
 * whose reference is `FB-<id>` (heavy review of #505). A note of a tracker, or of a connector removed
 * since, is the tracker's. The row is only where to look: `isSameSeed` says whether it is this note.
 */
export function keptRowOf(
  place: string,
  connectorKind: string | null | undefined,
  reference: string | null,
): number | undefined {
  const kept = place === 'fruitback' || connectorKind === 'rest';

  return kept && reference !== null ? rowOfIdentifier(reference) : undefined;
}

/** Whether the `seed` column of a row is the note the widget named `seed`: its id is in the JSON. */
export function isSameSeed(column: string, seed: string): boolean {
  try {
    const parsed: unknown = JSON.parse(column);

    return typeof parsed === 'object' && parsed !== null && (parsed as { id?: unknown }).id === seed;
  } catch {
    return false;
  }
}

/**
 * The states are ours, so there is nothing to project.
 *
 * Linear needs `stageForLinearState` because its vocabulary is its own and the contract's is the
 * contract's. Here the column *is* a `SeedStage`, and the only translation left is the one the
 * contract already owns: an unrecognised value colours the pin rather than hiding someone's note.
 */
export function stageOf(value: string): SeedStage {
  return (SEED_STAGES as readonly string[]).includes(value) ? (value as SeedStage) : DEFAULT_SEED_STAGE;
}

/**
 * A row back into the read envelope, or `null` for a row that is not a note of its page.
 *
 * Parsed through `seedSchema` rather than trusted: a malformed row must cost that one pin instead of
 * the whole page. Same reasoning as the tolerant parser on Linear descriptions.
 */
export function toSeedIssue(row: SeedRow, comments: SeedComment[] | undefined): SeedIssue | null {
  const seed = seedSchema.safeParse(readJson(row.seed));
  if (!seed.success) return null;

  // The row was selected on `page_url`, and the seed carries its own `page.url`. They are written
  // together and can only drift through an edit or a restore — but if they do, this seed belongs to
  // another page, and returning it puts one page's note on top of another's element.
  if (seed.data.page.url !== row.page_url) return null;

  const result = seedIssueSchema.safeParse({
    id: String(row.id),
    identifier: identifierFor(row.id),
    // No `url`: there is no interface to open. See the field's own note in the contract.
    title: buildIssueTitle(seed.data),
    stage: stageOf(row.stage),
    // Nobody named the states of this store: they are the stages. An empty name makes the widget
    // write the stage in the words of its catalog, in the language of the reader (FRU-114).
    stateName: '',
    // FRU-366: its status in the `statuses` of the read, which always lists the built-in ones.
    status: `${OWN_SOURCE}:${row.status_key ?? stageOf(row.stage)}`,
    updatedAt: row.updatedAt,
    ...(comments === undefined ? {} : { comments }),
    seed: seed.data,
  });

  return result.success ? result.data : null;
}

/**
 * The replies of each note, from rows that are **the newest first** for one note: the cap keeps the
 * newest, and each thread is handed over oldest first, the end a conversation reads from.
 *
 * Ordering oldest-first and capping while iterating kept the *oldest* twenty, so past twenty replies
 * every new answer became unreachable — and these stores report no `url`, so the pin's thread is the
 * only interface there is.
 */
export function threadsOf(rows: readonly CommentRow[]): Map<number, SeedComment[]> {
  const byId = new Map<number, SeedComment[]>();

  for (const row of rows) {
    const thread = byId.get(row.seed_id) ?? [];
    if (thread.length >= COMMENTS_PER_ISSUE) continue;

    thread.push({
      id: String(row.id),
      // Plain text, never markup: the widget renders it as `textContent`, and this column holds
      // whatever anyone with write access to the database put there.
      body: row.body,
      createdAt: row.createdAt,
      ...(row.author === null ? {} : { author: row.author }),
    });
    byId.set(row.seed_id, thread);
  }
  for (const thread of byId.values()) thread.reverse();

  return byId;
}

/**
 * Which rows `forget` selects. An address and a name are compared trimmed and in lower case, on both
 * sides. An identifier is compared as it is written, `FB-12`.
 *
 * The filter runs on the rows, and not in the database: one row that is not JSON makes a query on
 * the JSON throw for every row, and a row is parsed, never trusted.
 */
export function forgetSelectorFor(which: ForgetSelector): (row: { id: number; seed: string }) => boolean {
  if ('identifiers' in which) {
    const wanted = new Set(which.identifiers);

    return (row) => wanted.has(identifierFor(row.id));
  }

  const [field, value] = 'email' in which ? (['email', which.email] as const) : (['name', which.name] as const);
  const wanted = value.trim().toLowerCase();

  return (row) => reporterFieldOf(row.seed, field) === wanted;
}

function reporterFieldOf(text: string, field: 'email' | 'name'): string | undefined {
  const value = (readJson(text) as { reporter?: Record<string, unknown> } | undefined)?.reporter?.[field];

  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

/** The text of the note of a row, for the list an operator reads before a deletion. */
export function noteOf(text: string): string {
  const note = (readJson(text) as { note?: unknown } | undefined)?.note;

  return typeof note === 'string' ? note : '';
}

/** The id the widget gave the note of a row (FRU-237: the index of the notes is keyed on it). */
export function seedIdOf(text: string): string {
  const id = (readJson(text) as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : '';
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
