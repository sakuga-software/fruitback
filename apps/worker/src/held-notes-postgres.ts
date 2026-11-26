import { type SQL, and, count, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { noteSchema } from '@fruitback/shared';
import { HELD_CLAIM_MS, HELD_NOTE_KEEP_MS, HELD_NOTE_LIST, type HeldNote, type HeldNotes } from './held-notes.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { held_notes } from './postgres-schema.ts';

type Row = typeof held_notes.$inferSelect;

/**
 * A row as a held note, or `undefined` for a payload that is no note any more: it is never sent to a
 * place, and it goes with the sweep.
 */
function heldOf(row: Row): HeldNote | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return undefined;
  }
  const parsed = noteSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  return {
    site: row.site_id,
    workspace: row.workspace_id,
    note: parsed.data,
    ...(row.author_visitor === null ? {} : { visitor: row.author_visitor }),
    heldAt: Number(row.held_at),
  };
}

/** The notes of visitors that wait for a member (FRU-704), in the database of the worker. */
export function createPostgresHeldNotes(database: Database): HeldNotes {
  const run = async <T>(work: (db: Parameters<Parameters<Database['run']>[0]>[0]) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };
  /** Nobody is sending it: no claim, or one that ran out. */
  const free = (now: number): SQL | undefined =>
    or(isNull(held_notes.claimed_until), lte(held_notes.claimed_until, now));
  /** The notes of the queue of a workspace that did not wait too long and nobody is sending, on these sites. */
  const waiting = (workspace: string, sites: readonly string[] | undefined, now: number): SQL | undefined =>
    and(
      eq(held_notes.workspace_id, workspace),
      gt(held_notes.held_at, now - HELD_NOTE_KEEP_MS),
      free(now),
      ...(sites === undefined ? [] : [inArray(held_notes.site_id, [...sites])]),
    );
  const thisNote = (site: string, note: string) => and(eq(held_notes.site_id, site), eq(held_notes.note_id, note));

  return {
    async hold(held) {
      const written = await run((db) =>
        db
          .insert(held_notes)
          .values({
            site_id: held.site,
            note_id: held.note.id,
            workspace_id: held.workspace,
            payload: JSON.stringify(held.note),
            author_visitor: held.visitor ?? null,
            held_at: held.heldAt,
          })
          .onConflictDoNothing({ target: [held_notes.site_id, held_notes.note_id] })
          .returning({ note: held_notes.note_id }),
      );

      return written.length > 0;
    },

    async list(workspace, sites, now) {
      if (sites !== undefined && sites.length === 0) return [];
      const rows = await run((db) =>
        db
          .select()
          .from(held_notes)
          .where(waiting(workspace, sites, now))
          .orderBy(desc(held_notes.held_at), desc(held_notes.note_id))
          .limit(HELD_NOTE_LIST),
      );

      return rows.flatMap((row) => heldOf(row) ?? []);
    },

    async count(workspace, sites, now) {
      if (sites !== undefined && sites.length === 0) return 0;
      const [row] = await run((db) =>
        db
          .select({ count: count() })
          .from(held_notes)
          .where(waiting(workspace, sites, now)),
      );

      return Number(row?.count ?? 0);
    },

    async take(workspace, site, note, now) {
      // One statement claims the row: a second member who answers at the same moment finds nothing.
      const [row] = await run((db) =>
        db
          .update(held_notes)
          .set({ claimed_until: now + HELD_CLAIM_MS })
          .where(
            and(
              eq(held_notes.workspace_id, workspace),
              thisNote(site, note),
              gt(held_notes.held_at, now - HELD_NOTE_KEEP_MS),
              free(now),
            ),
          )
          .returning(),
      );

      return row === undefined ? undefined : heldOf(row);
    },

    async done(site, note) {
      await run((db) => db.delete(held_notes).where(thisNote(site, note)));
    },

    async release(site, note) {
      await run((db) => db.update(held_notes).set({ claimed_until: null }).where(thisNote(site, note)));
    },

    async sweep(now) {
      const gone = await run((db) =>
        db
          .delete(held_notes)
          .where(lte(held_notes.held_at, now - HELD_NOTE_KEEP_MS))
          .returning({ note: held_notes.note_id }),
      );

      return gone.length;
    },
  };
}
