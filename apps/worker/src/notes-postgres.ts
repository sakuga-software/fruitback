import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DEFAULT_NOTE_STAGE, type Note, type NoteIssue, noteSchema } from '@fruitback/shared';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { note_comments, notes, sites, statuses } from './postgres-schema.ts';
import { OWN_SOURCE } from './site-statuses.ts';
import {
  forgetSelectorFor,
  identifierFor,
  readJson,
  stageOf,
  textOf,
  threadsOf,
  toNoteIssue,
  widgetIdOf,
} from './note-rows.ts';
import { checkText, editText, replyText } from './reply-text.ts';
import { type BatchAnswer, type CreatedIssue, type NoteStore, StoreError } from './store.ts';

/**
 * The notes in the database of the worker (FRU-218): `FRUITBACK_STORE=postgres`.
 *
 * The store of the SQLite file of before (FRU-31, gone with FRU-226), on the tables `notes` and
 * `note_comments`: the same columns, the same `FB-<n>`, no page to open, and stages that are its own.
 * `note-rows.ts` reads a row.
 *
 * **One database holds the notes of every workspace, so every read names its site.** A worker on a
 * database takes its sites from it, and a call always names one. A read that names none gets the
 * notes that name none, and never the notes of a site: the store of the file answered the whole page,
 * and here that would answer one workspace with the notes of another.
 *
 * Every failure is a `StoreError`: the worker answers `502 store-unavailable`, and the widget keeps
 * the note and tries again.
 */
