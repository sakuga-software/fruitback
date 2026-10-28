import { type AccountStore, MAX_AGENT_KEYS, type OAuthClient, can } from './accounts.ts';
import { type AgentGrant, DEFAULT_KEY_DAYS, daysOf, grantOf, sitesOf } from './agent-keys.ts';
import { readBoundedText } from './bounded-body.ts';
import type { Kv } from './kv.ts';
import { MCP_PATH } from './mcp.ts';
import { digest } from './session.ts';

/**
 * OAuth for the MCP server (FRU-467, `docs/decisions/agents.md`, `SECURITY.md`): how a client that
 * connects from a page, as a connector of claude.ai, gets a token for `/mcp`. It follows the
 * authorization of MCP (2025-06-18), on OAuth 2.1.
 *
 * - **A connection is an agent key** (`agent-keys.ts`) with no secret, tied to its client: the same
 *   workspace, sites, rights, end, member read again at each request, log of writes and revocation.
 *   The person approves it in the console, and chooses all of that there.
 * - **Discovery**: `/.well-known/oauth-protected-resource` (RFC 9728) names this worker as the server
 *   of authorization of `/mcp`, and `/.well-known/oauth-authorization-server` (RFC 8414) gives its
 *   routes. `/mcp` answers `401` with `WWW-Authenticate` to a request with no valid token.
 * - **Registration** (RFC 7591) is open, and bounded: `REGISTRATIONS_PER_ADDRESS` an hour per
 *   address, `MAX_OAUTH_CLIENTS` that nobody approved, deleted after `UNAPPROVED_CLIENT_MS`.
 * - **The code**: PKCE with S256 only, a `redirect_uri` compared byte for byte, `CODE_SECONDS` of
 *   life, one use. A code used twice revokes the connection it made (OAuth 2.1, 4.1.3).
 * - **The tokens** are opaque and kept as digests: access `ACCESS_SECONDS`, refresh
 *   `REFRESH_DAYS` days, both bounded by the end of the connection. A refresh is spent once and
 *   replaced; a spent refresh presented again revokes the connection (OAuth 2.1, 4.3.1).
 *
 * OAuth is on when the worker has accounts, `FRUITBACK_PUBLIC_URL` with no path, and
 * `FRUITBACK_CONSOLE_URL`. Otherwise every route here answers `404`, as before.
 */

export const ACCESS_SECONDS = 60 * 60;
export const REFRESH_DAYS = 30;
/** How long a request waits for a person in the console. */
export const REQUEST_SECONDS = 10 * 60;
/** How long a code waits for its exchange. */
export const CODE_SECONDS = 60;
export const REGISTRATIONS_PER_ADDRESS = 10;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
/** A client that no person approved is deleted after a day. */
export const UNAPPROVED_CLIENT_MS = 24 * 60 * 60 * 1000;
export const MAX_REDIRECT_URIS = 5;
export const MAX_CLIENT_NAME = 60;
/** The rights of a key, as scopes. */
export const SCOPES = ['read', 'write'] as const;
type Scope = (typeof SCOPES)[number];

const DAY_MS = 86_400_000;
const ACCESS_PREFIX = 'fba_';
const REFRESH_PREFIX = 'fbr_';
const CODE_PREFIX = 'fbc_';
const SECRET_PREFIX = 'fbs_';
const TOKEN_SHAPE = /^fb[arcs]_[A-Za-z0-9_-]{43}$/;
const REQUEST_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const CLIENT_SHAPE = /^fbo_[A-Za-z0-9_-]{22}$/;
const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';
export const REGISTER_PATH = '/oauth/register';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REVOKE_PATH = '/oauth/revoke';

