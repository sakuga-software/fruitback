import { type AccountStore, can, siteOrigin } from './accounts.ts';
import { parseJsonObject, readBoundedBytes } from './bounded-body.ts';
import { isExtensionOrigin } from './cors.ts';
import type { Kv } from './kv.ts';

/**
 * `POST /session/sites`: the extension adds the site of its tab to a workspace (FRU-255).
 *
 * **The first route that lets the token of an extension write.** So it asks more than the read beside
 * it, and everything it asks is read at this call, never from the token:
 *
 * - a session of an **account** (FRU-238); the session of a pairing names one workspace and stays
 *   a reader;
 * - an `Origin` that is an extension's, or none: a page of a site cannot hide its own;
 * - the **role** of the account in the workspace named, read now: `manage-sites` (owner, admin). Not
 *   a member answers like a workspace that does not exist (`404`), as the console does, and so does a
 *   suspended workspace (FRU-282);
 * - an origin over https, or on the loopback (the dev loop): a staging site on plain http is added
 *   from the console, where a person reads what they type;
 * - **`members` whatever the body says**: the popup says that visitors see nothing. `visibility` and
 *   `previews` are not read (Q4 of FRU-230: no preview without the proof of FRU-103);
 * - a site already in that workspace is given back as it is (`200`), its visibility untouched;
 * - ten sites an hour per account, counted before anything is written, a refused one too.
 */

/** A body of this route is two short strings. */
const MAX_BODY_BYTES = 2 * 1_024;

export const ADDS_PER_ACCOUNT = 10;
export const ADD_WINDOW_MS = 60 * 60 * 1000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type SiteAddContext = {
  accounts: AccountStore;
  kv: Kv;
  /** The account the access token names, already verified as a session of an account. */
  account: string;
};

type Answer = { status: number; body: unknown };

export async function addSessionSite(request: Request, context: SiteAddContext): Promise<Answer> {
  const origin = request.headers.get('Origin');
  if (origin !== null && !isExtensionOrigin(origin)) return { status: 403, body: { error: 'origin-not-allowed' } };

  const body = await bodyOf(request);
  if (body === undefined) return { status: 400, body: { error: 'invalid-body' } };

  // Counted before anything is read or written, as the connect routes count.
  const added = await context.kv.incr(`fruitback:add-site:${context.account}`, ADD_WINDOW_MS);
  if (added > ADDS_PER_ACCOUNT) return { status: 429, body: { error: 'rate-limited' } };

  const workspace = typeof body.workspace === 'string' && body.workspace.length <= 100 ? body.workspace : undefined;
  if (workspace === undefined || workspace === '') return { status: 400, body: { error: 'invalid-body' } };
  const site = typeof body.origin === 'string' ? addableOrigin(body.origin) : undefined;
  if (site === undefined) return { status: 400, body: { error: 'invalid-url' } };

  const role = await context.accounts.role(workspace, context.account);
  // A suspended workspace (FRU-282) answers as one that does not exist: `GET /session/sites` does not list it.
  if (role === undefined || (await context.accounts.suspension(workspace)) !== undefined) {
    return { status: 404, body: { error: 'not-found' } };
  }
  if (!can(role, 'manage-sites')) return { status: 403, body: { error: 'forbidden', role } };

  const existing = (await context.accounts.sites(workspace)).find((each) => each.origin === site);
  if (existing !== undefined) return { status: 200, body: { site: viewOf(existing, workspace) } };

  const made = await context.accounts.addSite(workspace, { origin: site, visibility: 'members' });

  return { status: 201, body: { site: viewOf(made, workspace) } };
}

/** The origin of the tab, as a site of a workspace: https, or the loopback over http. */
export function addableOrigin(value: string): string | undefined {
  if (value.length > 2_048) return undefined;
  const origin = siteOrigin(value);
  if (origin === undefined) return undefined;
  const { protocol, hostname } = new URL(origin);

  return protocol === 'https:' || LOOPBACK.has(hostname) ? origin : undefined;
}

function viewOf(site: { id: string; origin: string; visibility: string }, workspace: string) {
  return { id: site.id, origin: site.origin, visibility: site.visibility, workspace };
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const bytes = await readBoundedBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return undefined;
  return parseJsonObject(new TextDecoder().decode(bytes));
}