export function createPostgresNoteStore(database: Database): NoteStore {
  /** `work` on the database with its schema, and its failure as the failure of a store. */
  const through = async <T>(what: string, work: (database: Database) => Promise<T>): Promise<T> => {
    try {
      await migrated(database);

      return await work(database);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      // The message of `postgres.ts`, which holds no address, no statement and no value.
      throw new StoreError(`PostgreSQL could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** One note written. `page.url` is already canonical: it is what the read asks for. */
  const insert = async (db: Db, note: Note, now: number): Promise<CreatedIssue> => {
    const [row] = await db
      .insert(notes)
      .values({
        client_id: note.client?.id ?? null,
        page_url: note.page.url,
        stage: DEFAULT_NOTE_STAGE,
        payload: JSON.stringify(note),
        created_at: now,
        updated_at: now,
      })
      .returning({ id: notes.id });
    if (row === undefined) throw new StoreError('PostgreSQL kept a note and answered no number for it');

    // No `url`: see `CreatedIssue`. An empty string would be a link to the current page.
    return { id: String(row.id), identifier: identifierFor(row.id) };
  };

  return {
    name: 'postgres',
    // One database for every site. The worker keeps the client in the key of its read cache, which
    // is what stops two sites from sharing an entry.
    scope: () => 'postgres',
    create: (note) => through('keep the note', ({ run }) => run((db) => insert(db, note, Date.now()))),
    // One transaction: every note of the batch, or none, and then the `StoreError` that says so.
    // No parent: these notes are rows, not issues of a tracker.
    createBatch: (batch) =>
      through('keep the notes', ({ transaction }) =>
        transaction(async (tx) => {
          const now = Date.now();
          const answers: BatchAnswer[] = [];
          for (const note of batch) answers.push({ issue: await insert(tx, note, now) });

          return answers;
        }),
      ),
    findForPage: (query, _client, policy) =>
      through('read the notes', async ({ run }) => {
        const rows = await run((db) =>
          db
            .select({
              id: notes.id,
              page_url: notes.page_url,
              stage: notes.stage,
              status_key: notes.status_key,
              payload: notes.payload,
              at: notes.updated_at,
            })
            .from(notes)
            .where(
              and(
                eq(notes.page_url, query.url),
                // WARNING: without this clause a site reads the notes of every workspace of the worker.
                query.clientId === undefined ? isNull(notes.client_id) : eq(notes.client_id, query.clientId),
              ),
            )
            .orderBy(asc(notes.id)),
        );
        // One statement for the replies of every note of the page, and none when the client hides them.
        const threads =
          policy.showComments && rows.length > 0
            ? threadsOf(
                (
                  await run((db) =>
                    db
                      .select()
                      .from(note_comments)
                      .where(
                        inArray(
                          note_comments.note_id,
                          rows.map((row) => row.id),
                        ),
                      )
                      // The newest first for one note: the cap of `threadsOf` keeps the newest.
                      .orderBy(asc(note_comments.note_id), desc(note_comments.created_at), desc(note_comments.id)),
                  )
                ).map((row) => ({
                  id: row.id,
                  note_id: row.note_id,
                  author: row.author,
                  body: row.body,
                  createdAt: new Date(row.created_at).toISOString(),
                })),
              )
            : undefined;

        return (
          rows
            // `undefined` when the worker was not asked for replies: the field is left out, and the
            // widget says nothing rather than that the team never answered.
            .map((row) =>
              toNoteIssue(
                {
                  id: row.id,
                  page_url: row.page_url,
                  stage: row.stage,
                  status_key: row.status_key,
                  payload: row.payload,
                  updatedAt: new Date(row.at).toISOString(),
                },
                policy.showComments ? (threads?.get(row.id) ?? []) : undefined,
              ),
            )
            .filter((issue): issue is NoteIssue => issue !== null)
        );
      }),
    // A reply in the table of the replies, under a note of this client only (FRU-257). The table has
    // no author for it: the name is in the text, as in a tracker.
    reply: (target, reply, _client, policy) =>
      through('keep the reply', ({ transaction }) =>
        transaction(async (tx) => {
          const id = Number(target.issue);
          if (!Number.isSafeInteger(id)) return undefined;
          const [note] = await tx
            .select({ id: notes.id })
            .from(notes)
            .where(
              and(
                eq(notes.id, id),
                target.clientId === undefined ? isNull(notes.client_id) : eq(notes.client_id, target.clientId),
              ),
            )
            .for('update');
          if (note === undefined) return undefined;
          const now = Date.now();
          const [row] = await tx
            .insert(note_comments)
            .values({ note_id: id, author: null, body: replyText(reply, policy.locale), created_at: now })
            .returning({ id: note_comments.id, body: note_comments.body });
          if (row === undefined) throw new StoreError('PostgreSQL kept a reply and answered no number for it');

          return { id: String(row.id), body: row.body, createdAt: new Date(now).toISOString() };
        }),
      ),
    // A verdict (FRU-294): « wrong » puts the note back to `new`, and the reply is written in the
    // same transaction. Both, or neither.
    check: (target, check, _client, policy) =>
      through('keep the verdict', ({ transaction }) =>
        transaction(async (tx) => {
          const id = Number(target.issue);
          if (!Number.isSafeInteger(id)) return undefined;
          const [note] = await tx
            .select({ id: notes.id, stage: notes.stage })
            .from(notes)
            .where(
              and(
                eq(notes.id, id),
                target.clientId === undefined ? isNull(notes.client_id) : eq(notes.client_id, target.clientId),
              ),
            )
            .for('update');
          if (note === undefined) return undefined;
          const now = Date.now();
          if (check.verdict === 'wrong') {
            // FRU-367: back to the built-in status of the first stage, so its status and its stage agree.
            await tx
              .update(notes)
              .set({ stage: DEFAULT_NOTE_STAGE, status_key: null, updated_at: now })
              .where(eq(notes.id, id));
          }
          const [row] = await tx
            .insert(note_comments)
            .values({ note_id: id, author: null, body: checkText(check, policy.locale), created_at: now })
            .returning({ id: note_comments.id, body: note_comments.body });
          if (row === undefined) throw new StoreError('PostgreSQL kept a verdict and answered no number for it');

          return {
            comment: { id: String(row.id), body: row.body, createdAt: new Date(now).toISOString() },
            stage: check.verdict === 'wrong' ? DEFAULT_NOTE_STAGE : stageOf(note.stage),
          };
        }),
      ),
    // FRU-367: the status of a note, and its stage with it, in one statement. The route says which
    // status, of this site, and who may; the store writes it and answers what it wrote.
    setStatus: (target, status) =>
      through('keep the status', ({ transaction }) =>
        transaction(async (tx) => {
          const id = Number(target.issue);
          if (!Number.isSafeInteger(id) || target.clientId === undefined) return undefined;
          // The site, shared: the console takes it for update to remove a status or move its stage
          // (FRU-366), so the status read below cannot change before this note is written (heavy
          // review of #492).
          const [site] = await tx
            .select({ id: sites.id })
            .from(sites)
            .where(eq(sites.id, target.clientId))
            .for('share');
          if (site === undefined) return undefined;
          // The status again, under that lock: a built-in one has the stage of its key, and a row of
          // its own only to rename, colour or hide it; one the team added has the stage of its row.
          const [row] = await tx
            .select({ stage: statuses.stage, hidden: statuses.hidden })
            .from(statuses)
            .where(
              and(
                eq(statuses.site_id, target.clientId),
                eq(statuses.source, OWN_SOURCE),
                eq(statuses.key, status.key ?? status.stage),
              ),
            );
          if (row?.hidden === true || (status.key !== null && row === undefined)) return 'status-changed' as const;
          const stage = status.key === null ? status.stage : stageOf(row?.stage ?? status.stage);
          // The stage before, under a lock of the row: two moves at once read it one after the other,
          // so only one of them moves the note into To do (FRU-468: one call of its trigger).
          const [before] = await tx
            .select({ stage: notes.stage })
            .from(notes)
            .where(and(eq(notes.id, id), eq(notes.client_id, target.clientId)))
            .for('update');
          if (before === undefined) return undefined;
          const [note] = await tx
            .update(notes)
            .set({ status_key: status.key, stage, updated_at: Date.now() })
            .where(and(eq(notes.id, id), eq(notes.client_id, target.clientId)))
            .returning({ stage: notes.stage, page: notes.page_url });

          return note === undefined
            ? undefined
            : { stage: stageOf(note.stage), was: stageOf(before.stage), page: note.page };
        }),
      ),
    // FRU-475: the text of a note that is still `new`, and the reply that says it was edited, in one
    // transaction. The row is taken for update: a status or a verdict written meanwhile waits, and
    // the stage read here is the one the edit is decided on.
    edit: (target, edit, _client, policy) =>
      through('keep the edit', ({ transaction }) =>
        transaction(async (tx) => {
          const id = Number(target.issue);
          if (!Number.isSafeInteger(id)) return undefined;
          const [row] = await tx
            .select({ stage: notes.stage, payload: notes.payload })
            .from(notes)
            .where(
              and(
                eq(notes.id, id),
                target.clientId === undefined ? isNull(notes.client_id) : eq(notes.client_id, target.clientId),
              ),
            )
            .for('update');
          if (row === undefined) return undefined;
          if (stageOf(row.stage) !== DEFAULT_NOTE_STAGE) return 'not-new' as const;
          // The note as it is kept, with its text changed and nothing else: a row that does not parse
          // is no note this store can answer for.
          const parsed = noteSchema.safeParse(readJson(row.payload));
          if (!parsed.success) return undefined;
          const note: Note = { ...parsed.data, text: edit.text };
          const now = Date.now();
          await tx
            .update(notes)
            .set({ payload: JSON.stringify(note), updated_at: now })
            .where(eq(notes.id, id));
          const [comment] = await tx
            .insert(note_comments)
            .values({ note_id: id, author: null, body: editText(edit, policy.locale), created_at: now })
            .returning({ id: note_comments.id, body: note_comments.body });
          if (comment === undefined) throw new StoreError('PostgreSQL kept an edit and answered no number for it');

          return {
            note,
            comment: { id: String(comment.id), body: comment.body, createdAt: new Date(now).toISOString() },
          };
        }),
      ),
    // The notes of the whole instance, whatever their site: the command of whoever runs the worker.
    // The rows are read and deleted in one transaction, and the replies go with their note: the
    // foreign key deletes them.
    forget: (which, options) =>
      through('forget the notes', ({ transaction }) =>
        transaction(async (tx) => {
          const selects = forgetSelectorFor(which);
          const found = (
            await tx
              .select({ id: notes.id, page_url: notes.page_url, payload: notes.payload, created_at: notes.created_at })
              .from(notes)
              .orderBy(asc(notes.id))
          ).filter(selects);

          if (!options.dryRun && found.length > 0) {
            await tx.delete(notes).where(
              inArray(
                notes.id,
                found.map((row) => row.id),
              ),
            );
          }

          return found.map((row) => ({
            identifier: identifierFor(row.id),
            id: widgetIdOf(row.payload),
            createdAt: new Date(row.created_at).toISOString(),
            pageUrl: row.page_url,
            text: textOf(row.payload),
          }));
        }),
      ),
  };
}
