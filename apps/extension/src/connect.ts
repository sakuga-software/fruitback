import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { ClaimResult, SessionResponse, Sessions, StoredSession } from './session.ts';

/**
 * « Sign in to Fruitback »: the extension asks, the console approves (FRU-251, Q8 of FRU-230).
 *
 * `POST /session/connect` gives three things (the shape is FRU-238's). `request` is public: it goes in
 * the address of the console tab, `verificationUri`, where the person approves. `word` is shown in the popup **and** in the console, so
 * the person checks that the tab they approve is the request of this browser. `claim` is the secret
 * that takes the session once it is approved: **it never goes in an address, in the page, or in
 * `storage.local`**. It lives in `storage.session`, which the browser empties when it closes and
 * keeps from content scripts, the area of the access token.
 *
 * The popup claims while it is open, and the background claims on an alarm while it is closed, so
 * the person can approve in the tab and come back to a popup that is already signed in.
 *
 * Written against seams, like `session.ts`, so every state runs under `node --test`.
 */

/** A request that waits for the console, as this browser keeps it. */
export type PendingConnect = {
  endpoint: string;
  request: string;
  claim: string;
  word: string;
  /** The page of the console that approves it, checked by `approvalPage` before it was kept. */
  approveAt: string;
  /** The console itself, for « Open the console » once signed in. */
  consoleAt: string;
  expiresAt: number;
  /** How many seconds the worker wants between two claims. */
  interval: number;
  /** The session this endpoint held when the request started: see `pollConnect`. */
  before?: string;
};

/** Where the one pending request is kept. Only `storage.session` binds it in the extension. */
export type PendingArea = {
  read(): Promise<PendingConnect | undefined>;
  write(pending: PendingConnect | undefined): Promise<void>;
};

export type ConnectSeams = {
  pending: PendingArea;
  post(url: string, body: Record<string, unknown>): Promise<SessionResponse>;
  sessions: Pick<Sessions, 'claim' | 'list'>;
  /** « Chrome on macOS »: what the console shows of the browser that asks (Q7). */
  browser: string;
  now?: () => number;
  /** Waits, for `pollConnect` to give the other context time to store its session. */
  wait?: (ms: number) => Promise<void>;
};

export type StartFailure = 'unavailable' | 'insecure-endpoint' | 'untrusted-console';
export type StartResult = { ok: true; pending: PendingConnect } | { ok: false; reason: StartFailure };

/**
 * What a request is now, as the popup draws it.
 *
 * `none`: no request. `waiting`: in the console's hands. `signed-in`: approved, the session is kept.
 * `refused`, `expired`: over, and gone from storage. `unavailable`: Fruitback did not answer this
 * time, and the request is still kept.
 */
export type ConnectState = 'none' | 'waiting' | 'signed-in' | 'refused' | 'expired' | 'unavailable';

/** How many times, and how far apart, a spent request looks for the session the other context stores. */
const SPENT_LOOKS = 4;
const SPENT_LOOK_MS = 500;

/** Longer than this is not believed: a worker that says a day keeps a secret a day. */
const MAX_LIFETIME_MS = 30 * 60 * 1000;

/** The pace of the claims, in seconds: FRU-238 says five, and a worker is believed within these. */
export const DEFAULT_INTERVAL = 5;
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 60;

/**
 * Start a sign-in with the Fruitback at `endpoint`, or take the one already waiting there.
 *
 * **One request at a time.** Two popups, or a popup opened twice, would otherwise make two requests,
 * and the person would approve one word while the popup shows the other. A request still alive for
 * this endpoint is given back as it is; « Start again » forgets it first (`forgetConnect`).
 */
