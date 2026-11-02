/**
 * The messages between a page of the console and the extension of the same browser, written once
 * for both ends (FRU-487, FRU-512). The console asks with `chrome.runtime.sendMessage`; the extension
 * takes them in `runtime.onMessageExternal`, from the origin of its console only, and answers.
 *
 * A version that another end does not speak is not answered, and not read.
 */

/** The version of the messages. */
export const EXTERNAL_VERSION = 1;

/** The type of each message the console sends. */
export const EXTERNAL_TYPES = {
  hello: 'fruitback:hello',
  connect: 'fruitback:connect',
  claim: 'fruitback:claim',
} as const;

/**
 * What the console asks: whether the extension is here (`hello`), to start a request to connect
 * (`connect`), and to claim that request once the console approved it (`claim`).
 */
export type ExternalAsk =
  | { type: typeof EXTERNAL_TYPES.hello; v: typeof EXTERNAL_VERSION }
  | { type: typeof EXTERNAL_TYPES.connect; v: typeof EXTERNAL_VERSION }
  | { type: typeof EXTERNAL_TYPES.claim; v: typeof EXTERNAL_VERSION; request: string };

/** Where a request to connect is, as the extension says it. */
export const EXTERNAL_CONNECT_STATES = ['none', 'waiting', 'signed-in', 'refused', 'expired', 'unavailable'] as const;
export type ExternalConnectState = (typeof EXTERNAL_CONNECT_STATES)[number];

/** Why the extension refused a message. */
export const EXTERNAL_REFUSALS = ['signed-in', 'unavailable', 'unknown-request'] as const;
export type ExternalRefusal = (typeof EXTERNAL_REFUSALS)[number];

/**
 * What the extension answers: to `hello`, whether it holds a session; to `connect`, the id of the
 * request; to `claim`, where the request is; or a refusal.
 */
export type ExternalAnswer =
  | { v: typeof EXTERNAL_VERSION; ok: true; signedIn: boolean }
  | { v: typeof EXTERNAL_VERSION; ok: true; request: string }
  | { v: typeof EXTERNAL_VERSION; ok: true; state: ExternalConnectState }
  | { v: typeof EXTERNAL_VERSION; ok: false; reason: ExternalRefusal };

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value);

/**
 * An answer of the extension, key by key, or `undefined` for anything else: another version, a value
 * of the wrong kind, a state or a reason the protocol does not have. A positive answer holds exactly
 * one of `signedIn`, `request` and `state`: one that holds two is no answer, rather than read by the
 * first. Keys it does not know are left out of what it answers.
 */
export function parseExternalAnswer(answer: unknown): ExternalAnswer | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { v, ok, signedIn, request, state, reason } = answer as Record<string, unknown>;
  if (v !== EXTERNAL_VERSION) return undefined;
  if (ok === false) return isOneOf(EXTERNAL_REFUSALS, reason) ? { v, ok, reason } : undefined;
  if (ok !== true) return undefined;
  if ([signedIn, request, state].filter((value) => value !== undefined).length !== 1) return undefined;
  if (typeof signedIn === 'boolean') return { v, ok, signedIn };
  if (typeof request === 'string') return { v, ok, request };
  if (isOneOf(EXTERNAL_CONNECT_STATES, state)) return { v, ok, state };

  return undefined;
}
