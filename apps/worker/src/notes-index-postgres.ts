import type { SeedIssue, SeedStage } from '@fruitback/shared';
import { SEED_STAGES } from '@fruitback/shared';
import { and, count, eq, ilike, inArray, isNull, max, min, or, sql } from 'drizzle-orm';
import { member, user } from './auth-schema.ts';
import {
  type AuthorKind,
  type ForgetIndex,
  type ListedNote,
  type NoteEntry,
  type NoteIndex,
  type NoteQuery,
  type Place,
  type SiteNotes,
  excerptOf,
  noNotes,
} from './notes-index.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { connectors, deliveries, note_index, sites } from './postgres-schema.ts';

/** The index of the notes in the database of the worker (FRU-237). See `notes-index.ts`. */
export function createPostgresNoteIndex(database: Database): NoteIndex {
  const run = async <T>(work: (db: Parameters<Parameters<Database['run']>[0]>[0]) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };

  const placeColumns = (place: Place) =>
    place.kind === 'connector'
      ? { place: 'connector', connector_id: place.connector }
      : { place: 'fruitback', connector_id: null };

  return {
    async record(all, now) {
      // One row for one note: a second note of one site under the same id is the same note here.
      const entries = once(all, (entry) => `${entry.site}\n${entry.seed.id}`);
      if (entries.length === 0) return;
      await run((db) =>
        db
          .insert(note_index)
          .values(
            entries.map((entry: NoteEntry) => ({
              site_id: entry.site,
              seed_id: entry.seed.id,
              workspace_id: entry.workspace,
              page_url: entry.seed.page.url,
              excerpt: excerptOf(entry.seed.note),
              stage: entry.stage,
              channel: entry.channel,
              author_kind: entry.author.kind,
              author_account_id: entry.author.account ?? null,
              ...placeColumns(entry.place),
              reference: entry.issue.identifier,
              reference_url: entry.issue.url ?? null,
              // The instant the worker took it, not the one the widget wrote: nobody vouches for that one.
              created_at: now,
              checked_at: now,
            })),
          )
          // A second attempt of one note, or a note a read wrote first, is the same note.
          .onConflictDoNothing({ target: [note_index.site_id, note_index.seed_id] }),
      );
    },

    async refresh(workspace, site, place, issues, now) {
      // Two issues of one page can carry one seed id (two places of one team, or a widget that sent
      // one note twice). One statement cannot write one row twice, and would write nothing of the
      // page: the first is kept.
      const known = once(
        issues.filter((issue) => (SEED_STAGES as readonly string[]).includes(issue.stage)),
        (issue) => issue.seed.id,
      );
      if (known.length === 0) return;
      await run((db) =>
        db
          .insert(note_index)
          .values(
            known.map((issue: SeedIssue) => ({
              site_id: site,
              seed_id: issue.seed.id,
              workspace_id: workspace,
              page_url: issue.seed.page.url,
              excerpt: excerptOf(issue.seed.note),
              stage: issue.stage,
              // A note from before the index: what the read says, and nothing invented.
              channel: null,
              author_kind: issue.seed.reporter?.verified === true ? 'verified' : 'visitor',
              author_account_id: null,
              ...placeColumns(place),
              reference: issue.identifier,
              reference_url: issue.url ?? null,
              created_at: instantOf(issue.seed.createdAt, now),
              checked_at: now,
            })),
          )
          // A note it holds: the stage, and when the tracker said it. Nothing else of the row moves.
          .onConflictDoUpdate({
            target: [note_index.site_id, note_index.seed_id],
            set: { stage: sql`excluded.stage`, checked_at: sql`excluded.checked_at` },
            // A note of another workspace under the same ids is not this one.
            setWhere: eq(note_index.workspace_id, workspace),
          }),
      );
    },

    async authors(workspace, site, seeds) {
      if (seeds.length === 0) return new Map();
      const rows = await run((db) =>
        db
          .select({ seed: note_index.seed_id, account: note_index.author_account_id })
          .from(note_index)
          .where(
            and(
              eq(note_index.workspace_id, workspace),
              eq(note_index.site_id, site),
              eq(note_index.author_kind, 'member'),
              inArray(note_index.seed_id, [...new Set(seeds)]),
            ),
          ),
      );

      return new Map(rows.flatMap((row) => (row.account === null ? [] : [[row.seed, row.account] as const])));
    },

    async summary(workspace) {
      const rows = await run((db) =>
        db
          .select({
            site: note_index.site_id,
            stage: note_index.stage,
            notes: count(),
            last: max(note_index.created_at),
            checked: min(note_index.checked_at),
            script: sql<boolean>`bool_or(${note_index.channel} = 'script')`,
            extension: sql<boolean>`bool_or(${note_index.channel} = 'extension')`,
          })
          .from(note_index)
          .where(eq(note_index.workspace_id, workspace))
          .groupBy(note_index.site_id, note_index.stage),
      );

      const sites = new Map<string, SiteNotes & { last: number; checked: number; ways: Set<string> }>();
      for (const row of rows) {
        const site = sites.get(row.site) ?? {
          ...noNotes(),
          last: 0,
          checked: Number.POSITIVE_INFINITY,
          ways: new Set(),
        };
        if ((SEED_STAGES as readonly string[]).includes(row.stage))
          site.notes[row.stage as SeedStage] += Number(row.notes);
        site.last = Math.max(site.last, Number(row.last ?? 0));
        site.checked = Math.min(site.checked, Number(row.checked ?? Number.POSITIVE_INFINITY));
        if (row.script === true) site.ways.add('script');
        if (row.extension === true) site.ways.add('extension');
        sites.set(row.site, site);
      }

      return new Map(
        [...sites].map(([id, { last, checked, ways, ...notes }]) => [
          id,
          {
            ...notes,
            lastNoteAt: new Date(last).toISOString(),
            asOf: new Date(checked).toISOString(),
            via: (['script', 'extension'] as const).filter((way) => ways.has(way)),
          },
        ]),
      );
    },

    async undelivered(workspace) {
      // The body of a delivery is what was sent, as JSON: the site is in it, and nowhere else. A body
      // that is not JSON names no site, and does not stop the count of the others.
      const site = sql<string>`CASE WHEN pg_input_is_valid(${deliveries.body}, 'jsonb') THEN (${deliveries.body}::jsonb -> 'site' ->> 'id') END`;
      const rows = await run((db) =>
        db
          .select({ site, waiting: count() })
          .from(deliveries)
          .innerJoin(connectors, eq(connectors.id, deliveries.connector_id))
          .where(eq(connectors.workspace_id, workspace))
          .groupBy(site),
      );

      return new Map(rows.flatMap((row) => (row.site === null ? [] : [[row.site, Number(row.waiting)] as const])));
    },

    async forget(which, options = {}) {
      const columns = {
        site: note_index.site_id,
        seed: note_index.seed_id,
        pageUrl: note_index.page_url,
        excerpt: note_index.excerpt,
        reference: note_index.reference,
        createdAt: note_index.created_at,
      };
      const rows = await run((db) =>
        options.dryRun === true
          ? db.select(columns).from(note_index).where(selected(which)).orderBy(note_index.created_at)
          : db.delete(note_index).where(selected(which)).returning(columns),
      );

      return rows.map(({ reference, createdAt, ...row }) => ({
        ...row,
        ...(reference === null ? {} : { reference }),
        createdAt: Number(createdAt),
      }));
    },

    async list(workspace, query) {
      const keyOf = placeKey();
      return run(async (db) => {
        // The deliveries first: a few rows, read once, then matched to the notes by their key.
        const pending = await pendingOf(db, workspace);
        const narrowed = filtered(workspace, query);
        const placed = query.place === undefined ? narrowed : and(narrowed, placeIs(query.place));
        const after =
          query.after === undefined
            ? placed
            : and(
                placed,
                sql`(${note_index.created_at}, ${note_index.site_id} COLLATE "C", ${note_index.seed_id} COLLATE "C") < (${query.after.at}, ${query.after.site} COLLATE "C", ${query.after.seed} COLLATE "C")`,
              );
        const keys = [...pending.values()].map((delivery) => delivery.key);

        const [page, counted, undelivered] = await Promise.all([
          db
            .select({
              row: note_index,
              connector: { id: connectors.id, kind: connectors.kind, label: connectors.label },
              memberName: user.name,
              memberRole: member.role,
            })
            .from(note_index)
            .innerJoin(sites, eq(sites.id, note_index.site_id))
            .leftJoin(connectors, eq(connectors.id, note_index.connector_id))
            .leftJoin(
              member,
              and(eq(member.organizationId, note_index.workspace_id), eq(member.userId, note_index.author_account_id)),
            )
            .leftJoin(user, eq(user.id, member.userId))
            .where(after)
            // The order of `note_index_by_date`, so that a page reads its rows from it and stops.
            .orderBy(
              sql`${note_index.created_at} DESC NULLS LAST`,
              sql`${note_index.site_id} COLLATE "C" DESC`,
              sql`${note_index.seed_id} COLLATE "C" DESC`,
            )
            .limit(query.limit + 1),
          db
            .select({ key: keyOf, notes: count() })
            .from(note_index)
            .innerJoin(sites, eq(sites.id, note_index.site_id))
            .where(narrowed)
            .groupBy(keyOf),
          // The notes of the filter that have a delivery: those of its references, matched to their
          // key here. A list of tuples given to PostgreSQL was planned as a loop: 298 ms, measured.
          keys.length === 0
            ? Promise.resolve([])
            : db
                .select({
                  connector: note_index.connector_id,
                  site: note_index.site_id,
                  reference: note_index.reference,
                })
                .from(note_index)
                .innerJoin(sites, eq(sites.id, note_index.site_id))
                .where(
                  and(narrowed, sql`${note_index.reference} = ANY(${sql.param(keys.map((key) => key[2]))}::text[])`),
                ),
        ]);

        const byPlace = new Map(counted.map((row) => [row.key, Number(row.notes)] as const));
        const shown = page.slice(0, query.limit);
        const last = shown.at(-1);

        return {
          notes: shown.map((row) => listedOf({ ...row, delivery: pending.get(keyOfNote(row.row)) })),
          total:
            query.place === undefined
              ? [...byPlace.values()].reduce((sum, notes) => sum + notes, 0)
              : (byPlace.get(query.place) ?? 0),
          byPlace,
          undelivered: undelivered.filter((row) =>
            pending.has(JSON.stringify([row.connector, row.site, row.reference])),
          ).length,
          ...(page.length > query.limit && last !== undefined
            ? { next: { at: Number(last.row.created_at), site: last.row.site_id, seed: last.row.seed_id } }
            : {}),
        };
      });
    },

    async deliveryOf(workspace, site, seed) {
      return run(async (db) => {
        const [row] = await db
          .select()
          .from(note_index)
          .where(
            and(eq(note_index.workspace_id, workspace), eq(note_index.site_id, site), eq(note_index.seed_id, seed)),
          )
          .limit(1);
        if (row === undefined) return undefined;
        const delivery = (await pendingOf(db, workspace)).get(keyOfNote(row));

        return delivery === undefined ? undefined : { id: delivery.id, connector: delivery.connector };
      });
    },
  };
}

