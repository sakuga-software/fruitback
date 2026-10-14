import { digest } from './session.ts';

/**
 * The extension asks, the console approves (FRU-238): how a browser is connected to an account.
 *
 * It is the home-made pairing of `session.ts`, turned around. There, an operator mints a code for a
 * person and the extension spends it. Here, the extension starts a request, and a person signed in to
 * the console approves it. better-auth has a plugin for this (`device-authorization`), and it stays
 * refused (`REFUSED_PLUGINS` of `auth.ts`): it ends in a session of better-auth, and the extension
 * keeps its own session, which rotates.
 *
 * What is taken from RFC 8628 (the device authorization grant), and what is not:
 *
 * - **Two values, one secret.** `request` is public: it is in the address the extension opens in the
 *   console. `claim` is the secret the extension alone keeps, and the one thing that turns an
 *   approved request into a session. It never travels in an address, so a request id that leaks (a
 *   history, a log, a shoulder) is worth no token. The RFC's `device_code` is `claim`.
 * - **A word that both screens show** (« PLUM 47 »), the RFC's `user_code`. The RFC has the person
 *   type it; here the extension opens the page with the request in it, and the person checks that the
 *   console shows the word of the popup. It is a comparison for the eye, and not a secret: it is drawn
 *   apart from `request`, so nothing reads one from the other. The approval sends it back, so an
 *   approval is of the request that was shown, and five wrong words refuse the request.
 * - **Polling with an interval and `slow-down`**, as the RFC's `slow_down`. A claim polled faster
 *   than `CONNECT_INTERVAL_SECONDS` is answered `429` with a longer interval.
 * - **A short life and one use.** A request lives `CONNECT_TTL_SECONDS`, is answered once (approved
 *   or refused, by one account, the first answer wins), and is claimed once: the session is written
 *   in the transaction that spends it.
 * - **Not taken:** the RFC's `verification_uri` with no code, where the person types the word. The
 *   extension opens the address with the request in it: that is the click the maquette has.
 *
 * **What the session is.** It belongs to the account that approved, and not to one workspace: it
 * reads the sites of every workspace the account is a member of, and the role is read at each request
 * (`verifyForClient` of `app.ts`, `session-sites.ts`). It is still a session of the extension: the
 * console refuses its token (FRU-202), and it never gives more than the role of the person.
 */

/** Long enough to sign in first, short enough that a request left open is not one to approve later. */
export const CONNECT_TTL_SECONDS = 15 * 60;

/** How often the extension may ask whether the request was answered. */
export const CONNECT_INTERVAL_SECONDS = 5;

/**
 * How long a claim is remembered for `slow-down`: one second under the interval announced. A poll
 * that comes on time, or a little early after a slow first one, is not paced (raised in review).
 */
export const POLL_WINDOW_SECONDS = CONNECT_INTERVAL_SECONDS - 1;

/** Added to the interval of a claim polled too fast, as RFC 8628 says of `slow_down`. */
export const SLOW_DOWN_SECONDS = 5;

/** Requests one address may start in `CONNECT_WINDOW_MS`, beside the limit of every route. */
export const CONNECTS_PER_ADDRESS = 10;
export const CONNECT_WINDOW_MS = 15 * 60 * 1000;

/** Requests that nobody answered yet, on the whole instance: a flood fills this and nothing more. */
export const MAX_LIVE_REQUESTS = 1000;

/** Wrong words typed against one request before it is refused. */
export const MAX_WORD_MISSES = 5;

/** The longest browser label kept, in characters. */
export const MAX_BROWSER_LENGTH = 60;

/** What a request says when the extension gave no label. */
export const UNNAMED_BROWSER = 'A browser';

/** 128 bits: public, but never guessed. */
const REQUEST_BYTES = 16;

/** 256 bits, like a refresh token: it is worth one. */
const CLAIM_BYTES = 32;

/**
 * The words of « PLUM 47 »: short, in capitals, none the start of another, none read as another
 * aloud. Fruit first, as the product. 64 words and two digits: 6,400 words, and none of it a secret.
 */
export const WORDS: readonly string[] = [
  'PLUM',
  'PEAR',
  'LIME',
  'KIWI',
  'FIG',
  'MANGO',
  'PEACH',
  'LEMON',
  'MELON',
  'GRAPE',
  'APPLE',
  'OLIVE',
  'GUAVA',
  'DATE',
  'QUINCE',
  'BERRY',
  'CHERRY',
  'PRUNE',
  'YUZU',
  'NUT',
  'ACORN',
  'SEED',
  'LEAF',
  'ROOT',
  'BARK',
  'BLOOM',
  'PETAL',
  'STEM',
  'VINE',
  'MOSS',
  'FERN',
  'REED',
  'OAK',
  'PINE',
  'MAPLE',
  'CEDAR',
  'BIRCH',
  'ELM',
  'WILLOW',
  'ASPEN',
  'RIVER',
  'LAKE',
  'CLOUD',
  'STONE',
  'SAND',
  'HILL',
  'FIELD',
  'MEADOW',
  'RAIN',
  'SNOW',
  'FROST',
  'WIND',
  'STORM',
  'SUN',
  'MOON',
  'STAR',
  'CORAL',
  'AMBER',
  'JADE',
  'OPAL',
  'OCHRE',
  'IVORY',
  'SLATE',
  'CLAY',
];

/** One unsigned integer below `bound`, with no bias: draws over the last whole multiple are drawn again. */
function below(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1)) as unknown as [number];
    if (value < limit) return value % bound;
  }
}

/** « PLUM 47 »: drawn on its own, so it says nothing of the request, of the claim, or of the hour. */
export function drawWord(): string {
  return `${WORDS[below(WORDS.length)] as string} ${String(below(100)).padStart(2, '0')}`;
}

