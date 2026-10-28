import { type AgentKey, MAX_AGENT_KEY_DAYS } from './api.ts';

/**
 * What the screen « Agents » computes from a key (FRU-462): its end in days, the warning before it,
 * the line that connects Claude Code, and the days typed in the form.
 */

const DAY_MS = 86_400_000;

/** How many days before its end a key is said to end soon: decision 8 of `agents.md`. */
export const ENDS_SOON_DAYS = 7;

/**
 * Where a key stands: `ended` at its end and after, `soon` with the whole days left (1 to 7, a part
 * of a day counts as one), and `ok` before. The worker refuses a key from its end on.
 */
export function keyEnd(
  key: Pick<AgentKey, 'expiresAt'>,
  now: number,
): { state: 'ok' } | { state: 'soon'; days: number } | { state: 'ended' } {
  const left = Date.parse(key.expiresAt) - now;
  if (Number.isNaN(left)) return { state: 'ok' };
  if (left <= 0) return { state: 'ended' };
  const days = Math.ceil(left / DAY_MS);

  return days <= ENDS_SOON_DAYS ? { state: 'soon', days } : { state: 'ok' };
}

/**
 * The line that connects Claude Code to the MCP server of this worker, with the key in it: the one
 * `docs/agents.md` writes. `api` is the address of the worker, with no slash at its end.
 */
export function claudeLine(api: string, secret: string): string {
  return `claude mcp add --transport http fruitback ${api}/mcp \\\n  --header "Authorization: Bearer ${secret}"`;
}

/** The days typed in the form, or `undefined`: a whole number from 1 to `MAX_AGENT_KEY_DAYS`. */
export function daysOf(typed: string): number | undefined {
  if (!/^\s*\d+\s*$/.test(typed)) return undefined;
  const days = Number(typed);

  return days >= 1 && days <= MAX_AGENT_KEY_DAYS ? days : undefined;
}

/** The moment a key made now for `days` ends, as the worker computes it. */
export function endOf(days: number, now: number): string {
  return new Date(now + days * DAY_MS).toISOString();
}

/** The status an agent set, with no `own:` before it: the key of a status of the site. */
export function statusKey(status: string | undefined): string {
  return (status ?? '').replace(/^own:/, '');
}
