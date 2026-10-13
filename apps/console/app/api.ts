/**
 * The console's one way to the worker (FRU-99).
 *
 * **The console holds no token** (FRU-148). The worker keeps the session of the console in a cookie
 * that no script reads (`HttpOnly`, `SameSite=Strict`, `Path=/console`), and every call sends it
 * (`credentials: 'include'`, in `transport.ts`). There is nothing to refresh: the worker reads the
 * session in its database at each call. The sign-in of before, with its token in memory, went with
 * FRU-150.
 */

import { locale } from './i18n.ts';
import { API, UNREACHABLE, reach } from './transport.ts';

export { API, UNREACHABLE, onReachability } from './transport.ts';

export type Account = { id: string; email: string; name?: string; locale?: string };
export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type Workspace = { id: string; name: string; role: Role };
export type Visibility = 'members' | 'everyone';
/** Where the notes of a site go. Absent: they stay in the workspace. Only a member reads it. */
/** A tracker has teams, so `teamId` is there for one. An address that only receives has none (FRU-122). */
/** `label` is what a member reads when they choose (FRU-123). The worker writes it, from what the tracker answers. */
export type Destination = { connector: string; teamId?: string; projectId?: string; label?: string };
/**
 * `destinations` is every place the site can send to, in order (FRU-123): the first one is where a
 * note goes when nobody chose. `destination` is that first one, and all a worker of before sends.
 */
export type Site = {
  id: string;
  origin: string;
  visibility: Visibility;
  destination?: Destination;
  destinations?: Destination[];
};
/**
 * A domain the workspace says it owns (FRU-103), as the worker answers it. `state` is the worker's
 * word: `proven` only while the DNS shows `record`. `previews` is the pattern a proven domain covers,
 * and `previewsSite` the site an admin named for it.
 */
export type Domain = {
  id: string;
  domain: string;
  state: 'pending' | 'proven' | 'lost';
  record: { type: 'TXT'; name: string; value: string };
  previews: string;
  previewsSite?: string;
  verifiedAt?: string;
  lostAt?: string;
  checkedAt?: string;
};
/** How many places a site can send to: the bound of the worker. */
export const MAX_DESTINATIONS = 5;

/** Every place of a site, in order, whatever the age of the worker that answered. */
export function placesOf(site: Site): Destination[] {
  if (site.destinations !== undefined) return site.destinations;

  return site.destination === undefined ? [] : [site.destination];
}

/**
 * Whether a site can take one more place from this source: it sends there already, or it has room.
 * The worker refuses a sixth place, so a screen says the limit and does not offer the choice.
 */
export function hasRoomFor(site: Site, connector: string): boolean {
  const places = placesOf(site);

  return places.some((each) => each.connector === connector) || places.length < MAX_DESTINATIONS;
}

/** Whether two places are one: the same source, team and project. */
export function samePlace(one: Destination, other: Destination): boolean {
  return one.connector === other.connector && one.teamId === other.teamId && one.projectId === other.projectId;
}
/** Why a source needs somebody (FRU-102): its tracker refuses it since `since`. Absent: it works. */
export type ConnectorAttention = { reason: 'key-refused' | 'key-lacks-access' | 'connection-ended'; since: string };
export type Connector = {
  id: string;
  kind: 'linear' | 'rest';
  label: string;
  createdAt: string;
  attention?: ConnectorAttention;
  /** Absent from a worker of before FRU-102: the panel then has no settings to show. */
  settings?: ConnectorSettings;
};
/** The five stages of a pin, in the order of the widget. */
export const STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type Stage = (typeof STAGES)[number];
/** What a workspace sets on a tracker (FRU-102): the replies, and the stages some states take. */
export type ConnectorSettings = { showComments: boolean; stages: Record<string, Stage> };
/** A state of a team of the tracker, with the stage of its type. */
export type TrackerState = { id: string; name: string; type: string; teamId: string; team: string; stage: Stage };
/** A note that did not reach the address of a connector yet. `nextAt` absent: the worker gave up. */
export type Delivery = {
  id: string;
  createdAt: string;
  attempts: number;
  nextAt?: string;
  lastStatus?: number;
  lastError?: string;
};
export type Team = { id: string; name: string; key: string; projects: { id: string; name: string }[] };
export type Me = { account: Account; workspaces: Workspace[] };

export type Answer<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Whether the worker sends mail: `email` in what it says of better-auth. `undefined`: not asked yet. */
let mails: boolean | undefined;
/** Whether the worker signs anybody in: it said `betterAuth`. `undefined` until it said. */
let signsIn: boolean | undefined;

