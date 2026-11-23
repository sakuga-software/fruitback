import { readJsonObject } from './bounded-body.ts';
import { json } from './http.ts';
import { invalidatePages } from './note-helpers.ts';
import type { NotesContext } from './console-notes.ts';
import { readLabel, readTaskChange } from './task-fields.ts';

/**
 * The routes of the tasks the worker keeps (FRU-652), in the console:
 *
 * - `POST …/notes/<note>/task`: changes the assignee, the priority, the day, the labels, the place in
 *   its column and the archive, with the rights of the status (the author of the note, or a role that
 *   manages the sites). `DELETE …/notes/<note>/task` deletes it, with the same rights (FRU-665).
 * - `GET …/labels`: the labels of the workspace, for whoever reads its notes.
 * - `POST …/labels`, `POST …/labels/<id>` (a change), `DELETE …/labels/<id>`: for a role that manages the sites.
 *
 * Every write answers `403 tasks-off` on a worker that keeps no task (FRU-651).
 */
export async function handleTasks(
  rest: string,
  request: Request,
  context: NotesContext,
  noteKeyOf: (id: string) => { site: string; note: string } | undefined,
): Promise<Response | undefined> {
  const task = /^\/notes\/([A-Za-z0-9_-]+)\/task$/.exec(rest);
  const label = /^\/labels\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (task === null && label === null && rest !== '/labels') return undefined;
  const { headers } = context;
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);
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
