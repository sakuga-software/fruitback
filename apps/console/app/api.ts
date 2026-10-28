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
import { WORKSPACE_SUSPENDED_ERROR } from './problems.ts';
import { API, UNREACHABLE, reach } from './transport.ts';

export { API, UNREACHABLE, onReachability } from './transport.ts';

export type Account = { id: string; email: string; name?: string; locale?: string };
export type Role = 'owner' | 'admin' | 'member' | 'guest';
/**
 * A workspace of the person, as `/console/me` lists it. A suspended one says since when (FRU-282),
 * and never why (FRU-328): the reason is a note of the administrator, which only their routes answer.
 */
export type Workspace = Omit<WorkspaceSuspension, 'reason'> & {
  id: string;
  name: string;
  role: Role;
  /**
   * The address of its logo on the worker (FRU-428), which changes with each logo, or `null`. Absent
   * from a worker of before, which keeps none: the initial of the name shows, as for `null`.
   */
  logo?: string | null;
};
export type Visibility = 'members' | 'everyone';
/** Who may leave a note on a site that its members read (FRU-330). `members` is « Members only ». */
export type Writers = 'members' | 'anyone';
/** Where the notes of a site go. Absent: they stay in the workspace. Only a member reads it. */
/** A tracker has teams, so `teamId` is there for one. An address that only receives has none (FRU-122). */
/** A GitHub destination keeps its repository, `owner/name` in lower case, in `teamId` (FRU-359). */
/** `label` is what a member reads when they choose (FRU-123). The worker writes it, from what the tracker answers. */
export type Destination = {
  connector: string;
  teamId?: string;
  projectId?: string;
  label?: string;
  /**
   * FRU-382: whether the repository of a GitHub destination is private, as GitHub last told the
   * worker. Absent: not known (another kind, a worker of before, or GitHub did not answer).
   */
  private?: boolean;
};
/**
 * `destinations` is every place the site can send to, in order (FRU-123): the first one is where a
 * note goes when nobody chose. `destination` is that first one, and all a worker of before sends.
 */
export type Site = {
  id: string;
  origin: string;
  visibility: Visibility;
  /** Absent from a worker of before FRU-330, whose sites take a note from anybody. */
  writers?: Writers;
  destination?: Destination;
  destinations?: Destination[];
  /**
   * The summary of the site (FRU-237), from the index of its notes: how many have each stage, when
   * the last one came, and how they came (the script on the page, or the extension). Absent from a
   * worker of before. The counts can date by a read of a page: `asOf` says when they were taken.
   */
  notes?: Readonly<Record<Stage, number>>;
  lastNoteAt?: string;
  via?: readonly ('script' | 'extension')[];
  /** Notes sent to an address that did not take them yet (REST, FRU-122). */
  undelivered?: number;
  asOf?: string;
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
  kind: 'linear' | 'rest' | 'github';
  label: string;
  /** The name the workspace gave it (FRU-404). Absent: none, or a worker of before. */
  name?: string;
  createdAt: string;
  attention?: ConnectorAttention;
  /** Absent from a worker of before FRU-102: the panel then has no settings to show. */
  settings?: ConnectorSettings;
};
/** The five stages of a pin, in the order of the widget. */
export const STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
export type Stage = (typeof STAGES)[number];
/** What a workspace sets on a tracker (FRU-102): the replies, and the stages some states take. */
export type ConnectorSettings = { showComments: boolean; stages: Record<string, Stage> };
/** A note that did not reach the address of a connector yet. `nextAt` absent: the worker gave up. */
export type Delivery = {
  id: string;
  createdAt: string;
  attempts: number;
  nextAt?: string;
  lastStatus?: number;
  lastError?: string;
};
/**
 * Where a project stands in Linear (FRU-458): the name its workspace gave the status, and its kind,
 * `backlog`, `planned`, `started`, `paused`, `completed` or `canceled`. Absent from a worker of before.
 */
export type ProjectStatus = { name: string; type: string };
/**
 * `private`: only its members see the team in Linear (FRU-458). `color`: the one Linear draws the team
 * or the project with, as `#rrggbb` (FRU-459). Each is absent from a worker of before.
 */
export type Team = {
  id: string;
  name: string;
  key: string;
  private?: boolean;
  color?: string;
  projects: { id: string; name: string; status?: ProjectStatus; color?: string }[];
};
/** A repository that the installation of a GitHub connector covers (FRU-361). A public one is read by anybody. */
export type Repository = { fullName: string; private: boolean };
/** `instanceAdmin`: the person administers this instance (FRU-261). Absent from a worker of before. */
export type Me = { account: Account; workspaces: Workspace[]; instanceAdmin?: boolean };