function send(method: string, to: string, body?: unknown): Promise<Response | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // No header names the person: the browser sends the cookie.
  return reach(to, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

type SignedOutListener = () => void;
const signedOutListeners = new Set<SignedOutListener>();

/**
 * Tells the listener when a call was refused because the session ended (FRU-148). The screen stays
 * as it is, with what the person typed: the root says so above it. Returns how to stop.
 */
export function onSignedOut(listener: SignedOutListener): () => void {
  signedOutListeners.add(listener);

  return () => void signedOutListeners.delete(listener);
}

async function answer<T>(response: Response | undefined): Promise<Answer<T>> {
  if (response === undefined) return UNREACHABLE;
  if (response.status === 204) return { ok: true, data: undefined as T };
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown } & T;
  // A refusal of the worker names itself in `error`, and one of better-auth in `code` (FRU-209):
  // without the second, no sentence a screen holds for a code of better-auth was ever shown.
  const named = [body.error, body.code].find((name) => typeof name === 'string') as string | undefined;

  return response.ok ? { ok: true, data: body } : { ok: false, status: response.status, error: named ?? 'unknown' };
}

/**
 * The account this tab was drawn for, and why the tab stopped (FRU-210).
 *
 * The cookie of a session belongs to the browser, not to a tab. Somebody who signs in in another tab
 * changes who every tab speaks for, and a screen that was drawn for the person before would send
 * what that person typed with the cookie of the new one. So the tab keeps the id of the first
 * account that `/console/me` answered, and stops when the worker answers another one:
 *
 * - `changed`: another account is signed in. Nothing leaves this tab any more, until it is loaded
 *   again.
 * - `ended`: the tab came back, and the session had ended somewhere else.
 *
 * A session that ends while somebody works (a `401` on a call they made) is not one of these: the
 * screen stays, with what they typed (FRU-148), and « Continue » goes on for the same account only.
 */
export type Left = 'changed' | 'ended';
let tabAccount: string | undefined;
let left: Left | undefined;
/** A call the person made was refused with `401`: the banner says so, and the screen stays. */
let endSeen = false;
let checking: Promise<void> | undefined;
const leftListeners = new Set<(why: Left) => void>();
/** What a call answers once the tab stopped. No request leaves. */
const LEFT = { ok: false, status: 409, error: 'tab-left' } as const;

/** Tells the listener when this tab stops, and why. Returns how to stop. */
export function onLeft(listener: (why: Left) => void): () => void {
  leftListeners.add(listener);

  return () => void leftListeners.delete(listener);
}

function leave(why: Left): void {
  if (left !== undefined) return;
  left = why;
  for (const listener of leftListeners) listener(why);
}

/**
 * Asks the worker who the browser is signed in as, when the tab comes back. A change of account
 * stops the tab; so does a session that ended while the tab was away.
 *
 * WARNING: every call waits for this one (`call`). Without the wait, a click in the moment after
 * the tab comes back leaves with the cookie of the other account, and a list that the screen reads
 * in that moment comes back with the data of the other account.
 */
export function checkTab(): Promise<void> {
  if (tabAccount === undefined || left !== undefined) return Promise.resolve();
  checking ??= ask('GET', '/console/me', undefined, { quiet: true })
    .then((me) => {
      // No answer, and a refusal that is not about the session, say nothing of who is signed in.
      if (!me.ok && me.status === 401 && !endSeen) leave('ended');
    })
    .finally(() => {
      checking = undefined;
    });

  return checking;
}

const RETRY_MS = 5_000;

/**
 * A call that a screen cannot draw without: asked again until the worker answers. `onAnswer` gets
 * every answer but `unreachable`. Returns how to stop, for the cleanup of an effect.
 */