/** The word as a person may type it: capitals, one space. « plum47 » and « PLUM  47 » are « PLUM 47 ». */
export function normalizeWord(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = /^([A-Z]+)([0-9]{2})$/.exec(compact);

  return match === null ? compact : `${match[1]} ${match[2]}`;
}

function randomId(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export function createRequestId(): string {
  return randomId(REQUEST_BYTES);
}

export function createClaim(): string {
  return randomId(CLAIM_BYTES);
}

/** The public name of a connection, in « My account ». */
export function createConnectionId(): string {
  return randomId(REQUEST_BYTES);
}

/** A request id as this worker writes it: anything else is not looked up. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

/** A claim as this worker writes it. A truncated or padded one is no claim, and is not digested. */
export function isClaim(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** A connection id as this worker writes it. */
export function isConnectionId(value: unknown): value is string {
  return isRequestId(value);
}

/**
 * The label the extension gave, as the console may show it: printable, on one line, short.
 *
 * It is the caller's text, and the console shows it to the person who approves. So it loses what
 * would make it say something else than it reads: control characters, and the marks that turn the
 * direction of a line (« Chrome on macOS » written backwards to look like another). It is never
 * proof of anything: an attacker who starts a request names the browser they like.
 */
export function readBrowserLabel(value: unknown): string {
  if (typeof value !== 'string') return UNNAMED_BROWSER;
  const cleaned = value
    // A line break or a tab is a space; then the other controls, the marks of direction and the
    // invisible ones that hide a character go.
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  const characters = [...cleaned];
  const label =
    characters.length > MAX_BROWSER_LENGTH ? characters.slice(0, MAX_BROWSER_LENGTH).join('').trim() : cleaned;

  return label === '' ? UNNAMED_BROWSER : label;
}

/** A request as the store keeps it. */
export type ConnectRow = {
  word: string;
  browser: string;
  createdAt: number;
  expiresAt: number;
  outcome?: 'approved' | 'refused';
  account?: string;
  answeredAt?: number;
  claimedAt?: number;
  misses: number;
};

/** Where a request stands, as the console and the extension read it. */
export type ConnectState = 'pending' | 'approved' | 'refused' | 'claimed' | 'expired';

export function stateOf(row: ConnectRow, now: number): ConnectState {
  if (row.claimedAt !== undefined) return 'claimed';
  if (row.outcome === 'refused') return 'refused';
  // An approved request that nobody claimed in time is expired too: its claim buys nothing.
  if (row.expiresAt <= now) return 'expired';

  return row.outcome ?? 'pending';
}

/** What an answer of the console did. */
export type AnswerOutcome = { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'already' };

/** What a claim of the extension found. */
export type ClaimOutcome =
  | { state: 'pending' }
  | { state: 'refused' }
  /** Expired, claimed already, unknown, or approved by an account that is gone: one answer. */
  | { state: 'gone' }
  | { state: 'claimed'; account: string; browser: string };

/** A session of an account, as « My account » lists it. */
export type ConnectedBrowser = { id: string; browser: string; connectedAt: number; usedAt: number };

/**
 * What the requests need to persist. PostgreSQL only: a request is approved by an account, and a
 * worker keeps accounts in PostgreSQL alone.
 */
export type ConnectStore = {
  /** `busy` when `maxLive` requests are already waiting for an answer. */
  createRequest(request: {
    requestHash: string;
    claimHash: string;
    word: string;
    browser: string;
    now: number;
    expiresAt: number;
    maxLive: number;
  }): Promise<'created' | 'busy'>;
  readRequest(requestHash: string): Promise<ConnectRow | undefined>;
  /**
   * Approves or refuses, for one account. One statement decides: of two answers at the same instant,
   * one changes the row, and the other reads `already`.
   */
  answer(answer: {
    requestHash: string;
    account: string;
    outcome: 'approved' | 'refused';
    now: number;
  }): Promise<AnswerOutcome>;
  /** Counts a wrong word, and refuses the request at `max`. The words left, or `undefined`: no longer pending. */
  miss(requestHash: string, now: number, max: number): Promise<number | undefined>;
  /**
   * Spends an approved request and writes its session, in one transaction. `open` reads the account
   * it was approved for: `undefined` (an account that is gone) leaves no session, and the answer is
   * `gone`.
   */
  claim(claim: {
    claimHash: string;
    now: number;
    tokenHash: string;
    connectionId: string;
    expiresAt: number;
    open: (account: string) => Promise<{ name?: string; email?: string } | undefined>;
  }): Promise<ClaimOutcome>;
  /** The live sessions of an account, one entry per connection. */
  browsersOf(account: string, now: number): Promise<ConnectedBrowser[]>;
  /** Ends one connection of this account. `false`: none of this account has that id. */
  endBrowser(account: string, connectionId: string, now: number): Promise<boolean>;
  /** Drops the requests that expired. */
  purge(now: number): Promise<void>;
};

export type StartedRequest = {
  request: string;
  claim: string;
  word: string;
  browser: string;
  expiresAt: number;
};

/** A new request, kept as digests. `undefined`: the instance has `MAX_LIVE_REQUESTS` waiting. */
export async function startConnect(
  store: ConnectStore,
  browser: string,
  now: number = Date.now(),
): Promise<StartedRequest | undefined> {
  await store.purge(now);
  const request = createRequestId();
  const claim = createClaim();
  const word = drawWord();
  const expiresAt = now + CONNECT_TTL_SECONDS * 1000;
  const created = await store.createRequest({
    requestHash: await digest(request),
    claimHash: await digest(claim),
    word,
    browser,
    now,
    expiresAt,
    maxLive: MAX_LIVE_REQUESTS,
  });

  return created === 'busy' ? undefined : { request, claim, word, browser, expiresAt };
}
