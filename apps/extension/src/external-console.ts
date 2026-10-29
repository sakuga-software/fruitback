import { type ConnectSeams, type ConnectState, REQUEST, pollConnect, startConnect, trustedConsole } from './connect.ts';
import { DEFAULT_CLOUD, cloudEndpoint } from './popup-state.ts';
import type { BrowserFamily } from './browser-family.ts';

/**
 * The console of Fruitback Cloud talks to the extension of the same browser (FRU-487).
 *
 * Step 3 of the setup sees that the extension is installed, and connects it in place: no tab
 * `/connect`, no word to compare, no click on the icon. The page sends a runtime message to the
 * extension, which Chrome allows only from the origins of `externally_connectable` in the manifest.
 *
 * **Nothing secret crosses this channel.** The extension starts the request with its Cloud, as the
 * popup does, and keeps the `claim` in `storage.session`. The page receives the `request` only, the id
 * that the popup already puts in the address of the console tab. The console approves it with its own
 * session (the cookie and the `Origin` that the worker checks), and the session goes to the holder of
 * the claim: the extension. The proof of possession is the claim, and it never leaves the extension.
 *
 * The word is not compared because the channel itself says which browser asks: Chrome delivers the
 * message from a tab of this browser, and gives its origin. A page of another site cannot send it.
 *
 * Firefox does not implement `externally_connectable` (bug 1319168). Safari has it since 15.4, partly,
 * but nobody measured it here, and the id of the Safari extension is not the one of the store. Both
 * keep the flow with the word (`connect.ts`). See `docs/decisions/extension.md`, and the threat model in `SECURITY.md`.
 *
 * No `browser` and no `import.meta.env` here: `wxt.config.ts` and `node --test` read every part.
 */

/** The console of Fruitback Cloud, for a build that signs in to the Cloud of Sakuga Software. */
export const DEFAULT_CONSOLE = 'https://app.fruitback.com';

/**
 * The origin of the console that may talk to the extension, out of `WXT_FRUITBACK_CONSOLE` and
 * `WXT_FRUITBACK_CLOUD`, fixed at build. `undefined`: no console may, and the manifest has no
 * `externally_connectable`.
 *
 * - No Cloud (a build for a self-hosted instance): none.
 * - Absent: `https://app.fruitback.com` for the Cloud of Sakuga Software, none for another Cloud.
 * - Empty: none.
 * - Anything else must be one exact origin: https (http on loopback only, for the dev loop), no path,
 *   no query, no fragment, no user, no joker, and of the site of the Cloud, as `approvalPage` asks.
 *   A value that is not is an error of the build: `wxt.config.ts` stops on it.
 */
export function cloudConsole(rawConsole: string | undefined, rawCloud: string | undefined): string | undefined {
  const cloud = cloudEndpoint(rawCloud);
  if (cloud === undefined) return undefined;
  if (rawConsole === undefined) return cloud === DEFAULT_CLOUD ? DEFAULT_CONSOLE : undefined;
  const value = rawConsole.trim();
  if (value === '') return undefined;
  const origin = exactOrigin(value);
  if (origin === undefined || !trustedConsole(new URL(cloud), new URL(origin))) {
    throw new Error(`WXT_FRUITBACK_CONSOLE must be one exact https origin of the site of ${cloud}: ${value}`);
  }

  return origin;
}

