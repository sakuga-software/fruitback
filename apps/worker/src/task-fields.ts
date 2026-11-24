/**
 * The fields of a task the worker keeps (FRU-652): who does it, how urgent it is, by when, and its
 * labels. They belong to the worker and not to the note contract: the widget neither writes nor
 * reads them.
 */

/** From the least urgent to the most. A task with no priority has none of them. */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskLabel = { id: string; name: string; color: string };

/** The fields of one task, as the console reads them. An absent field is not set. */
export type TaskFields = {
  assignee?: { id: string; name: string };
  priority?: TaskPriority;
  /** A day, `YYYY-MM-DD`, with no time and no zone. */
  dueOn?: string;
  labels: TaskLabel[];
  /** FRU-665: where it sits in its column, smaller first. Absent: by its date, the newest first. */
  position?: number;
  /** FRU-665: archived, out of the lists until it is brought back. */
  archived?: true;
};

/** A change of the fields: a field left out does not change, `null` clears it. */
export type TaskChange = {
  assignee?: string | null;
  priority?: TaskPriority | null;
  dueOn?: string | null;
  labels?: string[];
  position?: number;
  archived?: boolean;
};

/**
 * One change for several tasks at once (FRU-656): the fields of `TaskChange` that mean the same for
 * every task, a status (a key of the worker's store, which each site must have), and labels to put on
 * and to take off, which keep the other labels of each task. No place: a place is of one column.
 */
export type TasksChange = Omit<TaskChange, 'labels' | 'position'> & {
  status?: string;
  addLabels?: string[];
  removeLabels?: string[];
};

const LABEL_NAME_MAX = 40;
/** The labels a task holds at most. */
export const MAX_LABELS = 20;
/** The tasks one call of `POST …/tasks` changes at most: four pages of the list of the console. */
export const MAX_TASKS = 100;
const COLOR = /^#[0-9a-f]{6}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/** Whether `value` is a day of the calendar, `2026-02-30` refused. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A change read from a body, or the name of the first field that is wrong. */
export function readTaskChange(body: Record<string, unknown> | undefined): TaskChange | { invalid: string } {
  if (body === undefined) return { invalid: 'body' };
  const change: TaskChange = {};
  if ('assignee' in body) {
    if (body.assignee !== null && (typeof body.assignee !== 'string' || body.assignee === '')) {
      return { invalid: 'assignee' };
    }
    change.assignee = body.assignee;
  }
  if ('priority' in body) {
    if (body.priority !== null && !isPriority(body.priority)) return { invalid: 'priority' };
    change.priority = body.priority;
  }
  if ('dueOn' in body) {
    if (body.dueOn !== null && !isDay(body.dueOn)) return { invalid: 'dueOn' };
    change.dueOn = body.dueOn;
  }
  if ('labels' in body) {
    const labels = labelIdsOf(body.labels);
    if (labels === undefined) return { invalid: 'labels' };
    change.labels = labels;
  }
  if ('position' in body) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) return { invalid: 'position' };
    change.position = body.position;
  }
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') return { invalid: 'archived' };
    change.archived = body.archived;
  }
  if (Object.keys(change).length === 0) return { invalid: 'body' };

  return change;
}

/** Labels named by id, each once, at most `MAX_LABELS`; `undefined` when they are not that. */
function labelIdsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LABELS) return undefined;
  if (value.some((label) => typeof label !== 'string' || label === '')) return undefined;

  return [...new Set(value as string[])];
}

/**
 * The body of `POST …/tasks` (FRU-656): `notes`, the ids of the list of the console, each once, from
 * 1 to `MAX_TASKS`; and `change`, the fields of `TaskChange` but the labels and the place, `status`
 * (`own:<key>`, as the route of the status of one note takes it), `addLabels` and `removeLabels`.
 * Or the name of the first field that is wrong.
 */
export function readTasksChange(
  body: Record<string, unknown> | undefined,
): { notes: string[]; change: TasksChange } | { invalid: string } {
  const notes = notesOf(body);
  if (notes === undefined) return { invalid: 'notes' };
  const asked = body?.change;
  if (typeof asked !== 'object' || asked === null || Array.isArray(asked)) return { invalid: 'change' };
  const { status, addLabels, removeLabels, labels, position, ...fields } = asked as Record<string, unknown>;
  if (labels !== undefined) return { invalid: 'labels' };
  if (position !== undefined) return { invalid: 'position' };
  const change: TasksChange = {};
  if (Object.keys(fields).length > 0) {
    const read = readTaskChange(fields);
    if ('invalid' in read) return read;
    Object.assign(change, read);
  }
  if (status !== undefined) {
    if (typeof status !== 'string' || status === '') return { invalid: 'status' };
    change.status = status;
  }
  for (const [name, value] of [
    ['addLabels', addLabels],
    ['removeLabels', removeLabels],
  ] as const) {
    if (value === undefined) continue;
    const ids = labelIdsOf(value);
    if (ids === undefined) return { invalid: name };
    change[name] = ids;
  }
  // A label both put on and taken off says nothing that one call can do.
  if (change.addLabels?.some((label) => change.removeLabels?.includes(label)) === true) {
    return { invalid: 'removeLabels' };
  }
  if (Object.keys(change).length === 0) return { invalid: 'change' };

  return { notes, change };
}

/** `notes` of a body of `POST …/tasks` or `…/tasks/delete`: 1 to `MAX_TASKS` ids, each once. */
export function notesOf(body: Record<string, unknown> | undefined): string[] | undefined {
  const notes = body?.notes;
  if (!Array.isArray(notes) || notes.length === 0 || notes.length > MAX_TASKS) return undefined;
  if (notes.some((note) => typeof note !== 'string' || note === '')) return undefined;

  return [...new Set(notes as string[])];
}

/** A label read from a body: a name of 1 to 40 characters once trimmed, and a colour `#rrggbb`. */
export function readLabel(
  body: Record<string, unknown> | undefined,
  partial = false,
): { name?: string; color?: string } | { invalid: string } {
  const label: { name?: string; color?: string } = {};
  if (body?.name !== undefined || !partial) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '' || [...name].length > LABEL_NAME_MAX) return { invalid: 'name' };
    label.name = name;
  }
  if (body?.color !== undefined || !partial) {
    if (typeof body?.color !== 'string' || !COLOR.test(body.color)) return { invalid: 'color' };
    label.color = body.color.toLowerCase();
  }
  if (partial && Object.keys(label).length === 0) return { invalid: 'body' };

  return label;
}
