import { AGENT_MOMENTS, type AccountStore, type AgentMoment } from './accounts.ts';
import { noteIdOf } from './console-notes.ts';
import { DELIVERY_VERSION } from './rest-connector.ts';

/**
 * The trigger of a site that starts an agent (FRU-468, `docs/decisions/agents.md`, « Starting an
 * agent on a note »).
 *
 * - **Off by default**: a site with no row calls nothing.
 * - **The call is a delivery of the REST connector** (FRU-132): the trigger names a `rest` connector
 *   of the workspace, and the call goes in its queue, signed with its secret, tried again, guarded
 *   against a private address at each attempt, and shown in its panel when it fails. Its `event` is
 *   `agent.requested`, so no read takes it for the place of a note.
 * - **The call carries ids, never the text nor the files**: the agent reads the note through `/mcp`
 *   with its key, so a key decides what it reads.
 * - **Two moments, one at a time.** `verified-note`: a note of a known person arrives (a member, or a
 *   reviewer the identity of the site verified). A note of a visitor calls nothing: anybody writes one.
 *   `moved-to-todo`: a person with a session moves a note that the worker keeps to the stage To do.
 *   An agent key that sets a status never calls: an agent cannot start itself.
 */

/** Why a call was made: the moment of the trigger. */
export type AgentRequest = {
  workspace: string;
  site: string;
  origin?: string;
  /** What Fruitback calls the note, as its thread shows it. */
  identifier: string;
  /** The id of the note in its site. */
  note: string;
  reason: AgentMoment;
};

/**
 * The body of a call. `note.id` is the id that `get_feedback` of `/mcp` takes. No text, no file.
 */
export function agentRequestBody(request: AgentRequest): string {
  return JSON.stringify({
    version: DELIVERY_VERSION,
    event: 'agent.requested',
    reason: request.reason,
    workspace: request.workspace,
    site: { id: request.site, ...(request.origin === undefined ? {} : { origin: request.origin }) },
    identifier: request.identifier,
    note: { id: noteIdOf(request.site, request.note) },
  });
}

/**
 * Queues the call of the trigger of the site, when it is on and its moment is `request.reason`.
 * Answers whether a call was queued. It never rejects: the note is kept, and a trigger that cannot
 * be read or written is said in the log of the worker only.
 */
export async function requestAgent(
  accounts: Pick<AccountStore, 'agentTrigger' | 'enqueueDelivery'>,
  request: AgentRequest,
  now: number,
): Promise<boolean> {
  try {
    const trigger = await accounts.agentTrigger(request.workspace, request.site);
    if (trigger === undefined || !trigger.enabled || trigger.moment !== request.reason) return false;
    await accounts.enqueueDelivery(trigger.connector, agentRequestBody(request), now, 'agent.requested');

    return true;
  } catch (error) {
    console.error(
      `[fruitback] the call of the trigger of a site was not queued: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

export type AgentTriggerContext = {
  accounts: AccountStore;
  workspace: string;
  /** Whether the caller may manage the workspace: the one right of these routes. */
  manages: boolean;
  forbidden: () => Response;
  readBody: (request: Request) => Promise<Record<string, unknown> | undefined>;
  json: (status: number, body: unknown, headers: Record<string, string>) => Response;
  headers: Record<string, string>;
  now: number;
};

/**
 * `/sites/<id>/agent-trigger` of a workspace, which `handleConsoleApi` sends here, or `undefined` for
 * another path. For the owner and the admins (`manage-workspace`), as the agent keys.
 *
 * - `GET`: `{ trigger: { connector, moment, enabled, waiting } }`, or `{ trigger: null }` for none.
 * - `POST { connector, moment, enabled }`: writes it (the console API takes no `PUT`). `400` for a field it cannot read, `400
 *   unknown-connector` for a connector that is not an address that receives of this workspace, `404`
 *   for a site that is not of this workspace.
 */
export async function handleAgentTrigger(
  rest: string,
  request: Request,
  context: AgentTriggerContext,
): Promise<Response | undefined> {
  const path = /^\/sites\/([A-Za-z0-9_-]+)\/agent-trigger$/.exec(rest);
  if (path === null) return undefined;
  const { accounts, workspace, json, headers } = context;
  if (!context.manages) return context.forbidden();
  const site = path[1] as string;

  if (request.method === 'GET') {
    return json(200, { trigger: (await accounts.agentTrigger(workspace, site)) ?? null }, headers);
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  const body = await context.readBody(request);
  const connector = body?.connector;
  if (typeof connector !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(connector)) {
    return json(400, { error: 'invalid-connector' }, headers);
  }
  const moment = body?.moment;
  if (!(AGENT_MOMENTS as readonly unknown[]).includes(moment)) return json(400, { error: 'invalid-moment' }, headers);
  if (typeof body?.enabled !== 'boolean') return json(400, { error: 'invalid-enabled' }, headers);

  const written = await accounts.setAgentTrigger(
    workspace,
    site,
    { connector, moment: moment as AgentMoment, enabled: body.enabled },
    context.now,
  );
  if (written === 'unknown-site') return json(404, { error: 'not-found' }, headers);
  if (written === 'unknown-connector') return json(400, { error: 'unknown-connector' }, headers);

  return json(200, { trigger: written }, headers);
}