export async function startConnect(endpoint: string, seams: ConnectSeams): Promise<StartResult> {
  const now = seams.now?.() ?? Date.now();
  // Same rule as a pairing: the claim is spent for a refresh token worth thirty days.
  if (!isSecureWorkerEndpoint(endpoint)) return { ok: false, reason: 'insecure-endpoint' };

  const kept = await seams.pending.read();
  if (kept !== undefined && kept.endpoint === endpoint && kept.expiresAt > now) return { ok: true, pending: kept };

  let answer: SessionResponse;
  try {
    answer = await seams.post(`${endpoint}/session/connect`, { browser: seams.browser });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const started = answer.status === 201 || answer.status === 200 ? parseStarted(answer.body) : undefined;
  if (started === undefined) return { ok: false, reason: 'unavailable' };

  // **The worker names the console, and the console is a page this click opens.** A worker that
  // is not the one we asked, or a body changed on the way, must not open any page it likes: the
  // console has to be the site of the worker, over https, and the page the one of this request.
  const page = approvalPage(endpoint, started.verificationUri, started.request);
  if (page === undefined) return { ok: false, reason: 'untrusted-console' };

  const held = (await seams.sessions.list())[endpoint];
  const pending: PendingConnect = {
    endpoint,
    request: started.request,
    claim: started.claim,
    word: started.word,
    approveAt: page.approveAt,
    consoleAt: page.consoleAt,
    expiresAt: now + Math.min(started.expiresIn * 1000, MAX_LIFETIME_MS),
    interval: Math.min(Math.max(started.interval ?? DEFAULT_INTERVAL, MIN_INTERVAL), MAX_INTERVAL),
    ...(held === undefined ? {} : { before: runOf(held) }),
  };
  await seams.pending.write(pending);

  return { ok: true, pending };
}

/**
 * Claim the pending request once, and say what it is now.
 *
 * Called by the popup every few seconds while it is open, and by the background on an alarm. Both
 * can claim at the same instant: the worker gives the session once, so the second is told the
 * request is spent. That is not a refusal when the session is now kept: `before` is the session the
 * endpoint held when the request started, and another one in its place is this request's.
 */
export async function pollConnect(seams: ConnectSeams): Promise<ConnectState> {
  const now = seams.now?.() ?? Date.now();
  const pending = await seams.pending.read();
  if (pending === undefined) return 'none';

  if (pending.expiresAt <= now) {
    await forgetIf(seams.pending, pending);

    return 'expired';
  }

  let result: ClaimResult;
  try {
    result = await seams.sessions.claim(pending.endpoint, pending.claim);
  } catch {
    return 'unavailable';
  }

  if (result.ok) {
    await forgetIf(seams.pending, pending);

    return 'signed-in';
  }
  if (result.reason === 'waiting') return 'waiting';
  if (result.reason === 'unavailable') return 'unavailable';

  // Refused, expired or spent. Spent by the other context is a sign-in: its session is there now,
  // or will be in a moment. The other context was answered first and stores the session in three
  // writes, so a claim answered just after can find nothing yet: it looks again before it says
  // « expired ». A refusal is never a spent request, so it is said at once.
  await forgetIf(seams.pending, pending);
  if (result.reason === 'refused') return 'refused';
  const wait = seams.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let look = 0; look < SPENT_LOOKS; look += 1) {
    if (look > 0) await wait(SPENT_LOOK_MS);
    const held = (await seams.sessions.list())[pending.endpoint];
    if (held !== undefined && runOf(held) !== pending.before) return 'signed-in';
  }

  return 'expired';
}

/** « Start again »: the request is forgotten here. The worker lets it expire. */
export async function forgetConnect(seams: Pick<ConnectSeams, 'pending'>): Promise<void> {
  await seams.pending.write(undefined);
}

/**
 * The page of the console that approves `request`, and the console it is a page of; `undefined` when
 * the address the worker gave is not one this extension opens.
 *
 * The console must be https (loopback excepted, for the dev loop) and of the site of the worker: the
 * host of the worker, or a host under the domain the worker is under. `api.fruitback.com` opens
 * `app.fruitback.com`; it does not open `fruitback.com.evil.example`, nor a page of `com`. A worker
 * on a domain of two labels (`fruitback.com`) opens its own host and the hosts under it only. And the
 * page is `<console>/connect/<request>`, nothing else: no query, no fragment, no other path.
 */
