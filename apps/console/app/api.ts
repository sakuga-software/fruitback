/**
 * The console's one way to the worker (FRU-99).
 *
 * **The console holds no token** (FRU-148). A worker that serves better-auth keeps the session of the
 * console in a cookie that no script reads (`HttpOnly`, `SameSite=Strict`, `Path=/console`), and every
 * call sends it (`credentials: 'include'`, in `transport.ts`). There is nothing to refresh: the worker
 * reads the session in its database at each call.
 *
 * The worker says in `GET /auth/providers` which path it serves. A worker that answers with no
 * `betterAuth` is a worker of before, and the console signs in as before (`session-of-before.ts`):
 * the console and the worker are not deployed at the same instant. **A worker that refuses that
 * question, or does not answer it, said nothing** (FRU-205): no call leaves, on either path, and the
 * caller gets that refusal.
 */

import { locale } from './i18n.ts';
import * as before from './session-of-before.ts';
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

type Way = 'cookie' | 'token';
type Refusal = Extract<Answer<never>, { ok: false }>;

/**
 * Which way of signing in the worker serves: `cookie` (better-auth, FRU-147) or `token` (before).
 * `undefined` until the worker said.
 */
let path: Way | undefined;
/** Whether the worker sends mail with better-auth: `email` in its `betterAuth`. */
let mails = false;

/**
 * The path of the worker, asked until it says: the answer of `/auth/providers` says it. When the
 * worker did not say, this is its refusal, and the caller answers it.
 *
 * WARNING: a refusal is not a worker of before (FRU-205). Taking the path of before on a `429` or a
 * `5xx` spent the refresh cookie of before against a worker that serves better-auth, and put an
 * access token in this tab.
 */
async function pathOfWorker(): Promise<Way | Refusal> {
  if (path !== undefined) return path;
  const asked = await askProviders();

  return asked.ok ? asked.data.way : asked;
}

function send(method: string, to: string, body?: unknown): Promise<Response | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // With the cookie of better-auth there is no header to add: the browser sends the cookie.
  if (path === 'token') Object.assign(headers, before.authorization());

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
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;

  return response.ok
    ? { ok: true, data: body }
    : { ok: false, status: response.status, error: body.error ?? 'unknown' };
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
 * WARNING: a call that changes something waits for this one (`call`). Without the wait, a click
 * in the moment after the tab comes back leaves with the cookie of the other account.
 */
