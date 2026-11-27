import { and, asc, desc, eq, notInArray } from 'drizzle-orm';
import { newId } from './account-rows.ts';
import { member, user } from './auth-schema.ts';
import { NOTE_VERSION_LIMIT, type NoteVersion, type NoteVersionKind, type NoteVersions } from './note-versions.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { note_index, note_versions } from './postgres-schema.ts';

type Row = typeof note_versions.$inferSelect;

const KINDS: readonly NoteVersionKind[] = ['edit', 'delete'];

/** A row as a version, or `undefined` for a kind this worker does not know: it is not shown. */
function versionOf(row: Row, name: string | null, role: string | null): NoteVersion | undefined {
  const kind = KINDS.find((each) => each === row.kind);
  if (kind === undefined) return undefined;
  if (row.author_kind === 'visitor')
    return { id: row.id, kind, text: row.text, author: { kind: 'visitor' }, at: Number(row.at) };
  const account = row.author_account_id ?? undefined;

  return {
    id: row.id,
    kind,
    text: row.text,
    author: {
      kind: 'member',
      ...(account === undefined ? {} : { account }),
      ...(account === undefined || name === null || role === null ? {} : { member: { name, role } }),
    },
    at: Number(row.at),
  };
}

/** The versions of the notes (FRU-704), in the database of the worker. */
export function createPostgresNoteVersions(database: Database): NoteVersions {
  const thisNote = (site: string, note: string) =>
    and(eq(note_versions.site_id, site), eq(note_versions.note_id, note));

  return {
    async keep(version) {
      await migrated(database);

      // One transaction: the note is in the index of this workspace, the version is written, and the
      // oldest past the limit goes. Two edits at once keep both, then the limit holds again.
      return database.transaction(async (db) => {
        const [indexed] = await db
          .select({ note: note_index.note_id })
          .from(note_index)
          .where(
            and(
              eq(note_index.site_id, version.site),
              eq(note_index.note_id, version.note),
              eq(note_index.workspace_id, version.workspace),
            ),
          )
          .for('update');
        if (indexed === undefined) return undefined;
        const id = newId('ver');
        await db.insert(note_versions).values({
          id,
          site_id: version.site,
          note_id: version.note,
          workspace_id: version.workspace,
          kind: version.kind,
          text: version.text,
          author_kind: version.author.kind,
          author_account_id: version.author.kind === 'member' ? version.author.account : null,
          at: version.at,
        });
        const kept = db
          .select({ id: note_versions.id })
          .from(note_versions)
          .where(thisNote(version.site, version.note))
          .orderBy(desc(note_versions.at), desc(note_versions.id))
          .limit(NOTE_VERSION_LIMIT);
        await db
          .delete(note_versions)
          .where(and(thisNote(version.site, version.note), notInArray(note_versions.id, kept)));

        return id;
      });
    },

    async forget(site, note, id) {
      await migrated(database);
      await database.run((db) => db.delete(note_versions).where(and(thisNote(site, note), eq(note_versions.id, id))));
    },

    async list(workspace, site, note) {
      await migrated(database);
      const rows = await database.run((db) =>
        db
          .select({ row: note_versions, name: user.name, role: member.role })
          .from(note_versions)
          // The name an account has now, and its role, while it is a member of the workspace (FRU-244).
          .leftJoin(
            member,
            and(
              eq(member.organizationId, note_versions.workspace_id),
              eq(member.userId, note_versions.author_account_id),
            ),
          )
          .leftJoin(user, eq(user.id, member.userId))
          .where(and(eq(note_versions.workspace_id, workspace), thisNote(site, note)))
          .orderBy(asc(note_versions.at), asc(note_versions.id)),
      );

      return rows.flatMap(({ row, name, role }) => versionOf(row, name, role) ?? []);
    },
  };
}