export function approvalPage(
  endpoint: string,
  verificationUri: string,
  request: string,
): { approveAt: string; consoleAt: string } | undefined {
  let worker: URL;
  let page: URL;
  try {
    worker = new URL(endpoint);
    page = new URL(verificationUri);
  } catch {
    return undefined;
  }
  if (!trustedConsole(worker, page)) return undefined;
  if (page.search !== '' || page.hash !== '' || /[?#]/.test(verificationUri)) return undefined;
  const tail = `/connect/${request}`;
  if (!REQUEST.test(request) || !page.pathname.endsWith(tail)) return undefined;
  const base = page.pathname.slice(0, -tail.length);

  return { approveAt: `${page.origin}${page.pathname}`, consoleAt: `${page.origin}${base === '' ? '/' : base}` };
}

/** A request is base64url (FRU-238): it goes in an address as it is, with nothing to escape. */
const REQUEST = /^[A-Za-z0-9_-]{1,200}$/;

function trustedConsole(worker: URL, console: URL): boolean {
  if (console.username !== '' || console.password !== '') return false;
  const loopback = isLoopback(worker.hostname) && isLoopback(console.hostname);
  if (console.protocol !== 'https:' && !(loopback && console.protocol === 'http:')) return false;
  if (loopback) return true;

  const host = console.hostname.toLowerCase();
  const labels = worker.hostname.toLowerCase().split('.');
  // The worker's own host, and the hosts under it.
  const own = labels.join('.');
  if (host === own || host.endsWith(`.${own}`)) return true;
  // The domain the worker is under, when it has two labels at least: `api.client.co.uk` gives
  // `client.co.uk`, and `api.fruitback.com` gives `fruitback.com`.
  const parent = labels.slice(1);
  const domain = parent.join('.');
  // A domain somebody registers under, not one everybody does: `co.uk` would let `api.co.uk` open
  // `evil.co.uk`. No list of every public suffix travels with the extension; the ones of two labels
  // that a worker is likely to sit under are named, and a worker on another one opens its own host.
  if (parent.length < 2 || SHARED_SUFFIXES.has(domain)) return false;

  return host === domain || host.endsWith(`.${domain}`);
}

/** Public suffixes of two labels: a host under one of them is somebody else's site. */
const SHARED_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'com.br',
  'com.cn',
  'co.in',
  'co.za',
  'com.mx',
  'com.tr',
  'co.kr',
  'github.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'fly.dev',
  'onrender.com',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'appspot.com',
]);

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

type Started = {
  request: string;
  claim: string;
  word: string;
  verificationUri: string;
  expiresIn: number;
  interval?: number;
};

/** The answer of `POST /session/connect`, field by field: a field missing costs the request. */
export function parseStarted(body: unknown): Started | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { request, claim, word, verificationUri, expiresIn, interval } = body as Record<string, unknown>;
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!text(request, 200) || !text(claim, 500) || !text(word, 40) || !text(verificationUri, 1000)) return undefined;
  if (!REQUEST.test(request)) return undefined;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined;
  // The word is shown on the screen: no control character.
  if ([...word].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f))
    return undefined;
  const pace = typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined;

  return { request, claim, word, verificationUri, expiresIn, ...(pace === undefined ? {} : { interval: pace }) };
}

/**
 * Which run of a session this is (FRU-64): a pairing and a claim mint a new epoch, a refresh does
 * not. The generation would not do: a refresh in the background mints one while a request waits.
 */
function runOf(session: StoredSession): string {
  return session.epoch ?? '';
}

/** Forget the pending request, unless another one took its place in the meantime. */
async function forgetIf(area: PendingArea, pending: PendingConnect): Promise<void> {
  const now = await area.read();
  if (now?.request === pending.request) await area.write(undefined);
}

/**
 * The pending request, read back from `storage.session`: a shape an older version wrote, or a value
 * somebody else put there, costs the request and nothing else.
 */
export function parsePending(value: unknown): PendingConnect | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { endpoint, request, claim, word, approveAt, consoleAt, expiresAt, interval, before } = value as Record<
    string,
    unknown
  >;
  const texts = [endpoint, request, claim, word, approveAt, consoleAt];
  if (!texts.every((text) => typeof text === 'string' && text.length > 0)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return undefined;
  if (before !== undefined && typeof before !== 'string') return undefined;

  return {
    endpoint: endpoint as string,
    request: request as string,
    claim: claim as string,
    word: word as string,
    approveAt: approveAt as string,
    consoleAt: consoleAt as string,
    expiresAt,
    interval,
    ...(before === undefined ? {} : { before }),
  };
}

/**
 * « Chrome on macOS »: what the console shows of the browser that asks (Q7 of FRU-230), from its
 * user agent. Nothing else of it leaves: no version, no build, no device.
 */
export function browserLabel(userAgent: string): string {
  const name = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'A browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];

  return system === undefined ? name : `${name} on ${system}`;
}

/** In this order: Edge and Opera say Chrome too, and Chrome says Safari. */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/** In this order: ChromeOS and Android say Linux too, and an iPad can say Mac OS X. */
const SYSTEMS: [RegExp, string][] = [
  [/CrOS/, 'ChromeOS'],
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];
