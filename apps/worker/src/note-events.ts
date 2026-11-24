import type { NoteStage } from '@fruitback/shared';
import type { DeliveryEvent } from './accounts.ts';
import { noteIdOf } from './console-notes.ts';
import { DELIVERY_VERSION } from './rest-connector.ts';

/**
 * What the author did to a note already sent to an address (FRU-605), as the address receives it:
 * `note.edited`, `note.moved` (another element of its page), or `note.withdrawn` (the note is closed,
 * and nothing is deleted). Identifiers only, as `agent.requested` (FRU-468): the address reads the note
 * of now by `/mcp` (`get_note` takes `note.id`), or keeps the one `note.created` sent. Never the text:
 * a person may edit a note to take out what they should not have written.
 */
export type NoteEvent = Extract<DeliveryEvent, 'note.edited' | 'note.moved' | 'note.withdrawn'>;

/** Where a note is, as each event of a note says it. */
type NoteOf = { workspace: string; site: string; origin?: string; identifier: string; note: string; at: number };

function eventFields(event: DeliveryEvent, of: NoteOf) {
  return {
    version: DELIVERY_VERSION,
    event,
    workspace: of.workspace,
    site: { id: of.site, ...(of.origin === undefined ? {} : { origin: of.origin }) },
    identifier: of.identifier,
    note: { id: noteIdOf(of.site, of.note) },
    at: new Date(of.at).toISOString(),
  };
}

export function noteEventBody(event: NoteEvent, of: NoteOf): string {
  return JSON.stringify(eventFields(event, of));
}

/**
 * The fields of a task that `note.updated` names (FRU-660), by the names of the console API, in this
 * order. The place in a column and the archive are not fields of the task: they emit nothing.
 */
export const TASK_EVENT_FIELDS = ['assignee', 'priority', 'labels', 'dueOn'] as const;
export type TaskEventField = (typeof TASK_EVENT_FIELDS)[number];

/**
 * What changed on a task the worker keeps and sent to an address (FRU-660), as the address receives
 * it. Identifiers and names only, as the events of FRU-605: the address reads the rest by `/mcp`.
 *
 * - `note.status_changed`: the status before and after, as `own:<key>` (the name `set_note_status`
 *   of `/mcp` takes), and the stage of each.
 * - `note.replied`: the id of the reply, as `get_note` answers it in the replies of the note.
 * - `note.updated`: the names of the fields that changed, never their values.
 */
export type TaskEvent =
  | {
      event: 'note.status_changed';
      status: { from: string; to: string };
      stage: { from: NoteStage; to: NoteStage };
    }
  | { event: 'note.replied'; reply: { id: string } }
  | { event: 'note.updated'; fields: TaskEventField[] };

export function taskEventBody(change: TaskEvent, of: NoteOf): string {
  const { event, ...detail } = change;

  return JSON.stringify({ ...eventFields(event, of), ...detail });
}

/** A status of the worker's store as `/mcp` names it: `own:<key>`, the stage for a built-in one. */
export function ownStatusName(key: string | null, stage: string): string {
  return `own:${key ?? stage}`;
}

/** The fields of `TASK_EVENT_FIELDS` whose value differs, in their order. Labels are compared as a set. */
export function changedTaskFields(
  before: { assignee: string | null; priority: string | null; dueOn: string | null; labels: readonly string[] },
  after: {
    assignee?: string | null;
    priority?: string | null;
    dueOn?: string | null;
    labels?: readonly string[];
  },
): TaskEventField[] {
  const sameLabels = (a: readonly string[], b: readonly string[]): boolean => {
    const set = new Set(a);

    return set.size === new Set(b).size && b.every((label) => set.has(label));
  };

  return TASK_EVENT_FIELDS.filter((field) => {
    if (field === 'labels') return after.labels !== undefined && !sameLabels(before.labels, after.labels);
    const value = after[field];

    return value !== undefined && value !== before[field];
  });
}
