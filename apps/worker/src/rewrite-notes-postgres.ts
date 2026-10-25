import { asc, eq } from 'drizzle-orm';
import type { Database } from './postgres.ts';
import { migrate } from './postgres-migrate.ts';
import { connectors, deliveries, notes } from './postgres-schema.ts';

/**
 * The part of `rewrite-notes` (FRU-378) that reads and writes the database: the rows of `notes` and
 * the bodies of `deliveries` that `rewrite` turns into the note of now. It knows no payload of before:
 * `rewrite-notes.ts` hands each conversion in, and is the one file that does.
 */

/** How many rows a table holds, and how many of them are rewritten (or would be, on a dry run). */
export type RowsRewritten = { rewritten: number; of: number };

export async function rewriteRows(
  database: Database,
  {
    payload,
    body,
    dryRun,
  }: { payload: (text: string) => string | undefined; body: (text: string) => string | undefined; dryRun: boolean },
): Promise<{ notes: RowsRewritten; deliveries: RowsRewritten }> {
  await migrate(database);

  const kept = await database.run((db) =>
    db.select({ id: notes.id, payload: notes.payload }).from(notes).orderBy(asc(notes.id)),
  );
  const keptNow = kept.flatMap((row) => {
    const next = payload(row.payload);

    return next === undefined ? [] : [{ id: row.id, payload: next }];
  });
  const queued = await database.run((db) =>
    db.select({ id: deliveries.id, body: deliveries.body }).from(deliveries).orderBy(asc(deliveries.id)),
  );
  const queuedNow = queued.flatMap((row) => {
    const next = body(row.body);

    return next === undefined ? [] : [{ id: row.id, body: next }];
  });

  if (!dryRun) {
    // One statement for each row: a run that stops leaves rows of now and rows of before, and the next
    // run takes the rows of before only.
    for (const row of keptNow) {
      await database.run((db) => db.update(notes).set({ payload: row.payload }).where(eq(notes.id, row.id)));
    }
    for (const row of queuedNow) {
      await database.run((db) => db.update(deliveries).set({ body: row.body }).where(eq(deliveries.id, row.id)));
    }
  }

  return {
    notes: { rewritten: keptNow.length, of: kept.length },
    deliveries: { rewritten: queuedNow.length, of: queued.length },
  };
}

/** The workspaces that hold a connector, whatever its kind. */
export async function workspacesWithConnectors(database: Database): Promise<string[]> {
  const rows = await database.run((db) => db.selectDistinct({ workspace: connectors.workspace_id }).from(connectors));

  return rows.map((row) => row.workspace);
}
