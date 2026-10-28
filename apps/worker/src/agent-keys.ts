import {
  type AccountStore,
  type AgentKey,
  MAX_AGENT_KEYS,
  type Reach,
  type Role,
  can,
  readsSite,
  workspaceName,
} from './accounts.ts';
import { digest } from './session.ts';

/**
 * The agent keys of a workspace (FRU-461, `docs/decisions/agents.md`): what lets an agent with no
 * browser read the notes of some sites, and write there when the key says so.
 *
 * - **The worker keeps the SHA-256 digest of a key, never the key.** The console shows the key once,
 *   at its creation. A lookup is by digest, on a unique index: nothing compares the bytes of a key.
 * - **A key reaches one workspace, and only the sites it names.**
 * - **A key never does more than the member who made it, read again at each request.** That member
 *   removed, suspended or made a guest, the key reaches what the member reaches now, or nothing.
 * - **A key ends.** It lives `DEFAULT_KEY_DAYS` days unless its creator chooses a number of days,
 *   `MAX_KEY_DAYS` at most. No key lives with no end.
 * - The owner and the admins make, list and revoke the keys (`manage-workspace`).
 */

/** The days a key lives when its creator chooses none: decision 4 of `agents.md`. */
export const DEFAULT_KEY_DAYS = 90;

/** The most days a key lives. */
export const MAX_KEY_DAYS = 365;

/** The most sites one key names. */
export const MAX_KEY_SITES = 20;

const DAY_MS = 86_400_000;

/** The start of every key, so that a scanner of secrets finds one that leaked. */
export const KEY_PREFIX = 'fbk_';

const KEY_BYTES = 32;

/** A key as `newAgentKey` writes it: the prefix, then 32 bytes in base64url. */
const KEY_SHAPE = /^fbk_[A-Za-z0-9_-]{43}$/;

export function newAgentKey(): string {
  return `${KEY_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))).toString('base64url')}`;
}

/**
 * What a key may do now: the sites it names that its member still reads, and `write` when the key
 * says so and the member may manage the sites. A reply needs less than a status, but the key holds
 * one right for both, so `write` asks for the larger one.
 */
export type AgentGrant = {
  key: string;
  name: string;
  workspace: string;
  role: Role;
  sites: string[];
  write: boolean;
  /** On a site that everyone reads, only the notes of a known person. */
  verifiedOnly: boolean;
};

/**
 * The grant of a key as the request presents it, or `undefined`: no key of that shape, no key of that
 * digest, an expired key, a key whose member is gone or suspended, or a key that reaches no site now. The same answer for each, so a
 * caller learns nothing of which.
 */
export async function resolveAgentKey(
  accounts: Pick<AccountStore, 'agentKeyOf'>,
  presented: string,
  now: number,
): Promise<AgentGrant | undefined> {
  if (!KEY_SHAPE.test(presented)) return undefined;
  const found = await accounts.agentKeyOf(await digest(presented));
  if (found === undefined || found.key.expiresAt <= now) return undefined;

  return grantOf(found.key, found.reach);
}

function grantOf(key: AgentKey, reach: Reach): AgentGrant | undefined {
  const sites = key.sites.map((site) => site.id).filter((site) => readsSite(reach, site));
  if (!can(reach.role, 'read-feedback') || sites.length === 0) return undefined;

  return {
    key: key.id,
    name: key.name,
    workspace: key.workspaceId,
    role: reach.role,
    sites,
    write: key.write && can(reach.role, 'manage-sites'),
    verifiedOnly: key.verifiedOnly,
  };
}

/** A key as the console reads it: never the key, and never its digest. */
function keyView(key: AgentKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    sites: key.sites,
    rights: key.write ? 'write' : 'read',
    verifiedOnly: key.verifiedOnly,
    createdBy: key.createdBy,
    createdAt: new Date(key.createdAt).toISOString(),
    expiresAt: new Date(key.expiresAt).toISOString(),
  };
}

/** The sites of a request: distinct ids, 1 to `MAX_KEY_SITES`, or `undefined`. */
function sitesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((site) => typeof site === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(site))) return undefined;
  const sites = [...new Set(value as string[])];

  return sites.length > MAX_KEY_SITES ? undefined : sites;
}

/** The days of a request: absent is `DEFAULT_KEY_DAYS`, else a whole number from 1 to `MAX_KEY_DAYS`. */
function daysOf(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_KEY_DAYS;

  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_KEY_DAYS
    ? (value as number)
    : undefined;
}

export type AgentKeysContext = {
  accounts: AccountStore;
  workspace: string;
  account: string;
  /** Whether the caller may manage the workspace: the one right of these routes. */
  manages: boolean;
  forbidden: () => Response;
  readBody: (request: Request) => Promise<Record<string, unknown> | undefined>;
  json: (status: number, body: unknown, headers: Record<string, string>) => Response;
  headers: Record<string, string>;
  now: number;
};

/**
 * `/agent-keys` of a workspace, which `handleConsoleApi` sends here, or `undefined` for another path.
 *
 * - `GET /agent-keys`: the keys of the workspace.
 * - `POST /agent-keys` `{ name, sites, rights: 'read' | 'write', days?, verifiedOnly? }`: `201` with the
 *   key in `secret`, the one time the worker answers it. `verifiedOnly` is `true` when absent.
 * - `DELETE /agent-keys/<id>`: `204`, or `404` for a key that is not of this workspace.
 */
export async function handleAgentKeys(
  rest: string,
  request: Request,
  context: AgentKeysContext,
): Promise<Response | undefined> {
  const { accounts, workspace, json, headers } = context;
  const one = /^\/agent-keys\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (rest !== '/agent-keys' && one === null) return undefined;
  if (!context.manages) return context.forbidden();

  if (one !== null) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    const revoked = await accounts.revokeAgentKey(workspace, one[1] as string);

    return revoked ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  if (request.method === 'GET') {
    return json(200, { keys: (await accounts.agentKeys(workspace)).map(keyView) }, headers);
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  const body = await context.readBody(request);
  const name = workspaceName(body?.name);
  if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
  const sites = sitesOf(body?.sites);
  if (sites === undefined) return json(400, { error: 'invalid-sites', max: MAX_KEY_SITES }, headers);
  if (body?.rights !== 'read' && body?.rights !== 'write') return json(400, { error: 'invalid-rights' }, headers);
  const days = daysOf(body?.days);
  if (days === undefined) return json(400, { error: 'invalid-days', max: MAX_KEY_DAYS }, headers);
  const verifiedOnly = body.verifiedOnly === undefined ? true : body.verifiedOnly;
  if (typeof verifiedOnly !== 'boolean') return json(400, { error: 'invalid-verified-only' }, headers);

  const secret = newAgentKey();
  const made = await accounts.createAgentKey(workspace, {
    name,
    sites,
    write: body.rights === 'write',
    verifiedOnly,
    createdBy: context.account,
    keyHash: await digest(secret),
    createdAt: context.now,
    expiresAt: context.now + days * DAY_MS,
  });
  if (made === 'unknown-site') return json(400, { error: 'unknown-site' }, headers);
  if (made === 'too-many') return json(409, { error: 'too-many-keys', max: MAX_AGENT_KEYS }, headers);

  return json(201, { ...keyView(made), secret }, headers);
}
