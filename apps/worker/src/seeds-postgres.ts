import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DEFAULT_SEED_STAGE, type Seed, type SeedIssue } from '@fruitback/shared';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { seed_comments, seeds } from './postgres-schema.ts';
import { forgetSelectorFor, identifierFor, noteOf, seedIdOf, threadsOf, toSeedIssue } from './seed-rows.ts';
import { type BatchAnswer, type CreatedIssue, type SeedStore, StoreError } from './store.ts';

/**
 * The notes in the database of the worker (FRU-218): `FRUITBACK_STORE=postgres`.
 *
 * The same store as `sqlite.ts`, on the tables `seeds` and `seed_comments`: the same columns, the
 * same `FB-<n>`, no page to open, and stages that are its own. `seed-rows.ts` reads a row of either.
 *
 * **One database holds the notes of every workspace, so every read names its site.** A worker on a
 * database takes its sites from it, and a call always names one. A read that names none gets the
 * notes that name none, and never the notes of a site: where `sqlite.ts` answers the whole page, this
 * would answer one workspace with the notes of another.
 *
 * Every failure is a `StoreError`: the worker answers `502 store-unavailable`, and the widget keeps
 * the note and tries again.
 */
export function createPostgresSeedStore(database: Database): SeedStore {
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
  const insert = async (db: Db, seed: Seed, now: number): Promise<CreatedIssue> => {
    const [row] = await db
      .insert(seeds)
      .values({
        client_id: seed.client?.id ?? null,
        page_url: seed.page.url,
        stage: DEFAULT_SEED_STAGE,
        seed: JSON.stringify(seed),
        created_at: now,
        updated_at: now,
      })
      .returning({ id: seeds.id });
    if (row === undefined) throw new StoreError('PostgreSQL kept a note and answered no number for it');

    // No `url`: see `CreatedIssue`. An empty string would be a link to the current page.
    return { id: String(row.id), identifier: identifierFor(row.id) };
  };

  return {
    name: 'postgres',
    // One database for every site. The worker keeps the client in the key of its read cache, which
    // is what stops two sites from sharing an entry.
    scope: () => 'postgres',
    create: (seed) => through('keep the note', ({ run }) => run((db) => insert(db, seed, Date.now()))),
    // One transaction: every note of the batch, or none, and then the `StoreError` that says so.
    // No parent: these notes are rows, not issues of a tracker.
    createBatch: (batch) =>
      through('keep the notes', ({ transaction }) =>
        transaction(async (tx) => {
          const now = Date.now();
          const answers: BatchAnswer[] = [];
          for (const seed of batch) answers.push({ issue: await insert(tx, seed, now) });

          return answers;
        }),
      ),
    findForPage: (query, _client, policy) =>
      through('read the notes', async ({ run }) => {
        const rows = await run((db) =>
          db
            .select({
              id: seeds.id,
              page_url: seeds.page_url,
              stage: seeds.stage,
              seed: seeds.seed,
              at: seeds.updated_at,
            })
            .from(seeds)
            .where(
              and(
                eq(seeds.page_url, query.url),
                // WARNING: without this clause a site reads the notes of every workspace of the worker.
                query.clientId === undefined ? isNull(seeds.client_id) : eq(seeds.client_id, query.clientId),
              ),
            )
            .orderBy(asc(seeds.id)),
        );
        // One statement for the replies of every note of the page, and none when the client hides them.
        const threads =
          policy.showComments && rows.length > 0
            ? threadsOf(
                (
                  await run((db) =>
                    db
                      .select()
                      .from(seed_comments)
                      .where(
                        inArray(
                          seed_comments.seed_id,
                          rows.map((row) => row.id),
                        ),
                      )
                      // The newest first for one note: the cap of `threadsOf` keeps the newest.
                      .orderBy(asc(seed_comments.seed_id), desc(seed_comments.created_at), desc(seed_comments.id)),
                  )
                ).map((row) => ({
                  id: row.id,
                  seed_id: row.seed_id,
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
              toSeedIssue(
                {
                  id: row.id,
                  page_url: row.page_url,
                  stage: row.stage,
                  seed: row.seed,
                  updatedAt: new Date(row.at).toISOString(),
                },
                policy.showComments ? (threads?.get(row.id) ?? []) : undefined,
              ),
            )
            .filter((issue): issue is SeedIssue => issue !== null)
        );
      }),
    // The notes of the whole instance, whatever their site (FRU-194 decides what a site may delete).
    // The rows are read and deleted in one transaction, and the replies go with their note: the
    // foreign key deletes them.
    forget: (which, options) =>
      through('forget the notes', ({ transaction }) =>
        transaction(async (tx) => {
          const selects = forgetSelectorFor(which);
          const found = (
            await tx
              .select({ id: seeds.id, page_url: seeds.page_url, seed: seeds.seed, created_at: seeds.created_at })
              .from(seeds)
              .orderBy(asc(seeds.id))
          ).filter(selects);

          if (!options.dryRun && found.length > 0) {
            await tx.delete(seeds).where(
              inArray(
                seeds.id,
                found.map((row) => row.id),
              ),
            );
          }

          return found.map((row) => ({
            identifier: identifierFor(row.id),
            seed: seedIdOf(row.seed),
            createdAt: new Date(row.created_at).toISOString(),
            pageUrl: row.page_url,
            note: noteOf(row.seed),
          }));
        }),
      ),
  };
}
