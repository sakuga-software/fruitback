import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { screenshots } from './postgres-schema.ts';
import type { AttachmentStore, StoredAttachment } from './attachments.ts';

type Row = typeof screenshots.$inferSelect;

function attachmentOf(row: Row): StoredAttachment {
  return {
    id: row.id,
    workspace: row.workspace_id,
    account: row.account_id,
    site: row.site_id ?? '',
    name: row.name,
    type: row.content_type,
    content: row.content,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.seed_id === null ? {} : { seed: row.seed_id }),
    ...(row.before_transit ? { beforeTransit: true as const } : {}),
  };
}

/** The files of the notes in transit, in the database of the worker (FRU-331). See `attachments.ts`. */
export function createPostgresAttachmentStore(database: Database): AttachmentStore {
  return {
    async put(attachment) {
      await migrated(database);
      await database.run((db) =>
        db.insert(screenshots).values({
          id: attachment.id,
          workspace_id: attachment.workspace,
          account_id: attachment.account,
          site_id: attachment.site,
          name: attachment.name,
          content_type: attachment.type,
          content: attachment.content,
          created_at: attachment.createdAt,
          expires_at: attachment.expiresAt,
        }),
      );
    },
    async get(id, now) {
      await migrated(database);
      const [row] = await database.run((db) =>
        db
          .select()
          .from(screenshots)
          .where(and(eq(screenshots.id, id), gt(screenshots.expires_at, now)))
          .limit(1),
      );

      return row === undefined ? undefined : attachmentOf(row);
    },
    async heldBy(account, now) {
      await migrated(database);
      const [row] = await database.run((db) =>
        db
          .select({
            files: sql<number>`count(*)::integer`,
            bytes: sql<number>`coalesce(sum(octet_length(${screenshots.content})), 0)::bigint`,
          })
          .from(screenshots)
          .where(
            and(
              eq(screenshots.account_id, account),
              gt(screenshots.expires_at, now),
              eq(screenshots.before_transit, false),
            ),
          ),
      );

      // A sum of `bigint` comes back as a string from the driver: read as a number here, never as an instant.
      return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
    },
    async claim(ids, seed, now) {
      if (ids.length === 0) return [];
      await migrated(database);
      // One statement: two notes that name one file at the same moment cannot both take it.
      const rows = await database.run((db) =>
        db
          .update(screenshots)
          .set({ seed_id: seed })
          .where(
            and(
              inArray(screenshots.id, [...ids]),
              gt(screenshots.expires_at, now),
              or(isNull(screenshots.seed_id), eq(screenshots.seed_id, seed)),
            ),
          )
          .returning(),
      );
      const byId = new Map(rows.map((row) => [row.id, attachmentOf(row)]));

      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    async endAt(ids, at) {
      if (ids.length === 0) return;
      await migrated(database);
      await database.run((db) =>
        db
          .update(screenshots)
          .set({ expires_at: at })
          .where(and(inArray(screenshots.id, [...ids]), gt(screenshots.expires_at, at))),
      );
    },
    async remove(ids) {
      if (ids.length === 0) return;
      await migrated(database);
      await database.run((db) => db.delete(screenshots).where(inArray(screenshots.id, [...ids])));
    },
    async sweep(now) {
      await migrated(database);
      const gone = await database.run((db) =>
        db.delete(screenshots).where(lte(screenshots.expires_at, now)).returning({ id: screenshots.id }),
      );

      return gone.length;
    },
  };
}
