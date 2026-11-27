import { type SQL, and, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { DAY_MS, DELETED_SWEEP_BATCH, type DeletedNotes } from './deleted-notes.ts';
import { keptRowOf } from './note-rows.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { connectors, done_notices, note_index, note_versions, notes, sites } from './postgres-schema.ts';

/** The instant before which a deletion of this site ran out: `now` less its days. */
const deadline = (now: number): SQL<number> =>
  sql<number>`${now} - ${sites.deleted_notes_keep_days}::bigint * ${DAY_MS}`;

/** A note its visitor deleted, and not erased yet. */
const deleted = and(isNotNull(note_index.removed_at), isNull(note_index.erased_at));

/** « Deleted notes » (FRU-704), in the database of the worker. */
export function createPostgresDeletedNotes(database: Database): DeletedNotes {
  const thisNote = (workspace: string, site: string, note: string) =>
    and(eq(note_index.workspace_id, workspace), eq(note_index.site_id, site), eq(note_index.note_id, note));

  return {
    async of(workspace, site, note, now) {
      await migrated(database);
      const [row] = await database.run((db) =>
        db
          .select({ removedAt: note_index.removed_at, days: sites.deleted_notes_keep_days })
          .from(note_index)
          .innerJoin(sites, eq(sites.id, note_index.site_id))
          .where(and(thisNote(workspace, site, note), deleted)),
      );
      if (row?.removedAt === null || row?.removedAt === undefined) return undefined;
      const until = Number(row.removedAt) + row.days * DAY_MS;

      return until > now ? { removedAt: Number(row.removedAt), until } : undefined;
    },

    async restore(workspace, site, note, now) {
      await migrated(database);
      // One statement: a sweep that erased it, or days that ran out, leave nothing to restore.
      const [row] = await database.run((db) =>
        db
          .update(note_index)
          .set({ removed_at: null })
          .from(sites)
          .where(
            and(
              eq(sites.id, note_index.site_id),
              thisNote(workspace, site, note),
              deleted,
              gt(note_index.removed_at, deadline(now)),
            ),
          )
          .returning({ page: note_index.page_url }),
      );

      return row === undefined ? undefined : { page: row.page };
    },

    async sweep(now) {
      await migrated(database);

      return database.transaction(async (db) => {
        // The notes whose days ran out, locked: a restore that comes at the same moment waits, then
        // finds nothing. A row another sweep holds is left to it.
        const due = await db
          .select({
            site: note_index.site_id,
            note: note_index.note_id,
            place: note_index.place,
            kind: connectors.kind,
            reference: note_index.reference,
          })
          .from(note_index)
          .innerJoin(sites, eq(sites.id, note_index.site_id))
          .leftJoin(connectors, eq(connectors.id, note_index.connector_id))
          .where(and(deleted, lte(note_index.removed_at, deadline(now))))
          .limit(DELETED_SWEEP_BATCH)
          .for('update', { of: note_index, skipLocked: true });
        if (due.length === 0) return 0;

        const kept = due.flatMap((row) => {
          const id = keptRowOf(row.place, row.kind, row.reference);

          return id === undefined ? [] : [{ ...row, id }];
        });
        const ofTracker = due.filter((row) => keptRowOf(row.place, row.kind, row.reference) === undefined);
        const pairs = (rows: readonly { site: string; note: string }[]) =>
          or(...rows.map((row) => and(eq(note_index.site_id, row.site), eq(note_index.note_id, row.note))));

        // The worker keeps it: the note goes whole, its replies and labels with it, then its row of the
        // index with its versions and the address that waited for it (`ON DELETE CASCADE`).
        if (kept.length > 0) {
          await db
            .delete(notes)
            .where(or(...kept.map((row) => and(eq(notes.id, row.id), eq(notes.client_id, row.site)))));
          await db.delete(note_index).where(pairs(kept));
        }
        // A tracker keeps it: the words the worker kept go, and the row stays to hide its issue.
        if (ofTracker.length > 0) {
          await db
            .delete(note_versions)
            .where(
              or(
                ...ofTracker.map((row) =>
                  and(eq(note_versions.site_id, row.site), eq(note_versions.note_id, row.note)),
                ),
              ),
            );
          await db
            .delete(done_notices)
            .where(
              or(
                ...ofTracker.map((row) => and(eq(done_notices.site_id, row.site), eq(done_notices.note_id, row.note))),
              ),
            );
          await db
            .update(note_index)
            .set({ excerpt: '', author_visitor: null, selector: null, component: null, erased_at: now })
            .where(pairs(ofTracker));
        }

        return due.length;
      });
    },
  };
}