export function callUntilAnswered<T>(method: string, path: string, onAnswer: (answer: Answer<T>) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = (): void => {
    // The screen that asks decides what a refusal means: it has nothing typed to keep.
    void call<T>(method, path, undefined, { quiet: true }).then((answer) => {
      if (stopped) return;
      if (!answer.ok && answer.status === 0) timer = setTimeout(ask, RETRY_MS);
      else onAnswer(answer);
    });
  };
  ask();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * A call of the console: the cookie goes with it, and nothing is refreshed.
 *
 * A `401` tells `onSignedOut`, unless `quiet`: the screen keeps what the person typed.
 */
export async function call<T>(
  method: string,
  to: string,
  body?: unknown,
  options: { quiet?: boolean } = {},
): Promise<Answer<T>> {
  // A call waits for the question of a tab that came back: its answer would be of whoever is signed
  // in now, and its change would be made in their name.
  if (checking !== undefined) await checking;

  return ask<T>(method, to, body, options);
}

/** The call itself, with no wait: the question of a tab that came back is asked through it. */
async function ask<T>(
  method: string,
  to: string,
  body?: unknown,
  options: { quiet?: boolean } = {},
): Promise<Answer<T>> {
  // A tab that stopped sends nothing.
  if (left !== undefined) return LEFT;
  const response = await send(method, to, body);
  if (response?.status === 401 && options.quiet !== true) {
    endSeen = true;
    for (const listener of signedOutListeners) listener();
  }
  const result = await answer<T>(response);
  if (method === 'GET' && to === '/console/me' && result.ok) {
    const id = (result.data as { account?: { id?: unknown } } | undefined)?.account?.id;
    if (typeof id === 'string') {
      if (tabAccount !== undefined && id !== tabAccount) {
        // The answer is of another account: no screen of this tab reads it.
        leave('changed');

        return LEFT;
      }
      tabAccount = id;
      endSeen = false;
    }
  }

  return result;
}

/** Tells the account the language its person chose (FRU-119). `false` when it did not take it. */
export function saveLanguage(tag: string): Promise<boolean> {
  return call('POST', '/console/me/locale', { locale: tag }).then((answer) => answer.ok);
}

/** Which providers the worker signs people in with (FRU-135), through better-auth. */
export type Providers = { github: boolean; google: boolean };

type Announced = { betterAuth?: Partial<Providers> & { email?: boolean } };

/**
 * `undefined` when the worker did not say: no answer, or a refusal. That is not "none": a screen
 * must not tell a person that a provider is not set up when nobody said so.
 *
 * A worker that says no `betterAuth` signs nobody in to the console: no provider, and no mail.
 */
export async function signInProviders(): Promise<Providers | undefined> {
  const asked = await answer<Announced>(await reach('/auth/providers', { method: 'GET' }));
  if (!asked.ok) return undefined;
  const said: Announced = typeof asked.data === 'object' && asked.data !== null ? asked.data : {};
  // An answer with no body said nothing: only a worker that answers its ways, and has none, is closed.
  if (typeof asked.data === 'object' && asked.data !== null) {
    signsIn = typeof said.betterAuth === 'object' && said.betterAuth !== null;
  }
  const served = typeof said.betterAuth === 'object' && said.betterAuth !== null ? said.betterAuth : {};
  mails = served.email === true;

  return { github: served.github === true, google: served.google === true };
}

/**
 * Where a sign-in with a provider starts: a navigation of the whole page to the worker, which sets
 * the cookie of the state in the first party. A `fetch` of `/sign-in/social` would set it on the
 * answer of a call, which WebKit did not keep (measured in FRU-147).
 */
export function providerStart(provider: keyof Providers): string {
  return `${API}/console/auth/start/${provider}`;
}

export async function requestLink(email: string, tag: string): Promise<Answer<{ sent: true }>> {
  // A tab that stopped signs nobody in, and signs nobody out: it is loaded again first (FRU-210).
  if (left !== undefined) return LEFT;

  return answer(await send('POST', '/console/auth/email', { email, locale: tag }));
}

/**
 * Spends the token of a link, read after the `#` of the address. The worker answers the account and
 * sets the cookie; the console keeps nothing.
 */
export async function redeemLink(code: string): Promise<Answer<{ account: Account }>> {
  if (left !== undefined) return LEFT;
  const redeemed = await answer<{ account: Account }>(
    await send('POST', '/console/auth/email/redeem', { token: code, locale: locale() }),
  );
  // A sign-in made in this tab: the tab is of that account from now on (FRU-210).
  if (redeemed.ok) {
    tabAccount = typeof redeemed.data?.account?.id === 'string' ? redeemed.data.account.id : undefined;
    endSeen = false;
  }

  return redeemed;
}

/**
 * Ends the session on the worker: the cookie is refused at the next call, in every tab.
 *
 * `false` when the worker did not say that the session ended (FRU-204). The screen then says so
 * and stays: somebody who reads « signed out » leaves the browser to the next person.
 */
export async function signOut(): Promise<boolean> {
  // The session of the browser is of another account now: this tab does not end it (FRU-210).
  if (left !== undefined) return false;
  const out = (await send('POST', '/console/auth/sign-out', {}))?.ok === true;
  // Signed out here: the tab is of nobody, and the next sign-in in it says whose it is.
  if (out) tabAccount = undefined;

  return out;
}

/**
 * A session of the console of the person, as `GET /console/sessions` lists it (FRU-181): its id, and
 * never its token. `current` is the session of this browser. The worker also answers a user agent
 * when its operator switched that on; this type leaves it out, and no screen shows it (Q7 of FRU-230).
 */
export type ConsoleSession = { id: string; createdAt: string; lastUsedAt: string; current: boolean };

/** The sessions of the console of the person. A refusal is no list: the screen says it could not read. */
export async function consoleSessions(): Promise<Answer<ConsoleSession[]>> {
  const listed = await call<{ sessions?: ConsoleSession[] }>('GET', '/console/sessions');
  if (!listed.ok) return listed;

  return Array.isArray(listed.data?.sessions)
    ? { ok: true, data: listed.data.sessions }
    : { ok: false, status: 200, error: 'unknown' };
}

/**
 * Ends one session of the person by its id: its browser is refused at its next call.
 *
 * `unknown`: the worker answered `404`. Its route says so for an id that the person has no session
 * by, but a worker with no such route says it too: the caller reads the list again before it says
 * that the session ended.
 */
export async function endConsoleSession(id: string): Promise<'ended' | 'unknown' | 'failed'> {
  const ended = await call('DELETE', `/console/sessions/${encodeURIComponent(id)}`);
  if (ended.ok) return 'ended';

  return ended.status === 404 ? 'unknown' : 'failed';
}

/**
 * « Sign out everywhere »: ends every session of the person on the worker, this one too.
 *
 * `false` when the worker did not say so, as `signOut` (FRU-204): the screen then says that the
 * sessions may still be open, and stays.
 */
export async function signOutEverywhere(): Promise<boolean> {
  // The session of the browser is of another account now: this tab does not end it (FRU-210).
  if (left !== undefined) return false;
  const out = (await send('POST', '/console/auth/revoke-sessions', {}))?.ok === true;
  if (out) tabAccount = undefined;

  return out;
}

/**
 * Whether the worker sends the message of an invitation (FRU-104). Without a mailer it keeps the
 * invitation all the same, and the person who invites sends `invitationLink()` by hand.
 */
/**
 * Whether the worker signs anybody in (FRU-217). `false`: it answered, and offers no way at all,
 * which is a worker with accounts and no `FRUITBACK_AUTH_SECRET`. The sign-in screen then says so,
 * and shows no form: a link asked for there is never sent. `undefined`: the worker did not say, and
 * the screen keeps its form.
 */
export async function offersSignIn(): Promise<boolean | undefined> {
  if (signsIn === undefined) await signInProviders();

  return signsIn;
}

export async function sendsMail(): Promise<boolean> {
  if (mails === undefined) await signInProviders();

  return mails === true;
}

/**
 * The link of every invitation: the page of the console that lists the invitations of whoever signed
 * in. It names no invitation and opens nothing by itself, so it can be sent by hand, in a chat.
 */
export function invitationLink(origin: string = window.location.origin): string {
  return `${origin}/invitations`;
}

/** Where the routes of the organization plugin are, on the worker (FRU-149). */
export const ORGANIZATION = '/console/auth/organization';

/** A member of a workspace, as the worker lists them (FRU-149). */
export type Member = {
  id: string;
  userId: string;
  role: Role;
  createdAt: string;
  user: { id: string; email: string; name: string };
};

/** An invitation that waits (FRU-104). `organizationName` is there for the person it is for. */
export type Invitation = {
  id: string;
  email: string;
  role: Role;
  organizationId: string;
  organizationName?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled';
  expiresAt: string;
  createdAt?: string;
  /** In the answer to an invitation only: `false` when the worker kept it and sent no message. */
  mailed?: boolean;
};

/**
 * The invitations that wait for the person who is signed in: the ones sent to the address they proved.
 */
export async function myInvitations(): Promise<Answer<Invitation[]>> {
  return call<Invitation[]>('GET', `${ORGANIZATION}/list-user-invitations`, undefined, { quiet: true });
}

/** The worker's pairing page with a code after the `#`: the extension reads it from there (FRU-92). */
export function pairingLink(code: string): string {
  return `${API}/pair#${code}`;
}

/**
 * The name typed before the link was sent, kept for the moment the link is opened. A convenience: when
 * storage is refused, the person types it again.
 */
const PENDING = 'fruitback:pending-workspace';

export function rememberWorkspaceName(name: string): void {
  try {
    localStorage.setItem(PENDING, name);
  } catch {
    // Private browsing can refuse storage. The name is asked again after the sign-in.
  }
}

export function takeWorkspaceName(): string | undefined {
  try {
    const name = localStorage.getItem(PENDING) ?? undefined;
    localStorage.removeItem(PENDING);

    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * Sets every place a site sends to, in order (FRU-123). The label is not sent: the worker writes it.
 */
export function setPlaces(base: string, site: Site, places: readonly Destination[]): Promise<Answer<unknown>> {
  return call('POST', `${base}/sites/${site.id}/destinations`, {
    destinations: places.map(({ connector, teamId, projectId }) => ({
      connector,
      ...(teamId === undefined ? {} : { teamId }),
      ...(projectId === undefined ? {} : { projectId }),
    })),
  });
}
