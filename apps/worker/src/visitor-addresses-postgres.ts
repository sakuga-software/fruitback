import { and, eq } from 'drizzle-orm';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { held_notes, note_index, visitor_addresses } from './postgres-schema.ts';
import type { VisitorAddresses } from './visitor-addresses.ts';

/** The confirmed browsers of the sites (FRU-705), in the database of the worker. */
export function createPostgresVisitorAddresses(database: Database): VisitorAddresses {
  const run = async <T>(work: (db: Parameters<Parameters<Database['run']>[0]>[0]) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };

  return {
    async identityOf(site, visitor) {
      const rows = await run((db) =>
        db
          .select({ identity: visitor_addresses.identity })
          .from(visitor_addresses)
          .where(and(eq(visitor_addresses.site_id, site), eq(visitor_addresses.visitor, visitor))),
      );

      return rows[0]?.identity;
    },

    async confirm(site, visitor, identity, now) {
      await run((db) =>
        db.transaction(async (tx) => {
          await tx
            .insert(visitor_addresses)
            .values({ site_id: site, visitor, identity, confirmed_at: now })
            .onConflictDoUpdate({
              target: [visitor_addresses.site_id, visitor_addresses.visitor],
              set: { identity, confirmed_at: now },
            });
          // The notes this browser left on the site, and those that wait for a member, are the notes of
          // the address now. Only those of a visitor: a note a session or the site signed keeps its author.
          await tx
            .update(note_index)
            .set({ author_visitor: identity })
            .where(
              and(
                eq(note_index.site_id, site),
                eq(note_index.author_kind, 'visitor'),
                eq(note_index.author_visitor, visitor),
              ),
            );
          await tx
            .update(held_notes)
            .set({ author_visitor: identity })
            .where(and(eq(held_notes.site_id, site), eq(held_notes.author_visitor, visitor)));
        }),
      );
    },
  };
}
