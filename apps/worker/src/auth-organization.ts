import { type AccountStore, type Workspace, can } from './accounts.ts';
import { newId } from './account-rows.ts';
import { AUTH_BASE_PATH, type Auth } from './auth.ts';
import { type AuthRouteContext, AuthUnavailable, headersFor, mutationAllowed, sessionOfCookie } from './auth-routes.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { ORGANIZATION_PATHS, type OrganizationRule, readOrganizationInput } from './organization-paths.ts';
import type { SessionStore } from './session.ts';

/**
 * The routes of the organization plugin of better-auth, under `/console/auth/organization/` (FRU-149).
 *
 * **better-auth is the second reader of each call, never the first.** Before it reads a request, the
 * worker has checked, in this order:
 *
 * 1. the path is one of `ORGANIZATION_PATHS`, and the method is the one of its rule: else `404`, `405`;
 * 2. the cookie is a session: else `401`;
 * 3. a call that changes something comes from the console: else `403` (`mutationAllowed`);
 * 4. the request holds the fields of the rule and no other, and names its workspace: else `400`;
 * 5. the caller has **one** role in that workspace, read by `accounts.role`, which reads `guest,admin`
 *    as no role: else `404`, as for a workspace that does not exist;
 * 6. that role may do what the rule needs, by `can`: else `403`.
 *
 * Then better-auth is handed a request that the worker wrote, with those fields. Its own checks stay:
 * the last owner, the permission of the role, the workspace of the member that is named.
 *
 * What a guest does not read is point 6 on `list-members`, and the routes that are not in the list.
 */

export type OrganizationRouteContext = Pick<AuthRouteContext, 'consoleUrl' | 'clientIp' | 'trackIp'> & {
  auth: Auth | Promise<Auth>;
  accounts: Pick<AccountStore, 'role'>;
  sessions: Pick<SessionStore, 'endSessionsOf'>;
};

const PREFIX = `${AUTH_BASE_PATH}/organization/`;

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * What the caller sent: the query of a `GET`, the body of a `POST`. `undefined`: not an object.
 * `'too-large'`: a body over the cap of the worker, which is not read to its end.
 */
async function sentBy(
  request: Request,
  rule: OrganizationRule,
): Promise<Record<string, unknown> | 'too-large' | undefined> {
  if (rule.method === 'GET') {
    const query = new URL(request.url).searchParams;
    const sent: Record<string, unknown> = {};
    for (const name of new Set(query.keys())) {
      const values = query.getAll(name);
      // A field given twice: better-auth and the worker could each read another one.
      if (values.length !== 1) return undefined;
      sent[name] = values[0];
    }

    return sent;
  }

  const text = await readBoundedText(request);
  if (text === null) return 'too-large';
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer for a path of the organization plugin, or `undefined` for another path.
 *
 * `paths` is the list of the open routes. A test gives a shorter one, and the route it left out
 * answers `404`.
 *
 * WARNING: like `handleAuthRoutes`, this rejects when better-auth does. The caller answers `502`.
 */
export async function handleOrganizationRoutes(
  request: Request,
  pathname: string,
  context: OrganizationRouteContext,
  headers: Record<string, string>,
  paths: Readonly<Record<string, OrganizationRule>> = ORGANIZATION_PATHS,
): Promise<Response | undefined> {
  if (!pathname.startsWith(PREFIX)) return undefined;

  const path = pathname.slice(AUTH_BASE_PATH.length);
  const rule = Object.hasOwn(paths, path) ? paths[path] : undefined;
  if (rule === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== rule.method) return json(405, { error: 'method-not-allowed' }, headers);

  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);

  const sent = await sentBy(request, rule);
  if (sent === 'too-large') return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);
  if (sent === undefined) return json(400, { error: 'invalid-request' }, headers);
  const read = readOrganizationInput(rule, sent);
  if (!read.ok) return json(400, { error: 'invalid-request', field: read.field }, headers);
  const workspace = String(read.input.organizationId);

  // Read by the store of the worker, which takes one role of the four and nothing else. Not a member
  // answers like a workspace that does not exist, as on the routes of the console.
  const role = await context.accounts.role(workspace, mine.userId);
  if (role === undefined) return json(404, { error: 'not-found' }, headers);
  if (rule.needs !== undefined && !can(role, rule.needs)) return json(403, { error: 'forbidden', role }, headers);

  // The request better-auth reads is written here: the fields of the rule, as they were read.
  const address = new URL(`${AUTH_BASE_PATH}${path}`, request.url);
  if (rule.method === 'GET')
    for (const [name, value] of Object.entries(read.input)) address.searchParams.set(name, String(value));
  const forwardedHeaders = headersFor(request, context);
  forwardedHeaders.delete('Content-Length');
  if (rule.method === 'POST') forwardedHeaders.set('Content-Type', 'application/json');
  const answer = await auth.handler(
    new Request(address, {
      method: rule.method,
      headers: forwardedHeaders,
      ...(rule.method === 'POST' ? { body: JSON.stringify(read.input) } : {}),
    }),
  );

  // Somebody who left keeps no extension for the workspace. `remove-member` does the same in a hook
  // of the plugin (`auth.ts`); `leave` runs none in 1.7.7, so it is here.
  if (path === '/organization/leave' && answer.ok) {
    await context.sessions.endSessionsOf({ subject: mine.userId, workspace }, Date.now());
  }

  const merged = new Headers(answer.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: merged });
}

/**
 * A new workspace for the person of this cookie, made by the organization plugin (FRU-149):
 * `POST /console/workspaces` calls this, and the route of the plugin stays closed to a request.
 *
 * The caller validated the name. The plugin wants a slug, and a workspace has none: it gets a value
 * that nothing reads. `keepCurrentActiveOrganization`: no call of the worker reads an « active »
 * workspace, so none is written in the session.
 *
 * The person is the one of the cookie, read by better-auth: the body names nobody.
 *
 * It throws `AuthUnavailable` when better-auth does not make it: the caller answers `502`, as on the
 * other calls that read the cookie.
 */
export async function createWorkspaceWithPlugin(auth: Auth, headers: Headers, name: string): Promise<Workspace> {
  const plugin = auth.api as unknown as {
    createOrganization(input: object): Promise<{ id?: unknown; name?: unknown } | null>;
  };
  let made: { id?: unknown; name?: unknown } | null;
  try {
    made = await plugin.createOrganization({
      body: { name, slug: newId('slug'), keepCurrentActiveOrganization: true },
      headers,
    });
  } catch (error) {
    throw new AuthUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (typeof made?.id !== 'string' || typeof made.name !== 'string') {
    throw new AuthUnavailable('better-auth made a workspace and answered no id for it');
  }

  return { id: made.id, name: made.name };
}