/** `https://app.fruitback.com`, written with nothing after it, or `undefined`. */
function exactOrigin(value: string): string | undefined {
  if (value.includes('*')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== '/' || /[?#]/.test(value)) return undefined;
  if (value.replace(/\/$/, '') !== url.origin) return undefined;

  return url.origin;
}

/**
 * The key of the manifest, for the Chromium build only. A match pattern needs a path, and `/*` is
 * the only one: the host is exact. Without `ids`, the key also closes the extension to the messages
 * of every other extension, which an absent key lets in.
 */
export function externallyConnectable(
  origin: string | undefined,
  family: BrowserFamily,
): { matches: string[] } | undefined {
  if (origin === undefined || family !== 'chromium') return undefined;

  return { matches: [`${origin}/*`] };
}

/** The version of the messages. A page that speaks another one is not answered. */
export const EXTERNAL_VERSION = 1;

/** The three messages a console sends. */
export type ExternalMessage = { kind: 'hello' } | { kind: 'connect' } | { kind: 'claim'; request: string };

const TYPES = { 'fruitback:hello': 'hello', 'fruitback:connect': 'connect', 'fruitback:claim': 'claim' } as const;

/**
 * A message of the console, key by key: a plain object with exactly the keys of its type, or
 * nothing. A key more, a key less, another version, a request that is not base64url: nothing.
 */
export function parseExternalMessage(message: unknown): ExternalMessage | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  if (Object.getPrototypeOf(message) !== Object.prototype) return undefined;
  const fields = message as Record<string, unknown>;
  const type = fields.type;
  if (typeof type !== 'string' || !Object.hasOwn(TYPES, type)) return undefined;
  if (fields.v !== EXTERNAL_VERSION) return undefined;
  const kind = TYPES[type as keyof typeof TYPES];
  const keys = Object.keys(fields).toSorted();
  if (kind === 'claim') {
    if (keys.join(',') !== 'request,type,v') return undefined;
    const { request } = fields;

    return typeof request === 'string' && REQUEST.test(request) ? { kind, request } : undefined;
  }

  return keys.join(',') === 'type,v' ? { kind } : undefined;
}

/** The sender of an external message, as `runtime.onMessageExternal` gives it. */
export type ExternalSender = { id?: string; origin?: string; url?: string; frameId?: number; tab?: { id?: number } };

/**
 * Whether the message comes from the console: the top frame of a tab, on its exact origin, as the
 * browser reports it. A frame is refused (the console sends `frame-ancestors 'none'` too), and so is
 * another extension, whose origin is its own.
 */
export function fromConsole(sender: ExternalSender, consoleOrigin: string | undefined): boolean {
  if (consoleOrigin === undefined || sender.origin !== consoleOrigin) return false;
  if (sender.tab === undefined || sender.frameId !== 0 || sender.url === undefined) return false;
  try {
    return new URL(sender.url).origin === consoleOrigin;
  } catch {
    return false;
  }
}

export type ExternalAnswer =
  | { v: 1; ok: true; signedIn: boolean }
  | { v: 1; ok: true; request: string }
  | { v: 1; ok: true; state: ConnectState }
  | { v: 1; ok: false; reason: 'signed-in' | 'unavailable' | 'unknown-request' };

export type ExternalSeams = {
  /** The console that may talk, from `cloudConsole`. */
  console: string | undefined;
  /** The Cloud the extension signs in to, from `cloudEndpoint`. The page never names one. */
  cloud: string | undefined;
  connect: ConnectSeams;
  now?: () => number;
};

/**
 * The message, when it is one of the console to answer: from the console (`fromConsole`), in the shape
 * of its type (`parseExternalMessage`), in a build that signs in to a Cloud. Decided before any
 * `await`, so a message that is not answered closes its channel at once: the browser tells the page
 * that nobody answered, as if no extension were here.
 */
export function acceptedExternal(
  message: unknown,
  sender: ExternalSender,
  seams: Pick<ExternalSeams, 'console' | 'cloud'>,
): ExternalMessage | undefined {
  if (seams.cloud === undefined || !fromConsole(sender, seams.console)) return undefined;

  return parseExternalMessage(message);
}

/**
 * Answers a message that `acceptedExternal` took.
 *
 * - `hello`: the extension is here, and whether it holds a session of the Cloud. Nothing else: no
 *   account, no version, no site.
 * - `connect`: starts a request with the Cloud, or takes the one that waits (`startConnect` keeps one
 *   at a time), and answers its id. Refused while a session of the Cloud is held: a page cannot
 *   swap the account of a browser that is signed in. The popup signs out first.
 * - `claim`: claims the request now, rather than at the next alarm, and says where it is. Only the
 *   request that waits, and once per interval of the worker: a page cannot make the extension call
 *   the worker in a loop.
 */
export function createExternalConsole(seams: ExternalSeams & { cloud: string }) {
  let lastClaim = Number.NEGATIVE_INFINITY;

  return async (asked: ExternalMessage): Promise<ExternalAnswer> => {
    const { console: consoleOrigin, cloud, connect } = seams;
    const signedIn = (await connect.sessions.list())[cloud] !== undefined;

    if (asked.kind === 'hello') return { v: 1, ok: true, signedIn };
    if (asked.kind === 'connect') {
      if (signedIn) return { v: 1, ok: false, reason: 'signed-in' };
      const started = await startConnect(cloud, connect);
      // The request must be approved by this console: the worker named it, and `approvalPage` checked it.
      if (!started.ok || new URL(started.pending.consoleAt).origin !== consoleOrigin) {
        return { v: 1, ok: false, reason: 'unavailable' };
      }

      return { v: 1, ok: true, request: started.pending.request };
    }

    const pending = await connect.pending.read();
    if (pending === undefined || pending.request !== asked.request) {
      // Ended already, by the popup or the alarm: a session held is this request's.
      return signedIn ? { v: 1, ok: true, state: 'signed-in' } : { v: 1, ok: false, reason: 'unknown-request' };
    }
    const now = seams.now?.() ?? Date.now();
    if (now - lastClaim < pending.interval * 1000) return { v: 1, ok: true, state: 'waiting' };
    lastClaim = now;

    return { v: 1, ok: true, state: await pollConnect(connect, { keep: true }) };
  };
}