export type Answer<T> =
  | { ok: true; data: T }
  /**
   * `field`: the field of the request the worker refused, when it names one (`invalid-request`).
   * `notes`: how many notes are in a status the worker would not remove (`status-in-use`, FRU-366).
   */
  | { ok: false; status: number; error: string; field?: string; notes?: number };

/** Whether the worker sends mail: `email` in what it says of better-auth. `undefined`: not asked yet. */
let mails: boolean | undefined;
/** Whether the worker signs anybody in: it said `betterAuth`. `undefined` until it said. */
let signsIn: boolean | undefined;
/**
 * Whether the only way in is a link that whoever runs the worker makes (FRU-221): the worker signs
 * people in, and has no mail and no provider. `undefined` until it said.
 */
let byOperator: boolean | undefined;

function send(method: string, to: string, body?: unknown): Promise<Response | undefined> {
  // A file goes as its bytes, with its own type (FRU-428): the logo of a workspace.
  if (body instanceof Blob) return reach(to, { method, headers: { 'Content-Type': body.type }, body });
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // No header names the person: the browser sends the cookie.
  return reach(to, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

type SuspendedListener = (workspace: string, suspendedAt: string | undefined) => void;
const suspendedListeners = new Set<SuspendedListener>();

/**
 * Tells the listener when a write was refused because the workspace is suspended (FRU-328), with the
 * workspace the write named and the day the worker says to a member. The frame of the workspace shows
 * its banner then, also when the suspension came after `/console/me` was read. Returns how to stop.
 *
 * WARNING: the listener gets the workspace of the write, not the one on screen. A write sent in one
 * workspace can be answered after the person went to another one.
 */
export function onWorkspaceSuspended(listener: SuspendedListener): () => void {
  suspendedListeners.add(listener);

  return () => void suspendedListeners.delete(listener);
}

/**
 * The workspace a call names: in its path for the console API (`/console/workspaces/<id>/…`), in
 * `organizationId` of its body for the organization plugin. `undefined` when it names none.
 */
export function workspaceOfWrite(to: string, body: unknown): string | undefined {
  const inPath = /^\/console\/workspaces\/([^/?#]+)/.exec(to)?.[1];
  if (inPath !== undefined) return decodeURIComponent(inPath);
  const inBody = (body as { organizationId?: unknown } | null | undefined)?.organizationId;

  return typeof inBody === 'string' ? inBody : undefined;
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

async function answer<T>(response: Response | undefined, workspace?: string): Promise<Answer<T>> {
  if (response === undefined) return UNREACHABLE;
  if (response.status === 204) return { ok: true, data: undefined as T };
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    code?: unknown;
    field?: unknown;
    notes?: unknown;
  } & T;
  // A refusal of the worker names itself in `error`, and one of better-auth in `code` (FRU-209):
  // without the second, no sentence a screen holds for a code of better-auth was ever shown.
  const named = [body.error, body.code].find((name) => typeof name === 'string') as string | undefined;

  if (response.ok) return { ok: true, data: body };
  if (response.status === 409 && named === WORKSPACE_SUSPENDED_ERROR && workspace !== undefined) {
    const since = (body as { suspendedAt?: unknown }).suspendedAt;
    for (const listener of suspendedListeners) listener(workspace, typeof since === 'string' ? since : undefined);
  }

  return {
    ok: false,
    status: response.status,
    error: named ?? 'unknown',
    ...(typeof body.field === 'string' ? { field: body.field } : {}),
    ...(typeof body.notes === 'number' ? { notes: body.notes } : {}),
  };
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
/**
 * The last `/console/me` the worker answered in this tab (FRU-356), in memory only. The frame of a
 * workspace and the frame of the administration draw it at once when they mount, and ask again: a
 * move between them showed « Loading… » with no rail for 37 to 115 frames (measured at 250 ms of
 * latency). It is forgotten at any `401`, at a sign-out, and when the tab stops: it is never an
 * answer about somebody else. The worker decides what each call may read; this decides what is drawn.
 */
let lastMe: Me | undefined;

/** The last `/console/me` of this tab, while the same session holds. `undefined` before the first. */
export function knownMe(): Me | undefined {
  return left === undefined ? lastMe : undefined;
}
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
  lastMe = undefined;
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
  if (response?.status === 401) lastMe = undefined;
  if (response?.status === 401 && options.quiet !== true) {
    endSeen = true;
    for (const listener of signedOutListeners) listener();
  }
  const result = await answer<T>(response, workspaceOfWrite(to, body));
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
      lastMe = result.data as Me;
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
  if (signsIn !== undefined) byOperator = signsIn && !mails && served.github !== true && served.google !== true;

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
  if (out) {
    tabAccount = undefined;
    lastMe = undefined;
  }

  return out;
}

/**
 * A session of the console of the person, as `GET /console/sessions` lists it (FRU-181): its id, and
 * never its token. `current` is the session of this browser. The worker also answers a user agent
 * when its operator switched that on; this type leaves it out, and no screen shows it (Q7 of FRU-230).
 */
/**
 * `browser`: a short label the worker reads in the user agent (« Chrome on macOS », FRU-249), or
 * « A browser » when it cannot tell. Absent from a worker of before.
 */
export type ConsoleSession = { id: string; createdAt: string; lastUsedAt: string; current: boolean; browser?: string };

/**
 * A browser where the extension is connected to the account (FRU-238, FRU-249): its short label, when
 * it connected, and when it last refreshed its tokens.
 */
export type ExtensionBrowser = { id: string; browser: string; connectedAt: string; usedAt: string };

/**
 * The browsers of the extension of the person. A refusal is no list. `quiet`: a `401` does not end
 * the session of the screen (`/connect` reads it signed out too, FRU-410).
 */
export async function extensionBrowsers(options: { quiet?: boolean } = {}): Promise<Answer<ExtensionBrowser[]>> {
  const listed = await call<{ browsers?: ExtensionBrowser[] }>('GET', '/console/me/browsers', undefined, options);
  if (!listed.ok) return listed;

  return Array.isArray(listed.data?.browsers)
    ? { ok: true, data: listed.data.browsers }
    : { ok: false, status: 200, error: 'unknown' };
}

/** Ends the session of the extension in one browser: its next refresh is refused. */
export async function endExtensionBrowser(id: string): Promise<'ended' | 'unknown' | 'failed'> {
  const ended = await call('DELETE', `/console/me/browsers/${encodeURIComponent(id)}`);
  if (ended.ok) return 'ended';

  return ended.status === 404 ? 'unknown' : 'failed';
}

/** The providers that an account links (FRU-249). */
export const LINKABLE = ['github', 'google'] as const;
export type Linkable = (typeof LINKABLE)[number];

/**
 * How the person signs in (FRU-249): `email` when this worker sends the link of an e-mail, and each
 * provider the worker has, or the account has linked, with whether it is linked.
 */
export type SignInMethods = { email: boolean } & Partial<Record<Linkable, { linked: boolean }>>;

export async function signInMethods(): Promise<Answer<SignInMethods>> {
  const asked = await call<SignInMethods>('GET', '/console/me/sign-in');
  if (!asked.ok) return asked;

  return typeof asked.data?.email === 'boolean' ? asked : { ok: false, status: 200, error: 'unknown' };
}

/** Takes a provider away from the account. The worker keeps the last way to sign in (`last-sign-in`). */
export async function unlinkProvider(provider: Linkable): Promise<Answer<unknown>> {
  return call('DELETE', `/console/me/sign-in/${provider}`);
}

/**
 * Where the form of « Link » sends the browser: a `POST`, by a navigation (FRU-415), which comes back
 * to « My account » of `workspace` with `?confirm=<provider>`, `?linked=<provider>` or `?error=<code>`.
 * The worker starts no link on a `GET`.
 */
export function linkAddress(provider: Linkable, workspace: string): string {
  return `${API}/console/auth/link/${provider}?workspace=${encodeURIComponent(workspace)}`;
}

/** The link that came back from a provider and waits for the person to say yes (FRU-415). */
export type PendingLink = { provider: Linkable; email: string };

/** The pending link of this session, or `none` when there is none (it expired, or was answered). */
export async function pendingLink(): Promise<Answer<PendingLink> | { ok: true; data: 'none' }> {
  const asked = await call<PendingLink>('GET', '/console/me/sign-in/pending');
  if (!asked.ok) return asked.status === 404 ? { ok: true, data: 'none' } : asked;
  const { provider, email } = asked.data ?? {};

  return (LINKABLE as readonly unknown[]).includes(provider) && typeof email === 'string'
    ? asked
    : { ok: false, status: 200, error: 'unknown' };
}

/** « Link »: the worker writes the link, and sends an alert to the address of the account. */
export async function confirmLink(): Promise<Answer<unknown>> {
  return call('POST', '/console/me/sign-in/pending');
}

/** « Cancel »: the worker forgets the link. */
export async function cancelLink(): Promise<Answer<unknown>> {
  return call('DELETE', '/console/me/sign-in/pending');
}

/** The name on the notes of the person: one line, 1 to 80 characters. */
export async function renameMe(name: string): Promise<Answer<{ account: Account }>> {
  return call<{ account: Account }>('POST', '/console/me/name', { name });
}

/**
 * An address of the account (FRU-450). `primary`: the one of the notes and of the messages.
 * `providers`: the linked providers that give it. `verified`: Fruitback proved it itself.
 */
export type AccountEmail = { email: string; primary: boolean; providers: Linkable[]; verified: boolean };

/** The addresses of the account, and whether this worker sends the link that adds one. */
export type AccountEmails = { canAdd: boolean; emails: AccountEmail[] };

export async function accountEmails(): Promise<Answer<AccountEmails>> {
  const asked = await call<AccountEmails>('GET', '/console/me/emails');
  if (!asked.ok) return asked;
  const { canAdd, emails } = asked.data ?? {};
  if (typeof canAdd !== 'boolean' || !Array.isArray(emails)) return { ok: false, status: 200, error: 'unknown' };

  // A provider the console does not know is not drawn: it is read in the closed list `LINKABLE`.
  return {
    ok: true,
    data: {
      canAdd,
      emails: emails
        .filter((each) => typeof each?.email === 'string')
        .map((each) => ({
          email: each.email,
          primary: each.primary === true,
          providers: (Array.isArray(each.providers) ? each.providers : []).filter((provider) =>
            (LINKABLE as readonly unknown[]).includes(provider),
          ),
          verified: each.verified === true,
        })),
    },
  };
}

/** Sends the link that adds `email` to the account. The address is added once the link is opened. */
export async function addAccountEmail(email: string): Promise<Answer<{ email: string }>> {
  return call<{ email: string }>('POST', '/console/me/emails', { email });
}

/** Spends the link of verification of an address, in the session of the account that asked. */
export async function verifyAccountEmail(token: string): Promise<Answer<{ email: string }>> {
  return call<{ email: string }>('POST', '/console/me/emails/verify', { token }, { quiet: true });
}

/** Makes an address of the account its primary one. `workspace`: where the alert sends the person back. */
export async function makePrimaryEmail(email: string, workspace: string): Promise<Answer<{ email: string }>> {
  return call<{ email: string }>('POST', '/console/me/emails/primary', { email, workspace });
}

/** Takes an address away from the account. Never the primary one, nor one that a linked provider gives. */
export async function removeAccountEmail(email: string): Promise<Answer<unknown>> {
  return call('DELETE', `/console/me/emails/${encodeURIComponent(email)}`);
}

/**
 * The sessions of the console of the person. A refusal is no list: the screen says it could not read.
 * `quiet`: a `401` does not end the session of the screen (`/connect` reads it signed out too, FRU-441).
 */
export async function consoleSessions(options: { quiet?: boolean } = {}): Promise<Answer<ConsoleSession[]>> {
  const listed = await call<{ sessions?: ConsoleSession[] }>('GET', '/console/sessions', undefined, options);
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
  if (out) {
    tabAccount = undefined;
    lastMe = undefined;
  }

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

/**
 * Whether a person can only get in by a link from whoever runs the worker (FRU-221). `false` when the
 * worker did not say: a form is not taken away by an outage.
 */
export async function signsInByOperatorOnly(): Promise<boolean> {
  if (byOperator === undefined) await signInProviders();

  return byOperator === true;
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
/** A site shared with a guest (FRU-250): its id and its address. */
export type SharedSite = { id: string; origin: string };

export type Member = {
  id: string;
  userId: string;
  role: Role;
  createdAt: string;
  user: { id: string; email: string; name: string };
  /** The sites of a guest (FRU-250). Absent for another role, which reads every site. */
  sites?: SharedSite[];
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
  /** The sites an invitation of a guest names (FRU-250). */
  sites?: SharedSite[];
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
 * A request of the extension to sign in as the person (FRU-238, FRU-240), as the console reads it.
 * The word, the browser and the account come from the worker, never from the address of the page:
 * a forged address shows nothing the worker did not say. A request that waits has its word, its
 * account and the workspaces of that account; an answered one, read by the account that answered
 * it, has its state and its browser only.
 */
export type ConnectRequest = {
  request: string;
  state: 'pending' | 'approved' | 'refused' | 'claimed' | 'expired';
  word?: string;
  browser: string;
  account?: { id: string; email: string; name?: string };
  workspaces?: { id: string; name: string; role?: Role }[];
};

/**
 * The request whose id is in the address of the page. Quiet: nobody signed in is a state of the
 * page. 404: unknown, or answered by another account; 410: expired.
 */
export function connectRequest(request: string): Promise<Answer<ConnectRequest>> {
  return call<ConnectRequest>('GET', `/console/connect/${encodeURIComponent(request)}`, undefined, { quiet: true });
}

/**
 * « Connect », with the word and the account the page showed: the worker refuses an answer for
 * another word, or from an account that changed since the page read the request (409).
 * « Not now » refuses it. Quiet: on a 401 the page asks for a sign-in itself, so the banner of the
 * root would be a second, different instruction.
 */
export function answerConnect(
  request: string,
  asked: { word: string; account: { id: string } },
  approve: boolean,
): Promise<Answer<Partial<ConnectRequest>>> {
  const path = `/console/connect/${encodeURIComponent(request)}/${approve ? 'approve' : 'refuse'}`;

  return call<Partial<ConnectRequest>>(
    'POST',
    path,
    approve ? { word: asked.word, account: asked.account.id } : { account: asked.account.id },
    { quiet: true },
  );
}

/**
 * Renames a workspace (FRU-236): its owner or an admin. The worker answers the workspace as
 * `/console/me` lists it, with the role of the person.
 */
export function renameWorkspace(workspace: Workspace, name: string): Promise<Answer<Workspace>> {
  return call<Workspace>('POST', `/console/workspaces/${workspace.id}`, { name });
}

/** The types of image the worker keeps as a logo (FRU-428), as `workspace-logo.ts` of the worker says. */
export const LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
/** The most bytes of a logo, as the worker says. */
export const MAX_LOGO_BYTES = 512 * 1_024;

/**
 * Where an `<img>` reads the logo of a workspace (FRU-428), or `undefined` when it has none. The
 * worker answers an address of its own: anything else is not drawn.
 */
export function logoSource(workspace: Pick<Workspace, 'logo'>): string | undefined {
  const { logo } = workspace;

  return typeof logo === 'string' && logo.startsWith('/console/workspaces/') ? `${API}${logo}` : undefined;
}

/** Sends the logo of a workspace (FRU-428): its owner or an admin. The worker answers its address. */
export function setWorkspaceLogo(workspace: Workspace, file: Blob): Promise<Answer<{ logo: string }>> {
  return call<{ logo: string }>('POST', `/console/workspaces/${workspace.id}/logo`, file);
}

/** Removes the logo of a workspace (FRU-428): its owner or an admin. */
export function removeWorkspaceLogo(workspace: Workspace): Promise<Answer<{ logo: null }>> {
  return call<{ logo: null }>('DELETE', `/console/workspaces/${workspace.id}/logo`);
}

/**
 * Sets every place a site sends to, in order (FRU-123). The label is not sent: the worker writes it.
 *
 * WARNING: the list holds the places of every source of the site. The worker answers the repository
 * of a GitHub place in `teamId`, and takes it back only as `repository` (FRU-359). So `connectors`
 * must hold every source of the workspace: a GitHub place sent as a team makes the worker refuse
 * the whole list.
 */
export function setPlaces(
  base: string,
  site: Site,
  places: readonly Destination[],
  connectors: readonly Pick<Connector, 'id' | 'kind'>[],
): Promise<Answer<unknown>> {
  const github = new Set(connectors.filter((each) => each.kind === 'github').map((each) => each.id));

  return call('POST', `${base}/sites/${site.id}/destinations`, {
    destinations: places.map(({ connector, teamId, projectId }) =>
      github.has(connector) && teamId !== undefined
        ? { connector, repository: teamId }
        : {
            connector,
            ...(teamId === undefined ? {} : { teamId }),
            ...(projectId === undefined ? {} : { projectId }),
          },
    ),
  });
}

/** A way to sign in on the instance (FRU-261): whether it is on, and the variables that turn it on. */
export type InstanceSignIn = { on: boolean; variables: string[] };

/** A connector that needs somebody, with its workspace (FRU-261). */
export type AttentionConnector = {
  id: string;
  kind: string;
  label: string;
  attention?: ConnectorAttention;
  workspace: { id: string; name: string };
};

/**
 * What the worker says of the instance, to its administrator (FRU-261): its configuration and its
 * health, with no secret. `GET /console/admin/instance` answers it; any other account gets `404`.
 */
export type InstanceFacts = {
  startedAt: string;
  store: string;
  database: { kind: string; schema?: string | null };
  mail: { provider: string | null; sender: string | null; variables: string[]; lastSentAt: string | null };
  signIn: { email: InstanceSignIn; github: InstanceSignIn; google: InstanceSignIn };
  publicUrl: { value: string | null; variable: string };
  consoleUrl: { value: string | null; variable: string };
  signUp: { policy: 'invited' | 'anyone'; variable: string };
  counts: { workspaces: number; accounts: number; admins: number };
  attention: { count: number; connectors: AttentionConnector[] };
};

/**
 * Whether an administrator of the instance suspended a workspace (FRU-282), as every read of the
 * administrator says it (`suspensionView` of the worker): `suspendedAt` and `reason` come with
 * `suspended: true` only, and `reason` only when one was given. A worker of before sends none of the
 * three: the console reads it as not suspended.
 */
export type WorkspaceSuspension = { suspended?: boolean; suspendedAt?: string; reason?: string };

/** The longest reason of a suspension, in characters (`SUSPENSION_REASON_LENGTH` of the worker). */
export const SUSPENSION_REASON_LENGTH = 200;

/** A workspace of the instance, as its administrator lists it (FRU-261). */
export type InstanceWorkspace = WorkspaceSuspension & {
  id: string;
  name: string;
  createdAt: string;
  owners: { id: string; name?: string; email: string }[];
  members: number;
  sites: number;
};

/** The facts of the instance. Only its administrator reads them. */
export function instanceFacts(): Promise<Answer<InstanceFacts>> {
  return call<InstanceFacts>('GET', '/console/admin/instance');
}

/**
 * The workspaces of the instance, at most a page of the worker; `total` says how many there are.
 *
 * WARNING: the worker writes a trace of this read in each workspace of the answer that the
 * administrator is not a member of. The owners of the workspace read it.
 */
export function instanceWorkspaces(): Promise<Answer<{ workspaces: InstanceWorkspace[]; total: number }>> {
  return call('GET', '/console/admin/workspaces');
}

/**
 * A note of the instance, as its administrator lists it (FRU-272). `text` comes only for a note that
 * Fruitback keeps; `excerpt`, its first 64 characters, always. `author` has no name.
 */
export type InstanceNote = {
  id: string;
  workspace: { id: string; name: string };
  site: { id: string; origin: string };
  page: { url: string; host: string; path: string };
  excerpt: string;
  text?: string;
  stage: string;
  channel: 'script' | 'extension' | null;
  author: { kind: 'visitor' | 'site' | 'member' | 'verified' };
  place: { kind: 'fruitback' } | { kind: 'removed' } | { kind: string; connector: string; label: string };
  ref?: string;
  url?: string;
  createdAt: string;
  checkedAt: string;
};

export type InstanceNotes = { notes: InstanceNote[]; total: number; searched: string[]; next?: string };

/**
 * One page of the notes of the instance, the newest first.
 *
 * WARNING: the worker writes a trace of this read in each workspace of the answer that the
 * administrator is not a member of. The owners of the workspace read it.
 */
export function instanceNotes(query: URLSearchParams): Promise<Answer<InstanceNotes>> {
  const asked = query.toString();

  return call('GET', `/console/admin/notes${asked === '' ? '' : `?${asked}`}`);
}

/** How many notes of a workspace or of a site are at each stage (FRU-261). */
export type StageCounts = Partial<Record<Stage, number>>;

/** A connector of a workspace, as its administrator lists it (FRU-261): no secret and no address. */
export type AdminConnector = { id: string; kind: string; label: string; attention?: ConnectorAttention };

/** A row of « Workspaces » of the administration (FRU-261). */
export type AdminWorkspace = InstanceWorkspace & {
  notes: StageCounts;
  destinations: AdminConnector[];
  pendingDeliveries: number;
};

/** One workspace, with its people and its sites (FRU-261). */
export type AdminWorkspaceDetail = WorkspaceSuspension & {
  id: string;
  name: string;
  createdAt: string;
  members: { id: string; name?: string; email: string; role: string; lastSeen?: string }[];
  sites: { id: string; origin: string; visibility: string; notes: StageCounts }[];
  destinations: (AdminConnector & { createdAt: string })[];
  pendingDeliveries: number;
  pendingInvitations: number;
};

/** A row of « Users » of the administration (FRU-261). `lastSeen` is a day, `YYYY-MM-DD`. */
export type AdminUser = {
  id: string;
  name?: string;
  email: string;
  createdAt: string;
  /** `false` for a suspended account, whatever its role: the worker counts it as no administrator. */
  instanceAdmin: boolean;
  /** An administrator of the instance suspended the account (FRU-281). */
  suspended: boolean;
  /** `soleOwner`: the account owns this workspace alone (FRU-285), and cannot be deleted before another owner. */
  workspaces: { id: string; name: string; role: string; soleOwner?: true }[];
  /** `email`, `github`, `google`. */
  providers: string[];
  lastSeen?: string;
  pendingInvitations: { workspace: { id: string; name: string }; role?: string }[];
};

/** What the lists of the administration show: `show` is one of the filters of the worker. */
export type AdminQuery = { q: string; show: string };

function adminList(path: string, { q, show }: AdminQuery): string {
  const query = new URLSearchParams();
  if (q !== '') query.set('q', q);
  if (show !== 'all') query.set('show', show);
  const search = query.toString();

  return search === '' ? path : `${path}?${search}`;
}

/**
 * The workspaces of the instance that match a search and a filter: 100 at most, and `total`.
 *
 * WARNING: the worker writes a trace of this read in each workspace of the answer that the
 * administrator is not a member of. The owners of the workspace read it.
 */
export function adminWorkspaces(query: AdminQuery): Promise<Answer<{ workspaces: AdminWorkspace[]; total: number }>> {
  return call('GET', adminList('/console/admin/workspaces', query));
}

/**
 * One workspace of the instance.
 *
 * WARNING: the worker writes a trace of this read in the workspace when the administrator is not a
 * member of it. Its owners read it.
 */
export function adminWorkspace(id: string): Promise<Answer<AdminWorkspaceDetail>> {
  return call('GET', `/console/admin/workspaces/${encodeURIComponent(id)}`);
}

/**
 * The accounts of the instance that match a search and a filter: 100 at most, and `total`.
 *
 * WARNING: the worker writes a trace of this read in each workspace of the answer, and of their
 * invitations, that the administrator is not a member of. The owners of the workspace read it.
 */
export function adminUsers(query: AdminQuery): Promise<Answer<{ users: AdminUser[]; total: number }>> {
  return call('GET', adminList('/console/admin/users', query));
}

/**
 * Gives the role of administrator of the instance to an account, or takes it away (FRU-280). The
 * worker refuses with `409 self-removal` and `409 last-admin`. `changed` is false when the account
 * already had the role that was asked. Each change writes a row that the administrators read.
 */
export function setInstanceAdmin(
  id: string,
  admin: boolean,
): Promise<Answer<{ user: { id: string; instanceAdmin: boolean }; changed: boolean }>> {
  return call('POST', `/console/admin/users/${encodeURIComponent(id)}/instance-admin`, { admin });
}

/**
 * Suspends an account, or restores it (FRU-281). A suspended account signs in by no way, and its
 * sessions of the console and of the extension end. The worker refuses with `409 self-suspension`
 * and `409 last-admin`. `changed` is false when the account already was in the state that was asked.
 * Each change writes a row for the owners of each workspace of the account.
 */
export function setSuspended(
  id: string,
  suspended: boolean,
): Promise<Answer<{ user: { id: string; suspended: boolean }; changed: boolean }>> {
  return call('POST', `/console/admin/users/${encodeURIComponent(id)}/suspension`, { suspended });
}

/**
 * Suspends a workspace, or restores it (FRU-282, FRU-323). `reason` is optional, one line of
 * `SUSPENSION_REASON_LENGTH` characters at most: the worker refuses a longer one with
 * `400 invalid-reason`, and answers `404 not-found` for a workspace that does not exist. `changed` is
 * false when the workspace already was in the state that was asked: a second suspension keeps the
 * reason of the first. Each change writes a row of the trace, which the owners read.
 */
export function setWorkspaceSuspendedAsAdmin(
  id: string,
  suspended: boolean,
  reason?: string,
): Promise<Answer<{ workspace: { id: string } & WorkspaceSuspension; changed: boolean }>> {
  return call('POST', `/console/admin/workspaces/${encodeURIComponent(id)}/suspension`, {
    suspended,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** What went with a workspace that an administrator deleted (FRU-284), counted at the deletion. */
export type WorkspaceGone = {
  sites: number;
  members: number;
  invitations: number;
  connectors: number;
  keptNotes: number;
};

/**
 * Deletes a workspace of the instance (FRU-284), at once and for good. `name` is the name of the
 * workspace as the administrator typed it: the worker refuses another one with `409 name-mismatch`
 * and deletes nothing. The issues in the tracker of the workspace stay there.
 */
export function deleteWorkspaceAsAdmin(
  id: string,
  name: string,
): Promise<Answer<{ workspace: { id: string; name: string }; gone: WorkspaceGone }>> {
  return call('POST', `/console/admin/workspaces/${encodeURIComponent(id)}/deletion`, { name });
}

/** A workspace that an administrator deleted (FRU-284), as `admin_actions` keeps it. */
export type DeletedWorkspace = {
  action: 'workspace-deleted';
  at: string;
  actor: { id?: string; email: string; name?: string };
  workspace?: { id: string; name: string };
  detail?: { gone?: Partial<WorkspaceGone> };
};

/**
 * The workspaces that the administrators deleted, the newest first, 200 at most. They exist no
 * more, so this read leaves no trace with any owner.
 */
export function deletedWorkspaces(): Promise<Answer<{ actions: DeletedWorkspace[] }>> {
  return call('GET', '/console/admin/actions?kind=workspace-deleted');
}

/**
 * Gives a member of a workspace another role (FRU-283): `owner`, `admin` or `member`. The worker
 * refuses with `409 last-owner`, `409 not-a-member` and `409 workspace-suspended`. The owners of the
 * workspace read that the administrator did it.
 */
export function setMemberRoleAsAdmin(
  workspace: string,
  account: string,
  role: string,
): Promise<Answer<{ member: { id: string; role: string }; changed: boolean }>> {
  return call(
    'POST',
    `/console/admin/workspaces/${encodeURIComponent(workspace)}/members/${encodeURIComponent(account)}/role`,
    { role },
  );
}

/**
 * Adds the account of an address to a workspace with a role (FRU-283). The worker refuses with
 * `409 unknown-account` (no account has the address: invite it), `409 already-member` and
 * `409 workspace-suspended`.
 */
export function addMemberAsAdmin(
  workspace: string,
  email: string,
  role: string,
): Promise<Answer<{ member: { id: string; email: string; role: string } }>> {
  return call('POST', `/console/admin/workspaces/${encodeURIComponent(workspace)}/members`, { email, role });
}

/**
 * Makes the account of an address the owner of a workspace (FRU-283). The owners of before become
 * admins. The worker refuses with `409 unknown-account`, `409 suspended-account` and
 * `409 workspace-suspended`.
 */
export function setOwnerAsAdmin(
  workspace: string,
  email: string,
): Promise<Answer<{ owner: { id: string; email: string }; previous: string[]; changed: boolean }>> {
  return call('POST', `/console/admin/workspaces/${encodeURIComponent(workspace)}/owner`, { email });
}

/**
 * Invites an address that has no account into a workspace (FRU-283), as `admin` or `member`. `mailed`
 * says whether its message left; when it did not, the person is told by hand. The worker refuses with
 * `409 has-account`, `409 already-member`, `409 already-invited` and `409 workspace-suspended`.
 */
export function inviteAsAdmin(
  workspace: string,
  email: string,
  role: string,
): Promise<Answer<{ invitation: { id: string; email: string; role: string; expiresAt: string; mailed: boolean } }>> {
  return call('POST', `/console/admin/workspaces/${encodeURIComponent(workspace)}/invitations`, { email, role });
}

/**
 * Makes a workspace whose owner is the account of an address (FRU-283). The worker refuses with
 * `400 invalid-name`, `409 unknown-account` and `409 suspended-account`.
 */
export function createWorkspaceAsAdmin(
  name: string,
  owner: string,
): Promise<Answer<{ workspace: { id: string; name: string }; owner: { id: string; email: string } }>> {
  return call('POST', '/console/admin/new-workspace', { name, owner });
}

/**
 * Deletes an account (FRU-285), at once and for good. `email` is its address, as the administrator
 * typed it. The worker refuses with `409 sole-owner` and the workspaces that the account owns alone,
 * `409 self-deletion`, `409 last-admin` and `409 email-mismatch`. Its notes stay, as of a former member.
 */
export function deleteAccountAsAdmin(
  id: string,
  email: string,
): Promise<Answer<{ user: { id: string; email: string }; workspaces: { id: string; name: string }[] }>> {
  return call('POST', `/console/admin/users/${encodeURIComponent(id)}/deletion`, { email });
}

/**
 * An agent key of a workspace (FRU-461), as the worker lists it: never the key itself, which the
 * answer of its creation holds once. `lastUsedAt`: when an agent last opened a request of `/mcp` with
 * it, to the minute (FRU-462), `null` for a key nobody used; absent from a worker of before.
 */
export type AgentKey = {
  id: string;
  name: string;
  sites: SharedSite[];
  rights: 'read' | 'write';
  verifiedOnly: boolean;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string | null;
};

/** What the console sends to make a key: `days` from 1 to `MAX_AGENT_KEY_DAYS`. */
export type NewAgentKey = {
  name: string;
  sites: string[];
  rights: 'read' | 'write';
  days: number;
  verifiedOnly: boolean;
};

/** The bounds of the worker (FRU-461): keys of a workspace, sites of a key, days of a key. */
export const MAX_AGENT_KEYS = 20;
export const MAX_AGENT_KEY_SITES = 20;
export const MAX_AGENT_KEY_DAYS = 365;
export const DEFAULT_AGENT_KEY_DAYS = 90;

/** One write of a key through `/mcp` (FRU-464): a reply, or the status it set, on a note of a site. */
export type AgentWrite = {
  site: string;
  note: string;
  action: 'reply' | 'status';
  status?: string;
  at: string;
};

const agentKeysOf = (workspace: string) => `/console/workspaces/${workspace}/agent-keys`;

export function agentKeys(workspace: string): Promise<Answer<{ keys: AgentKey[] }>> {
  return call('GET', agentKeysOf(workspace));
}

/** Makes a key. The answer holds it in `secret`, the one time the worker gives it. */
export function makeAgentKey(workspace: string, key: NewAgentKey): Promise<Answer<AgentKey & { secret: string }>> {
  return call('POST', agentKeysOf(workspace), key);
}

export function revokeAgentKey(workspace: string, key: string): Promise<Answer<unknown>> {
  return call('DELETE', `${agentKeysOf(workspace)}/${encodeURIComponent(key)}`);
}

/** The writes of a key, the newest first, `AGENT_WRITES_LISTED` at most. */
export function agentWrites(workspace: string, key: string): Promise<Answer<{ writes: AgentWrite[] }>> {
  return call('GET', `${agentKeysOf(workspace)}/${encodeURIComponent(key)}/writes`);
}

/** How many writes of one key the worker answers. */
export const AGENT_WRITES_LISTED = 100;
