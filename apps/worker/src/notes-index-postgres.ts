import type { SeedIssue, SeedStage } from '@fruitback/shared';
import { SEED_STAGES } from '@fruitback/shared';
import { and, count, eq, max, min, or, sql } from 'drizzle-orm';
import { type NoteEntry, type NoteIndex, type Place, type SiteNotes, excerptOf, noNotes } from './notes-index.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { connectors, deliveries, note_index } from './postgres-schema.ts';

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
    async record(entries, now) {
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
      const known = issues.filter((issue) => (SEED_STAGES as readonly string[]).includes(issue.stage));
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

    async forget(which) {
      const removed = await run((db) =>
        db.delete(note_index).where(selected(which)).returning({ site: note_index.site_id }),
      );

      return removed.length;
    },
  };
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
 */
function selected(which: Parameters<NoteIndex['forget']>[0]) {
  if ('account' in which) return eq(note_index.author_account_id, which.account);

  return (
    or(
      ...which.notes.map((note) => and(eq(note_index.reference, note.identifier), eq(note_index.seed_id, note.seed))),
    ) ?? sql`false`
  );
}
