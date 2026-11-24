import { and, eq, inArray } from 'drizzle-orm';
import { newId } from './account-rows.ts';
import { type TaskEvent, taskEventBody } from './note-events.ts';
import { identifierFor } from './note-rows.ts';
import type { Db } from './postgres.ts';
import { connectors, deliveries, note_index, sites } from './postgres-schema.ts';

/** One change of a task: its row of `notes`, the id the widget gave the note, and the event. */
export type TaskChangeOf = { row: number; note: string; change: TaskEvent };

/**
 * Queues the events of the tasks of one site (FRU-660), **in the transaction that wrote them**: the
 * change and its event are kept together, or neither is. Each store that writes a status, a reply
 * or a field calls it, so every path emits: the console, `/mcp`, the extension, a change of many
 * tasks at once (one event for each task).
 *
 * Only a note sent to an address gets one: the row of the index that names it `FB-<row>` and the same
 * note, through a `rest` connector of the workspace of that row. A note with no destination, of a
 * tracker, or of a connector removed since gets none. The queue is the queue of `note.created`: the
 * same signature, the same attempts (`deliverDue`).
 */
export async function queueTaskEvents(
  db: Db,
  site: string,
  changes: readonly TaskChangeOf[],
  now: number,
): Promise<void> {
  if (changes.length === 0) return;
  const found = await db
    .select({
      reference: note_index.reference,
      note: note_index.note_id,
      workspace: note_index.workspace_id,
      connector: connectors.id,
      origin: sites.origin,
    })
    .from(note_index)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, note_index.connector_id),
        eq(connectors.workspace_id, note_index.workspace_id),
        eq(connectors.kind, 'rest'),
      ),
    )
    .innerJoin(sites, eq(sites.id, note_index.site_id))
    .where(
      and(
        eq(note_index.site_id, site),
        inArray(note_index.reference, [...new Set(changes.map((one) => identifierFor(one.row)))]),
      ),
    );
  const rows = changes.flatMap(({ row, note, change }) => {
    const identifier = identifierFor(row);
    const to = found.find((one) => one.reference === identifier && one.note === note);
    if (to === undefined) return [];

    return [
      {
        id: newId('dlv'),
        connector_id: to.connector,
        body: taskEventBody(change, {
          workspace: to.workspace,
          site,
          origin: to.origin,
          identifier,
          note,
          at: now,
        }),
        created_at: now,
        next_at: now,
        event: change.event,
      },
    ];
  });
  if (rows.length > 0) await db.insert(deliveries).values(rows);
}