export function checkTab(): Promise<void> {
  if (tabAccount === undefined || left !== undefined) return Promise.resolve();
  checking ??= call('GET', '/console/me', undefined, { quiet: true })
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
 * A call of the console. With better-auth, the cookie goes with it and nothing is refreshed. With the
 * path of before, the access token, refreshed once when the worker says it expired.
 *
 * A `401` tells `onSignedOut`, unless `quiet`: the screen keeps what the person typed.
 */
export async function call<T>(
  method: string,
  to: string,
  body?: unknown,
  options: { quiet?: boolean } = {},
): Promise<Answer<T>> {
  // A change waits for the question of a tab that came back, and a tab that stopped sends nothing.
  if (method !== 'GET' && checking !== undefined) await checking;
  if (left !== undefined) return LEFT;
  const way = await pathOfWorker();
  if (typeof way !== 'string') return way;
  if (way === 'token' && !before.holdsToken()) await before.refresh();
  let response = await send(method, to, body);
  if (way === 'token' && response?.status === 401 && (await before.refresh())) response = await send(method, to, body);
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

/** Which providers the worker signs people in with (FRU-135), on the path it serves. */
export type Providers = { github: boolean; google: boolean };

type Announced = Partial<Providers> & { betterAuth?: Partial<Providers> & { email?: boolean } };

/**
 * `undefined` when the worker did not say: no answer, or a refusal. That is not "none": a screen
 * must not tell a person that a provider is not set up when nobody said so.
 *
 * It also learns the path of the worker (FRU-148): `betterAuth` in the answer is better-auth, and
 * its own providers; no `betterAuth` is the path of before, and its two booleans.
 */
export async function signInProviders(): Promise<Providers | undefined> {
  const asked = await askProviders();

  return asked.ok ? asked.data.providers : undefined;
}

/** What the worker said: its path, and the providers of that path. */
type Said = { way: Way; providers: Providers };

let asking: Promise<Answer<Said>> | undefined;

/**
 * Asks the worker, once for every caller that waits at the same moment: a screen that opens makes
 * several calls, and each one asked for itself.
 */
function askProviders(): Promise<Answer<Said>> {
  asking ??= learnPath().finally(() => {
    asking = undefined;
  });

  return asking;
}

async function learnPath(): Promise<Answer<Said>> {
  const asked = await answer<Announced>(await reach('/auth/providers', { method: 'GET' }));
  if (!asked.ok) return asked;
  // An answer with no body says nothing of better-auth: the path of before.
  const said: Announced = typeof asked.data === 'object' && asked.data !== null ? asked.data : {};
  const served = said.betterAuth;
  path = typeof served === 'object' && served !== null ? 'cookie' : 'token';
  mails = path === 'cookie' && (served as { email?: unknown }).email === true;
  const providers = path === 'cookie' ? (served as Partial<Providers>) : said;

  return {
    ok: true,
    data: { way: path, providers: { github: providers.github === true, google: providers.google === true } },
  };
}

/**
 * Where a sign-in with a provider starts: a navigation of the whole page to the worker. With
 * better-auth, `/console/auth/start/<provider>` sets the cookie of the state in the first party: a
 * `fetch` of `/sign-in/social` would set it on the answer of a call, which WebKit did not keep
 * (measured in FRU-147).
 */
export function providerStart(provider: keyof Providers): string {
  return path === 'cookie' ? `${API}/console/auth/start/${provider}` : `${API}/auth/${provider}`;
}

export async function requestLink(email: string, tag: string): Promise<Answer<{ sent: true }>> {
  if (left !== undefined) return LEFT;
  const way = await pathOfWorker();
  if (typeof way !== 'string') return way;

  return answer(await send('POST', way === 'cookie' ? '/console/auth/email' : '/auth/email', { email, locale: tag }));
}

/**
 * Spends the token of a link, read after the `#` of the address. With better-auth the worker answers
 * the account and sets the cookie; the console keeps nothing.
 */
export async function redeemLink(code: string): Promise<Answer<{ account: Account }>> {
  // A tab that stopped signs nobody in, and signs nobody out: it is loaded again first (FRU-210).
  if (left !== undefined) return LEFT;
  const way = await pathOfWorker();
  // The link is not spent: no route was asked.
  if (typeof way !== 'string') return way;
  if (way === 'cookie') {
    const redeemed = await answer<{ account: Account }>(
      await send('POST', '/console/auth/email/redeem', { token: code, locale: locale() }),
    );
    if (redeemed.ok) signedInHere(redeemed.data);

    return redeemed;
  }
  const result = await answer<{ accessToken: string; account: Account }>(
    await send('POST', '/auth/email/redeem', { code, locale: locale() }),
  );
  if (result.ok) {
    before.holdAccess(result.data.accessToken);
    signedInHere(result.data);
  }

  return result;
}

/** A sign-in made in this tab: the tab is of that account from now on (FRU-210). */
function signedInHere(signed: { account?: { id?: unknown } }): void {
  tabAccount = typeof signed.account?.id === 'string' ? signed.account.id : undefined;
}

/**
 * Ends the session on the worker: the cookie is refused at the next call, in every tab.
 *
 * `false` when the worker did not say that every session ended (FRU-204). The screen then says so
 * and stays: somebody who reads « signed out » leaves the browser to the next person.
 *
 * With better-auth, the session of before is ended too. A browser that signed in before the worker
 * served better-auth still holds its refresh cookie, good for 30 days, and the worker still takes
 * it. Both calls are made, whatever the first one answers. FRU-150 removes the second one with the
 * path of before.
 */
export async function signOut(): Promise<boolean> {
  // The session of the browser is of another account now: this tab does not end it.
  if (left !== undefined) return false;
  const way = await pathOfWorker();
  // The worker did not say which sessions it keeps: nothing confirmed that one ended.
  if (typeof way !== 'string') return false;
  let out: boolean;
  if (way === 'token') {
    out = await before.logOut();
  } else {
    const [ended, endedBefore] = await Promise.all([send('POST', '/console/auth/sign-out', {}), before.logOut()]);
    out = ended?.ok === true && endedBefore;
  }
  // Signed out here: the tab is of nobody, and the next sign-in in it says whose it is (FRU-210).
  if (out) tabAccount = undefined;

  return out;
}

/**
 * Whether the worker serves better-auth, and so the members and the invitations (FRU-104): the routes
 * of its organization plugin. A worker of before has neither.
 */
export async function servesBetterAuth(): Promise<boolean> {
  return (await pathOfWorker()) === 'cookie';
}

/**
 * Whether the worker sends the message of an invitation (FRU-104). Without a mailer it keeps the
 * invitation all the same, and the person who invites sends `invitationLink()` by hand.
 */
export async function sendsMail(): Promise<boolean> {
  await pathOfWorker();

  return mails;
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
 * None on a worker of before, which has no invitation.
 */
export async function myInvitations(): Promise<Answer<Invitation[]>> {
  if (!(await servesBetterAuth())) return { ok: true, data: [] };

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
