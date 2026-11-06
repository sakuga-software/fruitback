import { open, seal } from './secrets.ts';

/**
 * A Claude Code routine as the place a trigger of a site calls (FRU-594, `docs/decisions/agents.md`,
 * « Agents as destinations »).
 *
 * The team makes a scheduled task (a routine) at claude.ai/code/routines, with its repository, the
 * MCP connector of Fruitback and a fixed prompt, and gives it an API trigger: a Fire URL and a token.
 * The worker keeps both, sealed with `FRUITBACK_SECRETS_KEY`, and a call of the trigger of a site is
 * a `POST` to that URL. The routine then reads the notes by `/mcp`.
 *
 * - **One host, fixed**: `https://api.anthropic.com`, and the path of a routine's `/fire`. A connector
 *   cannot send the token anywhere else, and the worker calls no address the workspace chose.
 * - **Identifiers only in `text`**: the ids of the notes, the site, the address of `/mcp`. Never the
 *   text of a note. The routine receives `text` wrapped as untrusted data
 *   (`<routine-fire-payload>`), and reads the note by `/mcp`, under the rights of its own access.
 * - **The answer names the session** (`claude_code_session_url`), kept so the console shows it.
 *
 * The shapes are those of the documentation of 2026-11-06 (code.claude.com/docs/en/routines): a
 * research preview, behind a dated beta header.
 */

/** The one origin a routine connector calls. */
export const ROUTINE_ORIGIN = 'https://api.anthropic.com';

/** The beta header of `/fire`, as the documentation of 2026-11-06 gives it. */
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The path of a routine's `/fire`, with the id of its trigger. */
const FIRE_PATH = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{1,64})\/fire$/;

/** What the worker keeps for a connector of this kind, sealed: where to call, and with what token. */
export type RoutineTarget = { url: string; token: string };

/**
 * The Fire URL as the worker keeps it, or `undefined` for anything that is not the `/fire` of a
 * routine on `api.anthropic.com`: another host, another scheme, a port, a name and password, a query.
 */
export function parseFireUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.origin !== ROUTINE_ORIGIN || url.username !== '' || url.password !== '' || url.search !== '') {
    return undefined;
  }
  if (!FIRE_PATH.test(url.pathname)) return undefined;

  return `${ROUTINE_ORIGIN}${url.pathname}`;
}

/** The id of the trigger in a Fire URL the worker keeps: `trig_01AB…`. */
export function triggerIdOf(url: string): string {
  return FIRE_PATH.exec(new URL(url).pathname)?.[1] ?? '';
}

/**
 * A token as the worker takes it: printable, with no space, and of a length a token has. Its shape is
 * not checked further: Anthropic may change it, and `/fire` says whether it is good.
 */
export function isAcceptableToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function sealRoutine(target: RoutineTarget, secretsKey: string): string {
  return seal(JSON.stringify(target), secretsKey);
}

/** The target, or `undefined` for a value this key does not open, or that is not one. */
export function openRoutine(sealed: string, secretsKey: string): RoutineTarget | undefined {
  const plain = open(sealed, secretsKey);
  if (plain === undefined) return undefined;
  try {
    const { url, token } = JSON.parse(plain) as { url?: unknown; token?: unknown };
    const kept = parseFireUrl(url);

    return kept !== undefined && isAcceptableToken(token) ? { url: kept, token } : undefined;
  } catch {
    return undefined;
  }
}

/** What the console shows for a routine: the id of its trigger, never the token. */
export function routineLabel(url: string): string {
  return `Claude Code routine · ${triggerIdOf(url)}`;
}

/** The headers of a call, as the documentation gives them. */
export function routineHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': ROUTINE_BETA,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'User-Agent': 'Fruitback',
  };
}

/** What a call of a trigger names, read from the body the queue keeps (`agentRequestBody`). */
export type RoutineCall = {
  reason: string;
  site: string;
  origin?: string;
  notes: { identifier: string; id: string }[];
};

/** The call of the queue, or `undefined` for a body that is not an `agent.requested` of a trigger. */
export function routineCallOf(body: string): RoutineCall | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.event !== 'agent.requested' || typeof parsed.reason !== 'string') return undefined;
  const site = parsed.site as { id?: unknown; origin?: unknown } | undefined;
  if (typeof site?.id !== 'string') return undefined;
  const one = (value: unknown): { identifier: string; id: string } | undefined => {
    const { identifier, note } = (value ?? {}) as { identifier?: unknown; note?: { id?: unknown } };

    return typeof identifier === 'string' && typeof note?.id === 'string' ? { identifier, id: note.id } : undefined;
  };
  // A batch names every note in `notes` (FRU-608), the first one included; a single note in `note`.
  const listed = Array.isArray(parsed.notes) ? parsed.notes.map(one) : [one(parsed)];
  if (listed.length === 0 || listed.some((each) => each === undefined)) return undefined;

  return {
    reason: parsed.reason,
    site: site.id,
    ...(typeof site.origin === 'string' ? { origin: site.origin } : {}),
    notes: listed as { identifier: string; id: string }[],
  };
}

/**
 * The body of a `POST /fire`: `text`, with identifiers only. The routine's saved prompt reads the
 * notes it names with `get_note` of `/mcp`. `mcp` is the public address of `/mcp`, when the worker
 * has one.
 */
export function fireBody(call: RoutineCall, mcp: string | undefined): string {
  const lines = [
    'Fruitback asks an agent to work on these notes. This block holds identifiers only.',
    `Reason: ${call.reason}`,
    `Site: ${call.site}${call.origin === undefined ? '' : ` (${call.origin})`}`,
    ...(mcp === undefined ? [] : [`MCP: ${mcp}`]),
    'Notes (read each with get_note):',
    ...call.notes.map((note) => `- ${note.identifier}: ${note.id}`),
  ];

  return JSON.stringify({ text: lines.join('\n') });
}

/** The longest answer of `/fire` the worker reads. The documented one is under 300 bytes. */
export const FIRE_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * The address of the session in an answer of `/fire`, or `undefined`. Only an `https` address of
 * `claude.ai` is taken: the console draws it as a link.
 */
export function sessionUrlOf(answer: string | undefined): string | undefined {
  if (answer === undefined) return undefined;
  try {
    const { claude_code_session_url: url } = JSON.parse(answer) as { claude_code_session_url?: unknown };
    if (typeof url !== 'string' || url.length > 512) return undefined;
    const parsed = new URL(url);

    return parsed.protocol === 'https:' &&
      parsed.hostname === 'claude.ai' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === ''
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
