import { type AccountStore, type Action, readableSites, readsSite } from './accounts.ts';
import type { HeldSent } from './feedback-routes.ts';
import { type HeldNote, type HeldNotes } from './held-notes.ts';
import { json } from './http.ts';

/**
 * The queue « To approve » of a workspace (FRU-704): the notes of visitors that wait for a member, on
 * a site that says « Hold new visitor notes ».
 *
 * - `GET …/held`: the notes, newest first, of the sites the caller reads.
 * - `GET …/held/count`: how many, for the entry of the sidebar.
 * - `POST …/held/<site>/<note>/approve`: the note goes to its place, as it would have gone at once;
 *   `200` with its issue. The place refused or did not answer: the note waits again, `502` with why.
 * - `POST …/held/<site>/<note>/reject`: the note goes, and is sent nowhere; `204`.
 *
 * Who: a role that sees the tracker (`see-tracker`: a member, an admin, an owner), on a site it reads.
 * A guest reads no note of a visitor that the site did not publish. A note another member answered a
 * moment before is `404`: one statement takes it out of the queue (`HeldNotes.take`).
 */
export type HeldContext = {
  workspace: string;
  account: string;
  allowed: (action: Action) => boolean;
  accounts: AccountStore;
  held: HeldNotes | undefined;
  /** Sends one approved note to its place: `sendHeldNote` of `feedback-routes.ts`, through `app.ts`. */
  send: ((held: HeldNote) => Promise<HeldSent>) | undefined;
  now: number;
  headers: Record<string, string>;
};

const ANSWER = /^\/held\/([A-Za-z0-9_-]{1,100})\/([^/]{1,200})\/(approve|reject)$/u;

/** One note of the queue, as the console shows it. */
function viewOf(held: HeldNote, origins: ReadonlyMap<string, string>) {
  const name = held.note.reporter?.name;

  return {
    site: held.site,
    ...(origins.has(held.site) ? { origin: origins.get(held.site) } : {}),
    note: held.note.id,
    page: held.note.page.url,
    text: held.note.text,
    ...(name === undefined || name === '' ? {} : { name }),
    heldAt: held.heldAt,
  };
}

export async function handleHeld(rest: string, request: Request, context: HeldContext): Promise<Response | undefined> {
  const answer = ANSWER.exec(rest);
  if (rest !== '/held' && rest !== '/held/count' && answer === null) return undefined;
  const { workspace, account, allowed, accounts, held, send, now, headers } = context;
  if (!allowed('see-tracker')) return json(403, { error: 'forbidden' }, headers);
  const reach = await accounts.reach(workspace, account);
  if (reach === undefined) return json(404, { error: 'not-found' }, headers);
  const only = reach.sites === 'every' ? undefined : reach.sites;

  if (answer === null) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (held === undefined) return json(200, rest === '/held' ? { notes: [] } : { count: 0 }, headers);
    if (rest === '/held/count') return json(200, { count: await held.count(workspace, only, now) }, headers);
    const sites = readableSites(await accounts.sites(workspace), reach);
    const origins = new Map(sites.map((site) => [site.id, site.origin]));

    return json(200, { notes: (await held.list(workspace, only, now)).map((each) => viewOf(each, origins)) }, headers);
  }

  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const [, site = '', encoded = '', verb] = answer;
  let note: string;
  try {
    note = decodeURIComponent(encoded);
  } catch {
    return json(404, { error: 'not-found' }, headers);
  }
  if (!readsSite(reach, site) || held === undefined) return json(404, { error: 'not-found' }, headers);
  const taken = await held.take(workspace, site, note, now);
  if (taken === undefined) return json(404, { error: 'not-found' }, headers);
  const { claim } = taken;
  if (verb === 'reject') {
    await held.done(site, note, claim);

    return new Response(null, { status: 204, headers });
  }

  // The row stays, claimed, until the note is in its place: a failure, a throw or a process that stops
  // leaves it in the queue (review of #987).
  let sent: HeldSent;
  try {
    sent = send === undefined ? { ok: false, reason: 'store-unavailable' } : await send(taken);
  } catch (error) {
    await quietly(held.release(site, note, claim), site);
    throw error;
  }
  if (sent.ok) {
    // The note is in its place: the answer says so whatever comes next. A database that does not take
    // the removal is asked once more, then the row stays claimed for an hour (review of #987).
    await held
      .done(site, note, claim)
      .catch(() => held.done(site, note, claim))
      .catch((error: unknown) => {
        console.error(`[fruitback] an approved note of site ${site} stays in the queue: ${String(error)}`);
      });
    const { identifier, url } = sent.issue;

    return json(200, { issue: { identifier, ...(url === undefined ? {} : { url }) } }, headers);
  }
  // The site took no note any more: it goes with nobody to send it to. Else it waits again.
  if (sent.reason === 'site-gone') {
    await quietly(held.done(site, note, claim), site);

    return json(409, { error: 'site-gone' }, headers);
  }
  await quietly(held.release(site, note, claim), site);

  return json(502, { error: sent.reason }, headers);
}

/**
 * A step of the queue after the answer is known (review of #987): a database that does not take it
 * leaves the row claimed for an hour, and the answer stays what happened to the note. A reject is not
 * one: a row that did not go was not rejected, and its error goes up.
 */
async function quietly(step: Promise<void>, site: string): Promise<void> {
  await step.catch((error: unknown) => {
    console.error(`[fruitback] a note of site ${site} stays claimed in the queue: ${String(error)}`);
  });
}
