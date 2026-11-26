import { json } from './http.ts';
import type { AccountStore, Action, Reach } from './accounts.ts';
import type { NoteIndex } from './notes-index.ts';

/**
 * `GET /console/workspaces/<id>/rail` (FRU-711): the counts at the right of the entries of the bar of
 * the console, in one read that the frame asks for when it mounts and at each change of workspace,
 * never for each screen.
 *
 * ```json
 * { "sites": 4, "notes": 12, "failing": 2, "views": { "assigned": 4 } }
 * ```
 *
 * - `sites`: the sites the caller reads.
 * - `notes`: the notes of those sites that are not done nor closed, and not archived: the `total` of
 *   `GET …/notes?unresolved=1`.
 * - `views`: the count of each view of the bar (FRU-697), the `total` of the list with its filter:
 *   `assigned` is `assignee=me`.
 * - `failing`: the deliveries of the connectors that did not arrive yet, as the Connectors screen adds
 *   them up. For whoever sees the tracker only, as `GET …/connectors/<id>/deliveries`.
 *
 * **A guest counts what they read and nothing else** (FRU-250): the sites shared with them, and the
 * notes of those sites. No `failing`: a delivery names a connector, which a guest does not see.
 *
 * An index of the notes that does not answer costs `notes` and `views`, never the rest: the bar then
 * shows no count there, which is not a zero.
 */

export type RailContext = {
  workspace: string;
  account: string;
  allowed: (action: Action) => boolean;
  /** The role and the sites of the caller (FRU-250). */
  reach: () => Promise<Reach | undefined>;
  accounts: Pick<AccountStore, 'frameCounts'>;
  noteIndex: NoteIndex | undefined;
  headers: Record<string, string>;
};

/** The route, or `undefined` for another path. */
export async function handleRail(rest: string, request: Request, context: RailContext): Promise<Response | undefined> {
  if (rest !== '/rail') return undefined;
  const { headers } = context;
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);
  const reach = await context.reach();
  if (reach === undefined) return json(404, { error: 'not-found' }, headers);
  const only = reach.sites === 'every' ? undefined : reach.sites;

  const [counted, notes] = await Promise.all([
    context.accounts.frameCounts(context.workspace, only),
    indexed(() =>
      context.noteIndex?.frameCounts(context.workspace, {
        account: context.account,
        ...(only === undefined ? {} : { sites: only }),
      }),
    ),
  ]);

  return json(
    200,
    {
      sites: counted.sites,
      ...(notes === undefined ? {} : { notes: notes.open, views: { assigned: notes.assigned } }),
      ...(context.allowed('see-tracker') ? { failing: counted.waiting } : {}),
    },
    headers,
  );
}

/** What the index answers, or nothing when it does not answer: said in the log. */
async function indexed<T>(read: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  }
}
