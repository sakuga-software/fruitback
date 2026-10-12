/**
 * The console's one way to the worker (FRU-99).
 *
 * **The console holds no token** (FRU-148). A worker that serves better-auth keeps the session of the
 * console in a cookie that no script reads (`HttpOnly`, `SameSite=Strict`, `Path=/console`), and every
 * call sends it (`credentials: 'include'`, in `transport.ts`). There is nothing to refresh: the worker
 * reads the session in its database at each call.
 *
 * The worker says in `GET /auth/providers` which path it serves. Until it says `betterAuth`, the
 * console signs in as before (`session-of-before.ts`): the console and the worker are not deployed at
 * the same instant.
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

/**
 * Which way of signing in the worker serves: `cookie` (better-auth, FRU-147) or `token` (before).
 * `undefined` until it said: the path of before is the one taken then.
 */
let path: 'cookie' | 'token' | undefined;

/** The path of the worker, asked once: the answer of `/auth/providers` says it. */
async function pathOfWorker(): Promise<'cookie' | 'token' | undefined> {
  if (path === undefined) await signInProviders();

  return path;
}

function send(method: string, to: string, body?: unknown): Promise<Response | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // With the cookie of better-auth there is no header to add: the browser sends the cookie.
  if (path !== 'cookie') Object.assign(headers, before.authorization());

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
  const way = await pathOfWorker();
  if (way !== 'cookie' && !before.holdsToken()) await before.refresh();
  let response = await send(method, to, body);
  if (way !== 'cookie' && response?.status === 401 && (await before.refresh())) response = await send(method, to, body);
  if (response?.status === 401 && options.quiet !== true) for (const listener of signedOutListeners) listener();

  return answer<T>(response);
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
  const asked = await answer<Announced>(await reach('/auth/providers', { method: 'GET' }));
  if (!asked.ok) return undefined;
  // An answer with no body says nothing of better-auth: the path of before.
  const said: Announced = typeof asked.data === 'object' && asked.data !== null ? asked.data : {};
  const served = said.betterAuth;
  path = typeof served === 'object' && served !== null ? 'cookie' : 'token';
  const providers = path === 'cookie' ? (served as Partial<Providers>) : said;

  return { github: providers.github === true, google: providers.google === true };
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
  const way = await pathOfWorker();

  return answer(await send('POST', way === 'cookie' ? '/console/auth/email' : '/auth/email', { email, locale: tag }));
}

/**
 * Spends the token of a link, read after the `#` of the address. With better-auth the worker answers
 * the account and sets the cookie; the console keeps nothing.
 */
export async function redeemLink(code: string): Promise<Answer<{ account: Account }>> {
  const way = await pathOfWorker();
  if (way === 'cookie') {
    return answer(await send('POST', '/console/auth/email/redeem', { token: code, locale: locale() }));
  }
  const result = await answer<{ accessToken: string; account: Account }>(
    await send('POST', '/auth/email/redeem', { code, locale: locale() }),
  );
  if (result.ok) before.holdAccess(result.data.accessToken);

  return result;
}

/** Ends the session on the worker: the cookie is refused at the next call, in every tab. */
export async function signOut(): Promise<void> {
  if ((await pathOfWorker()) === 'cookie') {
    await send('POST', '/console/auth/sign-out', {});

    return;
  }
  await before.logOut();
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