const PUBLIC_PATHS = new Set([
  PROTECTED_RESOURCE_PATH,
  `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
  AUTHORIZATION_SERVER_PATH,
  REGISTER_PATH,
  AUTHORIZE_PATH,
  TOKEN_PATH,
  REVOKE_PATH,
]);

/** Whether `app.ts` sends this path here. Any origin may read these routes: they take no cookie. */
export function isOAuthRoute(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

function random(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/** Where this worker is, for OAuth: the origin of `FRUITBACK_PUBLIC_URL`, or `undefined` when it has a path. */
export function issuerOf(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined) return undefined;
  const url = new URL(publicUrl);

  return url.pathname === '/' && url.search === '' ? url.origin : undefined;
}

/** The address of the metadata of `/mcp`, as `/mcp` names it in `WWW-Authenticate`. */
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
}

// --- answers --------------------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers },
  });
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string>): Response {
  return json(status, { error, error_description: description }, headers);
}

/** A refusal of `/oauth/authorize` that must not go back to an address nobody checked: a page. */
function page(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE, 'X-Content-Type-Options': 'nosniff' },
  });
}

/** Back to the client, with `iss` (RFC 9207), and its `state` when it gave one. */
function backTo(redirectUri: string, issuer: string, values: Record<string, string>, state?: string): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);

  return url.toString();
}

// --- the client -----------------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A `redirect_uri` a client may register: `https`, or `http` on the loopback, with no fragment. */
function redirectUriOf(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hash !== '' || value.includes('#') || url.username !== '' || url.password !== '') return undefined;
  if (url.protocol === 'https:') return url;

  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url : undefined;
}

/** The name a client gives itself, with no control character, `MAX_CLIENT_NAME` at most; or `fallback`. */
function clientNameOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = value
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();

  return name === '' ? fallback : [...name].slice(0, MAX_CLIENT_NAME).join('');
}

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

// --- the request of a person ----------------------------------------------------------------------

/** What `/oauth/authorize` keeps for the console, in the `Kv`, under the digest of the request id. */
type Pending = {
  client: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  scopes: Scope[];
  expiresAt: number;
};

/** What a code carries, in the `Kv`, under its digest. */
type CodeGrant = { client: string; redirectUri: string; challenge: string; key: string; expiresAt: number };

const requestKey = (hash: string) => `fruitback:oauth-request:${hash}`;
const answeredKey = (hash: string) => `fruitback:oauth-answered:${hash}`;
const codeKey = (hash: string) => `fruitback:oauth-code:${hash}`;
const codeSpentKey = (hash: string) => `fruitback:oauth-code-spent:${hash}`;

/** The scopes of a request: absent is both, a list of known ones, or `undefined` for an unknown one. */
function scopesOf(value: string | null): Scope[] | undefined {
  if (value === null || value.trim() === '') return [...SCOPES];
  const asked = value.trim().split(/\s+/);
  if (!asked.every((each) => (SCOPES as readonly string[]).includes(each))) return undefined;

  return SCOPES.filter((each) => asked.includes(each));
}

export type OAuthContext = {
  accounts: AccountStore;
  kv: Kv;
  /** The origin of this worker: the issuer, and the base of every address it gives. */
  issuer: string;
  /** `FRUITBACK_CONSOLE_URL`: where a person approves. */
  consoleUrl: string;
  clientIp: string;
  now?: number;
};

/** The routes of OAuth that take no cookie, or `undefined` for another path. */
export async function handleOAuth(
  request: Request,
  pathname: string,
  context: OAuthContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  if (!isOAuthRoute(pathname)) return undefined;
  const now = context.now ?? Date.now();
  const { issuer } = context;

  if (pathname === PROTECTED_RESOURCE_PATH || pathname === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, { ...headers, Allow: 'GET' });

    return json(
      200,
      {
        resource: `${issuer}${MCP_PATH}`,
        authorization_servers: [issuer],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'Fruitback',
      },
      headers,
    );
  }

  if (pathname === AUTHORIZATION_SERVER_PATH) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, { ...headers, Allow: 'GET' });

    return json(
      200,
      {
        issuer,
        authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
        token_endpoint: `${issuer}${TOKEN_PATH}`,
        registration_endpoint: `${issuer}${REGISTER_PATH}`,
        revocation_endpoint: `${issuer}${REVOKE_PATH}`,
        scopes_supported: SCOPES,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: AUTH_METHODS,
        revocation_endpoint_auth_methods_supported: AUTH_METHODS,
        authorization_response_iss_parameter_supported: true,
      },
      headers,
    );
  }

  if (pathname === AUTHORIZE_PATH) {
    if (request.method !== 'GET') return page(405, 'Open this address in a browser.');

    return authorize(new URL(request.url).searchParams, context, now);
  }

  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, { ...headers, Allow: 'POST' });
  if (pathname === REGISTER_PATH) return register(request, context, now, headers);

  const form = await formOf(request);
  if (form === undefined) return oauthError(400, 'invalid_request', 'The body is a form, and is short.', headers);
  if (pathname === TOKEN_PATH) return token(request, form, context, now, headers);

  return revoke(request, form, context, headers);
}

// --- registration (RFC 7591) ----------------------------------------------------------------------

async function register(
  request: Request,
  context: OAuthContext,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  // Counted before anything is read, a refused one too.
  const made = await context.kv.incr(`fruitback:oauth-register-ip:${context.clientIp}`, REGISTRATION_WINDOW_MS);
  if (made > REGISTRATIONS_PER_ADDRESS) return oauthError(429, 'rate_limited', 'Too many registrations.', headers);

  const text = await readBoundedText(request);
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = text === null ? undefined : JSON.parse(text);
    body =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    body = undefined;
  }
  if (body === undefined) return oauthError(400, 'invalid_client_metadata', 'The body is one JSON object.', headers);

  const asked = body.redirect_uris;
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_REDIRECT_URIS) {
    return oauthError(400, 'invalid_redirect_uri', `1 to ${MAX_REDIRECT_URIS} redirect_uris.`, headers);
  }
  const urls = asked.map(redirectUriOf);
  if (urls.some((url) => url === undefined)) {
    return oauthError(
      400,
      'invalid_redirect_uri',
      'A redirect_uri is https, or http on localhost, with no fragment.',
      headers,
    );
  }
  // One host per client: the host is what a person reads on the consent page.
  const hosts = new Set(urls.map((url) => (url as URL).host));
  if (hosts.size !== 1) return oauthError(400, 'invalid_redirect_uri', 'Every redirect_uri has one host.', headers);
  const host = [...hosts][0] as string;

  const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!(AUTH_METHODS as readonly unknown[]).includes(method)) {
    return oauthError(
      400,
      'invalid_client_metadata',
      `token_endpoint_auth_method is one of ${AUTH_METHODS.join(', ')}.`,
      headers,
    );
  }
  const grants = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || !grants.every((grant) => grant === 'authorization_code' || grant === 'refresh_token')) {
    return oauthError(400, 'invalid_client_metadata', 'grant_types: authorization_code and refresh_token.', headers);
  }
  const responses = body.response_types ?? ['code'];
  if (!Array.isArray(responses) || !responses.every((each) => each === 'code')) {
    return oauthError(400, 'invalid_client_metadata', 'response_types: code.', headers);
  }

  const secret = method === 'none' ? undefined : `${SECRET_PREFIX}${random(32)}`;
  const client: OAuthClient = {
    id: `fbo_${random(16)}`,
    name: clientNameOf(body.client_name, host),
    redirectUris: asked as string[],
    host,
    ...(secret === undefined ? {} : { secretHash: await digest(secret) }),
    createdAt: now,
  };
  const written = await context.accounts.registerOAuthClient(client, now - UNAPPROVED_CLIENT_MS);
  if (written === 'too-many') return oauthError(503, 'temporarily_unavailable', 'Too many clients wait.', headers);

  return json(
    201,
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    },
    headers,
  );
}

// --- the authorization request ---------------------------------------------------------------------

async function authorize(params: URLSearchParams, context: OAuthContext, now: number): Promise<Response> {
  // Nothing goes back to an address before the client and its address are known: a page says why.
  const clientId = params.get('client_id') ?? '';
  const client = CLIENT_SHAPE.test(clientId) ? await context.accounts.oauthClient(clientId) : undefined;
  if (client === undefined) return page(400, 'This app is not registered with this Fruitback server.');
  const asked = params.get('redirect_uri');
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  // Byte for byte: no normalisation, no prefix, no other port.
  if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
    return page(400, 'This app sent an address to come back to that it did not register.');
  }

  const state = params.get('state') ?? undefined;
  const refuse = (error: string, description: string) =>
    Response.redirect(backTo(redirectUri, context.issuer, { error, error_description: description }, state), 302);
  if (params.get('response_type') !== 'code') return refuse('unsupported_response_type', 'response_type is code.');
  const challenge = params.get('code_challenge') ?? '';
  if (params.get('code_challenge_method') !== 'S256' || !CHALLENGE_SHAPE.test(challenge)) {
    return refuse('invalid_request', 'PKCE with S256 is required.');
  }
  const scopes = scopesOf(params.get('scope'));
  if (scopes === undefined) return refuse('invalid_scope', `The scopes are ${SCOPES.join(' and ')}.`);
  const resource = params.get('resource');
  if (resource !== null && resource !== `${context.issuer}${MCP_PATH}`) {
    return refuse('invalid_target', 'This server gives tokens for its /mcp only.');
  }
  if (state !== undefined && state.length > 1000) return refuse('invalid_request', 'state is too long.');

  const id = random(16);
  const pending: Pending = {
    client: client.id,
    redirectUri,
    challenge,
    scopes,
    expiresAt: now + REQUEST_SECONDS * 1000,
    ...(state === undefined ? {} : { state }),
  };
  await context.kv.set(requestKey(await digest(id)), JSON.stringify(pending), REQUEST_SECONDS * 1000);

  return new Response(null, {
    status: 302,
    headers: { Location: `${new URL(context.consoleUrl).origin}/authorize/${id}`, ...NO_STORE },
  });
}

// --- the token endpoint ---------------------------------------------------------------------------

async function formOf(request: Request): Promise<URLSearchParams | undefined> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) return undefined;
  const text = await readBoundedText(request);

  return text === null ? undefined : new URLSearchParams(text);
}

/** The client of a request to the token endpoint, authenticated as it registered; or why not. */
async function clientOfRequest(
  request: Request,
  form: URLSearchParams,
  accounts: AccountStore,
): Promise<OAuthClient | 'invalid'> {
  let id = form.get('client_id') ?? undefined;
  let secret = form.get('client_secret') ?? undefined;
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (basic !== null) {
    const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return 'invalid';
    let fromHeader: string;
    try {
      fromHeader = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      return 'invalid';
    }
    if (id !== undefined && id !== fromHeader) return 'invalid';
    id = fromHeader;
  }
  if (id === undefined || !CLIENT_SHAPE.test(id)) return 'invalid';
  const client = await accounts.oauthClient(id);
  if (client === undefined) return 'invalid';
  if (client.secretHash === undefined) return secret === undefined ? client : 'invalid';
  if (secret === undefined || !TOKEN_SHAPE.test(secret)) return 'invalid';

  return (await digest(secret)) === client.secretHash ? client : 'invalid';
}

async function token(
  request: Request,
  form: URLSearchParams,
  context: OAuthContext,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const client = await clientOfRequest(request, form, context.accounts);
  if (client === 'invalid') {
    return json(
      401,
      { error: 'invalid_client', error_description: 'The client is unknown, or did not authenticate.' },
      { ...headers, 'WWW-Authenticate': 'Basic realm="fruitback"' },
    );
  }
  const resource = form.get('resource');
  if (resource !== null && resource !== `${context.issuer}${MCP_PATH}`) {
    return oauthError(400, 'invalid_target', 'This server gives tokens for its /mcp only.', headers);
  }
  const grant = form.get('grant_type');
  if (grant === 'authorization_code') return exchangeCode(form, client, context, now, headers);
  if (grant === 'refresh_token') return refresh(form, client, context, now, headers);

  return oauthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token.', headers);
}

const invalidGrant = (headers: Record<string, string>) =>
  oauthError(400, 'invalid_grant', 'The code or the token is unknown, spent, or ended.', headers);

async function exchangeCode(
  form: URLSearchParams,
  client: OAuthClient,
  context: OAuthContext,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const code = form.get('code') ?? '';
  if (!TOKEN_SHAPE.test(code) || !code.startsWith(CODE_PREFIX)) return invalidGrant(headers);
  const hash = await digest(code);
  const kept = await context.kv.get(codeKey(hash));
  if (kept === undefined) return invalidGrant(headers);
  const grant = JSON.parse(kept) as CodeGrant;
  // One use. A code presented twice was seen by somebody else: its connection ends (OAuth 2.1, 4.1.3).
  if ((await context.kv.incr(codeSpentKey(hash), CODE_SECONDS * 1000)) > 1) {
    await context.accounts.dropAgentKey(grant.key);

    return invalidGrant(headers);
  }
  // Its end is in the code too: the `Kv` drops it then, and a `Kv` that keeps it longer changes nothing.
  if (grant.expiresAt <= now) return invalidGrant(headers);
  if (grant.client !== client.id || form.get('redirect_uri') !== grant.redirectUri) return invalidGrant(headers);
  const verifier = form.get('code_verifier') ?? '';
  if (!VERIFIER_SHAPE.test(verifier) || (await digest(verifier)) !== grant.challenge) return invalidGrant(headers);

  return issue(grant.key, context, now, headers);
}

async function refresh(
  form: URLSearchParams,
  client: OAuthClient,
  context: OAuthContext,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const presented = form.get('refresh_token') ?? '';
  if (!TOKEN_SHAPE.test(presented) || !presented.startsWith(REFRESH_PREFIX)) return invalidGrant(headers);
  const hash = await digest(presented);
  const kept = await context.accounts.oauthToken(hash);
  if (kept === undefined || kept.kind !== 'refresh' || kept.clientId !== client.id) return invalidGrant(headers);
  // Spent once. A refresh that was spent, presented again, was copied: the connection ends.
  if (kept.usedAt !== undefined || !(await context.accounts.spendRefreshToken(hash, now))) {
    await context.accounts.dropAgentKey(kept.keyId);

    return invalidGrant(headers);
  }
  if (kept.expiresAt <= now) return invalidGrant(headers);
  return issue(kept.keyId, context, now, headers);
}

/** A new access token and a new refresh token for a connection, both ending with it at the latest. */
async function issue(
  key: string,
  context: OAuthContext,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  // The member of the connection, read now: one who left, or reaches none of its sites, gets nothing.
  const found = await context.accounts.agentKeyById(key);
  if (found === undefined || found.key.expiresAt <= now || grantOf(found.key, found.reach) === undefined) {
    return invalidGrant(headers);
  }
  const ends = found.key.expiresAt;
  const access = `${ACCESS_PREFIX}${random(32)}`;
  const refreshToken = `${REFRESH_PREFIX}${random(32)}`;
  const accessEnds = Math.min(now + ACCESS_SECONDS * 1000, ends);
  const written = await context.accounts.addOAuthTokens(key, [
    { hash: await digest(access), kind: 'access', expiresAt: accessEnds },
    { hash: await digest(refreshToken), kind: 'refresh', expiresAt: Math.min(now + REFRESH_DAYS * DAY_MS, ends) },
  ]);
  if (!written) return invalidGrant(headers);

  return json(
    200,
    {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((accessEnds - now) / 1000)),
      refresh_token: refreshToken,
      scope: found.key.write ? 'read write' : 'read',
    },
    headers,
  );
}

/** RFC 7009: a token of this client ends its connection. Unknown, or of another client: `200` all the same. */
async function revoke(
  request: Request,
  form: URLSearchParams,
  context: OAuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const client = await clientOfRequest(request, form, context.accounts);
  if (client === 'invalid') {
    return json(401, { error: 'invalid_client' }, { ...headers, 'WWW-Authenticate': 'Basic realm="fruitback"' });
  }
  const presented = form.get('token') ?? '';
  if (TOKEN_SHAPE.test(presented)) {
    const kept = await context.accounts.oauthToken(await digest(presented));
    if (kept !== undefined && kept.clientId === client.id) await context.accounts.dropAgentKey(kept.keyId);
  }

  return new Response(null, { status: 200, headers: { ...NO_STORE, ...headers } });
}

/**
 * The grant of an access token of OAuth, as `/mcp` presents it, or `undefined`: no token of that
 * shape or digest, an ended token or connection, or a member who no longer reaches it. The same
 * answer for each, as `resolveAgentKey`.
 */
export async function resolveAccessToken(
  accounts: Pick<AccountStore, 'oauthToken' | 'agentKeyById'>,
  presented: string,
  now: number,
): Promise<AgentGrant | undefined> {
  if (!TOKEN_SHAPE.test(presented) || !presented.startsWith(ACCESS_PREFIX)) return undefined;
  const kept = await accounts.oauthToken(await digest(presented));
  if (kept === undefined || kept.kind !== 'access' || kept.expiresAt <= now) return undefined;
  const found = await accounts.agentKeyById(kept.keyId);
  if (found === undefined || found.key.expiresAt <= now) return undefined;

  return grantOf(found.key, found.reach);
}

// --- the console: the person approves ------------------------------------------------------------

const CONSOLE_REQUEST = /^\/console\/oauth\/requests\/([^/]+)(\/approve|\/deny)?$/;

export function isConsoleOAuthRoute(pathname: string): boolean {
  return CONSOLE_REQUEST.test(pathname);
}

export type ConsoleOAuthContext = {
  accounts: AccountStore;
  kv: Kv;
  issuer: string;
  consoleUrl: string;
  /** The account of the cookie of better-auth, or `undefined`. */
  cookieSession: (request: Request) => Promise<string | undefined>;
  now?: number;
};

async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(request);
  if (text === null) return undefined;
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
 * `/console/oauth/requests/<id>`: what the consent page reads (`GET`), and its two answers
 * (`POST …/approve`, `POST …/deny`), for the person of the cookie. Each answer gives the address the
 * console sends the browser to. A request is answered once; unknown, ended and answered all read
 * `404`.
 */
export async function handleConsoleOAuth(
  request: Request,
  pathname: string,
  context: ConsoleOAuthContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  const matched = CONSOLE_REQUEST.exec(pathname);
  if (matched === null) return undefined;
  const now = context.now ?? Date.now();
  const say = (status: number, body: unknown) => json(status, body, headers);

  const subject = await context.cookieSession(request);
  if (subject === undefined) return say(401, { error: 'identity-required' });
  // A call that changes something comes from the console, as `/connect` (`connect-routes.ts`).
  if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(context.consoleUrl).origin) {
    return say(403, { error: 'origin-not-allowed' });
  }
  const account = await context.accounts.account(subject);
  if (account === undefined || account.suspended === true) return say(401, { error: 'identity-required' });

  const [, id = '', action] = matched;
  if (!REQUEST_SHAPE.test(id)) return say(404, { error: 'request-unknown' });
  const hash = await digest(id);
  const kept = await context.kv.get(requestKey(hash));
  const pending = kept === undefined ? undefined : (JSON.parse(kept) as Pending);
  if (pending === undefined || pending.expiresAt <= now || (await context.kv.get(answeredKey(hash))) !== undefined) {
    return say(404, { error: 'request-unknown' });
  }
  const client = await context.accounts.oauthClient(pending.client);
  if (client === undefined) return say(404, { error: 'request-unknown' });

  // The workspaces where this person may make a key: the owner and the admins (decision 5).
  const managed = async () =>
    (await context.accounts.memberships(account.id)).filter(({ role }) => can(role, 'manage-workspace'));

  if (action === undefined) {
    if (request.method !== 'GET') return say(405, { error: 'method-not-allowed' });
    const workspaces = await Promise.all(
      (await managed()).map(async ({ workspace, role }) => ({
        id: workspace.id,
        name: workspace.name,
        role,
        sites: (await context.accounts.sites(workspace.id)).map((site) => ({
          id: site.id,
          origin: site.origin,
          visibility: site.visibility,
        })),
      })),
    );

    return say(200, {
      request: id,
      client: { name: client.name, host: client.host },
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      account: { id: account.id, email: account.email, ...(account.name === undefined ? {} : { name: account.name }) },
      workspaces,
      defaultDays: DEFAULT_KEY_DAYS,
    });
  }

  if (request.method !== 'POST') return say(405, { error: 'method-not-allowed' });
  const body = await bodyOf(request);
  if (body === undefined || typeof body.account !== 'string') return say(400, { error: 'invalid-body' });
  // The account the page showed: a console that changed account since would approve for another.
  if (body.account !== account.id) return say(409, { error: 'account-changed' });

  const once = async () => (await context.kv.incr(answeredKey(hash), REQUEST_SECONDS * 1000)) === 1;

  if (action === '/deny') {
    if (!(await once())) return say(404, { error: 'request-unknown' });

    return say(200, {
      redirect: backTo(
        pending.redirectUri,
        context.issuer,
        { error: 'access_denied', error_description: 'The person denied the request.' },
        pending.state,
      ),
    });
  }

  // Every choice is checked before the request is spent: a refusal here leaves it to answer again.
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  if (!(await managed()).some((each) => each.workspace.id === workspace)) return say(403, { error: 'forbidden' });
  const sites = sitesOf(body.sites);
  if (sites === undefined) return say(400, { error: 'invalid-sites' });
  if (body.rights !== 'read' && body.rights !== 'write') return say(400, { error: 'invalid-rights' });
  // Never more than the client asked.
  if (body.rights === 'write' && !pending.scopes.includes('write')) return say(400, { error: 'invalid-rights' });
  const days = daysOf(body.days);
  if (days === undefined) return say(400, { error: 'invalid-days' });
  const verifiedOnly = body.verifiedOnly === undefined ? true : body.verifiedOnly;
  if (typeof verifiedOnly !== 'boolean') return say(400, { error: 'invalid-verified-only' });
  const known = new Set((await context.accounts.sites(workspace)).map((site) => site.id));
  if (!sites.every((site) => known.has(site))) return say(400, { error: 'unknown-site' });
  if ((await context.accounts.agentKeys(workspace)).length >= MAX_AGENT_KEYS) {
    return say(409, { error: 'too-many-keys', max: MAX_AGENT_KEYS });
  }
  if (!(await once())) return say(404, { error: 'request-unknown' });

  const made = await context.accounts.createAgentKey(workspace, {
    name: client.name,
    sites,
    write: body.rights === 'write',
    verifiedOnly,
    createdBy: account.id,
    clientId: client.id,
    createdAt: now,
    expiresAt: now + days * DAY_MS,
  });
  if (made === 'unknown-site') return say(400, { error: 'unknown-site' });
  if (made === 'too-many') return say(409, { error: 'too-many-keys' });

  const code = `${CODE_PREFIX}${random(32)}`;
  const grant: CodeGrant = {
    client: client.id,
    redirectUri: pending.redirectUri,
    challenge: pending.challenge,
    key: made.id,
    expiresAt: now + CODE_SECONDS * 1000,
  };
  await context.kv.set(codeKey(await digest(code)), JSON.stringify(grant), CODE_SECONDS * 1000);

  return say(200, {
    redirect: backTo(pending.redirectUri, context.issuer, { code }, pending.state),
    key: made.id,
  });
}