type Db = Parameters<Parameters<Database['run']>[0]>[0];

type Pending = {
  id: string;
  connector: string;
  attempts: number;
  nextAt: number | null;
  lastStatus: number | null;
  key: [string, string, string];
};

/** The key that ties a note to its delivery: its connector, its site, its reference. */
function keyOfNote(row: typeof note_index.$inferSelect): string {
  return JSON.stringify([row.connector_id, row.site_id, row.reference]);
}

/**
 * The deliveries of the connectors of a workspace that did not arrive, by the key of their note.
 *
 * A delivery holds no column for its note: its body, the JSON that was sent, names the site and the
 * reference the worker's store gave the note (`rest-connector.ts`). They are read here, from the
 * deliveries of one workspace only, which are few: one that arrived is removed. A body that is not
 * JSON names no note. One note has one delivery; should it have two, the newest is its own.
 *
 * Read in a statement of its own and matched in the worker: joined to the notes in SQL, the planner
 * read the bodies again for each note (528 ms for a page of 50 000 notes of one connector, measured).
 */
async function pendingOf(db: Db, workspace: string): Promise<Map<string, Pending>> {
  const body = sql`CASE WHEN pg_input_is_valid(${deliveries.body}, 'jsonb') THEN ${deliveries.body}::jsonb END`;
  const rows = await db
    .select({
      id: deliveries.id,
      connector: deliveries.connector_id,
      attempts: deliveries.attempts,
      nextAt: deliveries.next_at,
      lastStatus: deliveries.last_status,
      reference: sql<string | null>`(${body} ->> 'identifier')`,
      site: sql<string | null>`(${body} -> 'site' ->> 'id')`,
    })
    .from(deliveries)
    .innerJoin(connectors, eq(connectors.id, deliveries.connector_id))
    .where(eq(connectors.workspace_id, workspace))
    // Oldest first, so that the newest of one note is the one the map keeps.
    .orderBy(deliveries.created_at, deliveries.id);

  const pending = new Map<string, Pending>();
  for (const row of rows) {
    if (row.reference === null || row.site === null) continue;
    const key: [string, string, string] = [row.connector, row.site, row.reference];
    pending.set(JSON.stringify(key), {
      id: row.id,
      connector: row.connector,
      attempts: Number(row.attempts),
      nextAt: row.nextAt === null ? null : Number(row.nextAt),
      lastStatus: row.lastStatus === null ? null : Number(row.lastStatus),
      key,
    });
  }

  return pending;
}

