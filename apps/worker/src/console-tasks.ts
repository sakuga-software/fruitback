import { readJsonObject } from './bounded-body.ts';
import { json } from './http.ts';
import { invalidatePages, withoutTracker } from './note-helpers.ts';
import type { NotesContext } from './console-notes.ts';
import { notesOf, readLabel, readTaskChange, readTasksChange } from './task-fields.ts';
import { afterStatusMoved, ownKeyOf } from './console-status.ts';
import { withoutTrackerStatus } from './site-statuses.ts';

/**
 * The routes of the tasks the worker keeps (FRU-652), in the console:
 *
 * - `POST …/notes/<note>/task`: changes the assignee, the priority, the day, the labels, the place in
 *   its column and the archive, with the rights of the status (the author of the note, or a role that
 *   manages the sites). `DELETE …/notes/<note>/task` deletes it, with the same rights (FRU-665).
 * - `GET …/labels`: the labels of the workspace, for whoever reads its notes.
 * - `POST …/labels`, `POST …/labels/<id>` (a change), `DELETE …/labels/<id>`: for a role that manages the sites.
 *
 * - `POST …/tasks`, `{ notes, change }`: changes several tasks at once (FRU-656), and
 *   `POST …/tasks/delete`, `{ notes }`, deletes them. One call, one transaction, and every task with
 *   the rights of a change of one: one refusal changes none, and names the task in `note`.
 *
 * Every write answers `403 tasks-off` on a worker that keeps no task (FRU-651).
 */
export async function handleTasks(
  rest: string,
  request: Request,
  context: NotesContext,
  noteKeyOf: (id: string) => { site: string; note: string } | undefined,
): Promise<Response | undefined> {
  if (rest === '/tasks' || rest === '/tasks/delete') return handleSeveral(rest, request, context, noteKeyOf);
  const task = /^\/notes\/([A-Za-z0-9_-]+)\/task$/.exec(rest);
  const label = /^\/labels\/([A-Za-z0-9_-]+)$/.exec(rest);
  const one = /^\/notes\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (task === null && label === null && one === null && rest !== '/labels') return undefined;
  const { headers } = context;
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);

  // FRU-653: one note, whole, as its page reads it: the page of a task in the console.
  if (one !== null) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const note = noteKeyOf(one[1] as string);
    if (note === undefined || context.readNote === undefined) return json(404, { error: 'not-found' }, headers);
    const reach = await context.reach();
    if (reach === undefined || (reach.sites !== 'every' && !reach.sites.includes(note.site))) {
      return json(404, { error: 'not-found' }, headers);
    }
    const issue = await context.readNote(context.workspace, note.site, note.note);
    if (issue === undefined) return json(404, { error: 'not-found' }, headers);
    // A guest reads nothing of the tracker (FRU-244), as in the list.
    const shown = context.allowed('see-tracker') ? issue : withoutTrackerStatus(withoutTracker(issue, issue.note.id));

    return json(200, { note: shown }, headers);
  }
  const writes = request.method !== 'GET';
  if (writes && context.tasks === 'off') return json(403, { error: 'tasks-off' }, headers);

  if (task !== null) {
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return json(405, { error: 'method-not-allowed' }, headers);
    }
    const note = noteKeyOf(task[1] as string);
    if (note === undefined) return json(404, { error: 'not-found' }, headers);
    // A guest changes only the notes of the sites shared with them (FRU-250).
    const reach = await context.reach();
    if (reach === undefined || (reach.sites !== 'every' && !reach.sites.includes(note.site))) {
      return json(404, { error: 'not-found' }, headers);
    }
    const who = { account: context.account, manages: context.allowed('manage-sites') };
    // FRU-665: a task deleted for good, with its replies and its labels.
    if (request.method === 'DELETE') {
      const gone = await context.accounts.deleteTask(context.workspace, note.site, note.note, who);
      if (!gone.deleted) {
        if (gone.reason === 'not-found') return json(404, { error: 'not-found' }, headers);
        return json(403, { error: gone.reason === 'not-kept' ? 'fields-not-taken' : 'not-allowed' }, headers);
      }
      if (context.kv !== undefined) await invalidatePages(context.kv, [gone.page]);

      return new Response(null, { status: 204, headers });
    }
    const change = readTaskChange(await readJsonObject(request));
    if ('invalid' in change) return json(400, { error: 'invalid-task', field: change.invalid }, headers);
    const answer = await context.accounts.setTaskFields(context.workspace, note.site, note.note, change, who);
    if (!answer.set) {
      switch (answer.reason) {
        case 'not-found':
          return json(404, { error: 'not-found' }, headers);
        case 'not-allowed':
          return json(403, { error: 'not-allowed' }, headers);
        case 'not-kept':
          return json(403, { error: 'fields-not-taken' }, headers);
        case 'not-member':
        case 'unknown-label':
          return json(409, { error: answer.reason }, headers);
      }
    }
    if (context.kv !== undefined) await invalidatePages(context.kv, [answer.page]);

    return new Response(null, { status: 204, headers });
  }

  if (label === null) {
    if (request.method === 'GET')
      return json(200, { labels: await context.accounts.labels(context.workspace) }, headers);
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!context.allowed('manage-sites')) return json(403, { error: 'forbidden' }, headers);
    const read = readLabel(await readJsonObject(request));
    if ('invalid' in read) return json(400, { error: 'invalid-label', field: read.invalid }, headers);
    const added = await context.accounts.addLabel(context.workspace, read as { name: string; color: string });

    return added.added ? json(201, { label: added.label }, headers) : json(409, { error: 'label-taken' }, headers);
  }

  if (!context.allowed('manage-sites')) return json(403, { error: 'forbidden' }, headers);
  const id = label[1] as string;
  if (request.method === 'DELETE') {
    return (await context.accounts.removeLabel(context.workspace, id))
      ? new Response(null, { status: 204, headers })
      : json(404, { error: 'not-found' }, headers);
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const read = readLabel(await readJsonObject(request), true);
  if ('invalid' in read) return json(400, { error: 'invalid-label', field: read.invalid }, headers);
  const changed = await context.accounts.changeLabel(context.workspace, id, read);
  if (changed.changed) return json(200, { label: changed.label }, headers);

  return json(
    changed.reason === 'taken' ? 409 : 404,
    { error: changed.reason === 'taken' ? 'label-taken' : 'not-found' },
    headers,
  );
}

