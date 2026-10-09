/**
 * The console's one way to the worker (FRU-99).
 *
 * The access token lives in this module, in memory, and nowhere else. The refresh token is a cookie
 * this script cannot read: `refresh()` asks the worker to spend it. A page reload loses the access
 * token and gets a new one from the cookie.
 */

export const API =
  (import.meta.env?.VITE_FRUITBACK_API as string | undefined)?.replace(/\/+$/, '') ?? 'http://localhost:8788';

/**
 * A worker that never answers must not hold a screen: every call stops after this long.
 */
const CALL_TIMEOUT_MS = 15_000;

/** What a call answers when the worker did not: no network, no name, no answer in time. */
export const UNREACHABLE = { ok: false, status: 0, error: 'unreachable' } as const;

type ReachListener = (reachable: boolean) => void;
const reachListeners = new Set<ReachListener>();
let reachable = true;

/** Tells the listener each time the worker stops or starts to answer. Returns how to stop. */
export function onReachability(listener: ReachListener): () => void {
  reachListeners.add(listener);
  listener(reachable);

  return () => void reachListeners.delete(listener);
}

function reached(now: boolean): void {
  if (now === reachable) return;
  reachable = now;
  for (const listener of reachListeners) listener(now);
}

/**
 * A request that answered, or `undefined`. WARNING: this must not reject. A caller that awaits a
 * rejected call sets no state, and its screen says "Loading…" until the tab closes.
 */
async function reach(path: string, init: RequestInit): Promise<Response | undefined> {
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    reached(true);

    return response;
  } catch {
    reached(false);

    return undefined;
  }
}

let access: string | undefined;

export type Account = { id: string; email: string; name?: string; locale?: string };
export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type Workspace = { id: string; name: string; role: Role };
export type Visibility = 'members' | 'everyone';
export type Site = { id: string; origin: string; visibility: Visibility };
export type Me = { account: Account; workspaces: Workspace[] };

export type Answer<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function send(method: string, path: string, body?: unknown): Promise<Response | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (access !== undefined) headers.Authorization = `Bearer ${access}`;

  return reach(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function answer<T>(response: Response | undefined): Promise<Answer<T>> {
  if (response === undefined) return UNREACHABLE;
  if (response.status === 204) return { ok: true, data: undefined as T };
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;

  return response.ok
    ? { ok: true, data: body }
    : { ok: false, status: response.status, error: body.error ?? 'unknown' };
}

let inFlight: Promise<boolean> | undefined;

/**
 * Spends the cookie for a fresh access token. `false` means signed out.
 *
 * WARNING: one refresh at a time. Two calls that spend the same refresh token race, and the worker
 * reads the second as a retry: whichever answer lands last decides which token the browser keeps.
 * Every caller joins the refresh already in flight, like `refreshOnce` in the extension.
 */
export function refresh(): Promise<boolean> {
  inFlight ??= spend().finally(() => {
    inFlight = undefined;
  });

  return inFlight;
}

async function spend(): Promise<boolean> {
  const response = await reach('/console/session/refresh', { method: 'POST' });
  // No answer is not a refusal: the access token this tab holds can still be good.
  if (response === undefined) return false;
  if (!response.ok) {
    access = undefined;

    return false;
  }
  const body = (await response.json().catch(() => ({}))) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string') return false;
  access = body.accessToken;

  return true;
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
    void call<T>(method, path).then((answer) => {
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

/** A call with the access token, refreshed once when the worker says it expired. */
export async function call<T>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  if (access === undefined) await refresh();
  let response = await send(method, path, body);
  if (response?.status === 401 && (await refresh())) response = await send(method, path, body);

  return answer<T>(response);
}

export function requestLink(email: string, locale: string): Promise<Answer<{ sent: true }>> {
  return send('POST', '/auth/email', { email, locale }).then((response) => answer(response));
}

export async function redeemLink(code: string): Promise<Answer<{ account: Account }>> {
  const result = await answer<{ accessToken: string; account: Account }>(
    await send('POST', '/auth/email/redeem', { code, locale: navigator.language }),
  );
  if (result.ok) access = result.data.accessToken;

  return result;
}

export async function signOut(): Promise<void> {
  await reach('/console/session/logout', { method: 'POST' });
  access = undefined;
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
