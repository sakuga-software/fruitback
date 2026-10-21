/**
 * The texts that the mutated core of the worker says to a person: boot notices, the reasons of a
 * refused configuration, and the messages of its errors (FRU-347).
 *
 * They live here, outside the `mutate` list of `stryker.config.json`, by Mathieu's decision of
 * 2026-10-21. A mutant that empties one of these texts changes no decision of the worker, and nine
 * of them survived: the score of the core now counts its decisions only. The tests that read these
 * texts still read them; only the mutation run does not plant changes in them.
 *
 * A text that the worker decides with (a key, a header, a reason code such as `'malformed'`) stays in
 * its module and stays mutated.
 */

// kv.ts
export const KV_INCREMENT_NOT_POSITIVE = 'an increment is a positive integer';
export const KV_VALUE_NOT_INTEGER = 'value is not an integer';
export const KV_VALUE_OUT_OF_RANGE = 'value is out of range';

// clients.ts
export const READ_CHOSEN_IN_CONSOLE_NOTICE =
  '[fruitback] who reads a site is chosen site by site, in the console: members only, or everyone. ' +
  'FRUITBACK_READ does not apply to a worker with accounts.';

export function publicReadNotice(open: string[]): string {
  return (
    `[fruitback] read is public for ${open.join(', ')}: their pins, authors and replies ` +
    'are readable by anyone who can reach this worker. Set FRUITBACK_READ=authenticated, ' +
    'or "read": "authenticated" per client, to require a token.'
  );
}

export const CLIENT_MAP_NOT_JSON = 'not valid JSON';
export const CLIENT_MAP_EMPTY = 'no client in the map';

// store-config.ts
export function fakeLinearLostToExplicit(explicit: string): string {
  return `FRUITBACK_STORE=${explicit} was set explicitly`;
}

export const FAKE_LINEAR_LOST_TO_PRODUCTION = 'this process runs with NODE_ENV=production';

export function fakeLinearChangedNothing(explicit: string): string {
  return `FRUITBACK_STORE=${explicit} is set explicitly, so the flag changed nothing and the line can go`;
}

export const FAKE_LINEAR_SELECTED_MEMORY =
  'it is what selected the in-memory store here. Set FRUITBACK_STORE=memory instead';

// session.ts
export const END_SESSIONS_OF_NOBODY =
  'endSessionsOf names neither a person nor a workspace: it would end every session of the worker';
export const ACCOUNT_SESSION_WITH_WORKSPACE = 'a session of an account names no workspace';