/** Why a change of several tasks was refused (FRU-656), as the route of one task says it. */
const REFUSED: Readonly<Record<string, { status: number; error: string }>> = {
  'not-found': { status: 404, error: 'not-found' },
  'not-allowed': { status: 403, error: 'not-allowed' },
  'not-kept': { status: 403, error: 'fields-not-taken' },
  'not-member': { status: 409, error: 'not-member' },
  'unknown-label': { status: 409, error: 'unknown-label' },
  'too-many-labels': { status: 409, error: 'too-many-labels' },
  'status-hidden': { status: 409, error: 'status-hidden' },
  // No such status of a site now: removed since the list was read, as far as a caller knows.
  'unknown-status': { status: 409, error: 'status-changed' },
};

/**
 * `POST …/tasks` and `POST …/tasks/delete` (FRU-656): several tasks in one call. The checks of the
 * route of one task, for each: the reach of a guest here, the rights and the rest in the store, in one
 * transaction.
 */
async function handleSeveral(
  rest: string,
  request: Request,
  context: NotesContext,
  noteKeyOf: (id: string) => { site: string; note: string } | undefined,
): Promise<Response> {
  const { headers } = context;
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  if (context.tasks === 'off') return json(403, { error: 'tasks-off' }, headers);
  const body = await readJsonObject(request);
  const removing = rest === '/tasks/delete';
  const read = removing ? notesOf(body) : readTasksChange(body);
  if (read === undefined) return json(400, { error: 'invalid-task', field: 'notes' }, headers);
  if ('invalid' in read) return json(400, { error: 'invalid-task', field: read.invalid }, headers);
  const ids = Array.isArray(read) ? read : read.notes;

  // The id of the console of each task, by its key: a refusal names the task as the list does.
  const idOf = new Map<string, string>();
  const tasks: { site: string; note: string }[] = [];
  for (const id of ids) {
    const key = noteKeyOf(id);
    if (key === undefined) return json(404, { error: 'not-found', note: id }, headers);
    idOf.set(JSON.stringify([key.site, key.note]), id);
    tasks.push(key);
  }
  // A guest changes only the notes of the sites shared with them (FRU-250).
  const reach = await context.reach();
  const out = tasks.find(
    (task) => reach === undefined || (reach.sites !== 'every' && !reach.sites.includes(task.site)),
  );
  if (out !== undefined)
    return json(404, { error: 'not-found', note: idOf.get(JSON.stringify([out.site, out.note])) }, headers);
  const who = { account: context.account, manages: context.allowed('manage-sites') };
  const refused = (reason: string, task: { site: string; note: string } | undefined) => {
    const { status, error } = REFUSED[reason] as { status: number; error: string };
    const note = task === undefined ? undefined : idOf.get(JSON.stringify([task.site, task.note]));

    return json(status, { error, ...(note === undefined ? {} : { note }) }, headers);
  };

  if (Array.isArray(read)) {
    const gone = await context.accounts.deleteTasks(context.workspace, tasks, who);
    if (!gone.deleted) return refused(gone.reason, gone.task);
    if (context.kv !== undefined) await invalidatePages(context.kv, gone.pages);

    return json(200, { deleted: tasks.length }, headers);
  }

  const { status, ...change } = read.change;
  let key: string | undefined;
  if (status !== undefined) {
    const own = ownKeyOf(status);
    if ('error' in own) return json(400, { error: own.error }, headers);
    key = own.key;
  }
  const answer = await context.accounts.changeTasks(
    context.workspace,
    tasks,
    key === undefined ? change : { ...change, status: key },
    who,
  );
  if (!answer.set) return refused(answer.reason, answer.task);
  if (context.kv !== undefined) await invalidatePages(context.kv, [...new Set(answer.notes.map((note) => note.page))]);
  for (const moved of answer.notes) {
    if (moved.stage !== undefined && moved.was !== undefined) {
      await afterStatusMoved(context, { ...moved, stage: moved.stage, was: moved.was });
    }
  }

  return json(200, { changed: answer.notes.length }, headers);
}