/** The rows of one place: `fruitback`, a connector id, or `removed`. */
export function placeIs(place: string) {
  if (place === 'fruitback') return eq(note_index.place, 'fruitback');
  if (place === 'removed') return and(eq(note_index.place, 'connector'), isNull(note_index.connector_id));

  return eq(note_index.connector_id, place);
}

/** The place of a row, as `list` filters and counts it: `fruitback`, a connector id, or `removed`. */
function placeKey() {
  return sql<string>`CASE WHEN ${note_index.place} = 'fruitback' THEN 'fruitback' WHEN ${note_index.connector_id} IS NULL THEN 'removed' ELSE ${note_index.connector_id} END`;
}

/** The sites a caller may read: absent, every one; an empty list, none. */
function readable(sites: readonly string[] | undefined) {
  if (sites === undefined) return undefined;

  return sites.length === 0 ? sql`false` : inArray(note_index.site_id, [...sites]);
}

/** Every filter of a query but its place and its cursor. */
function filtered(workspace: string, query: NoteQuery) {
  return and(
    eq(note_index.workspace_id, workspace),
    readable(query.sites),
    query.site === undefined ? undefined : eq(note_index.site_id, query.site),
    query.stage === undefined ? undefined : eq(note_index.stage, query.stage),
    query.author === undefined ? undefined : eq(note_index.author_account_id, query.author),
    ...wordsOf(query.q).map((word) => {
      const like = `%${word.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

      return or(
        ilike(note_index.excerpt, like),
        ilike(note_index.page_url, like),
        ilike(sites.origin, like),
        ilike(note_index.stage, like),
        query.searchesReference === false ? undefined : ilike(note_index.reference, like),
      );
    }),
  );
}

/** The words of a search: each must be found, in any of the fields. At most eight. */
export function wordsOf(q: string | undefined): string[] {
  return (q ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
}

type PageRow = {
  row: typeof note_index.$inferSelect;
  connector: { id: string; kind: string; label: string } | null;
  memberName: string | null;
  memberRole: string | null;
  delivery: Pending | undefined;
};

function listedOf({ row, connector, memberName, memberRole, delivery }: PageRow): ListedNote {
  return {
    site: row.site_id,
    seed: row.seed_id,
    pageUrl: row.page_url,
    excerpt: row.excerpt,
    stage: row.stage,
    channel: row.channel === 'script' || row.channel === 'extension' ? row.channel : null,
    author: {
      kind: row.author_kind as AuthorKind,
      ...(row.author_account_id === null ? {} : { account: row.author_account_id }),
      ...(memberName === null || memberRole === null ? {} : { member: { name: memberName, role: memberRole } }),
    },
    place:
      row.place === 'fruitback'
        ? { kind: 'fruitback' }
        : { kind: 'connector', ...(connector === null ? {} : { connector }) },
    ...(row.reference === null ? {} : { reference: row.reference }),
    ...(row.reference_url === null ? {} : { referenceUrl: row.reference_url }),
    createdAt: Number(row.created_at),
    checkedAt: Number(row.checked_at),
    ...(delivery === undefined
      ? {}
      : {
          delivery: {
            id: delivery.id,
            attempts: Number(delivery.attempts),
            ...(delivery.nextAt === null ? {} : { nextAt: Number(delivery.nextAt) }),
            ...(delivery.lastStatus === null ? {} : { lastStatus: Number(delivery.lastStatus) }),
          },
        }),
  };
}

/** The first of each key, in order. */
function once<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

/**
 * The instant a note from before the index was left: the one the widget wrote, which is all there
 * is, and never later than now.
 */
function instantOf(iso: string, now: number): number {
  const at = Date.parse(iso);

  return Number.isFinite(at) ? Math.min(at, now) : now;
}

/**
 * The rows that `forget` removes. An empty list removes nothing.
 *
 * A note is named by its reference **and** the id the widget gave it: a reference alone is not one
 * note. `FB-12` of this worker's store is one, but a tracker of another workspace can call one of
 * its issues `FB-12` too, and its row is not a note this command deleted.
 *
 * `seeds` names the notes of a tracker by the id the widget gave them, on every site: that id is
 * all an operator reads in an issue, and a widget makes it at random for each note.
 */
function selected(which: ForgetIndex) {
  if ('seeds' in which) return which.seeds.length === 0 ? sql`false` : inArray(note_index.seed_id, [...which.seeds]);

  return (
    or(
      ...which.notes.map((note) => and(eq(note_index.reference, note.identifier), eq(note_index.seed_id, note.seed))),
    ) ?? sql`false`
  );
}
