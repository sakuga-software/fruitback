import {
  type ConnectSeams,
  type ConnectState,
  type PendingConnect,
  type StartFailure,
  forgetConnect,
  pollConnect,
  startConnect,
} from './connect.ts';

/**
 * « Sign in to Fruitback », for the popup and the welcome page alike (FRU-511): the start, and the
 * claims while the word is on the screen. No DOM and no `browser` here: each page draws the screens
 * and binds the seams, and `connect-loop.test.ts` runs every step under `node --test`.
 */

/** What stopped a sign-in before the console had a request: the alert of `signInStop`. */
export type StartStop = 'blocked' | 'unavailable' | 'untrusted';

export type SignInStart = { ok: true; pending: PendingConnect } | { ok: false; stop: StartStop };

const STOP_OF_START: Record<StartFailure, StartStop> = {
  unavailable: 'unavailable',
  'insecure-endpoint': 'unavailable',
  'untrusted-console': 'untrusted',
};

export type StartSeams = {
  connect: ConnectSeams;
  /** Keeps the console of `endpoint`, for « Open the console » once signed in. */
  rememberConsole: (endpoint: string, consoleAt: string) => Promise<void>;
};

/**
 * Start a sign-in with the Fruitback at `endpoint`, once the browser gave access to it.
 *
 * **`granted` is the request of the access, already sent by the click.** A host permission may only
 * be asked for while the click is handled: the caller asks before anything is awaited, and hands the
 * promise here.
 *
 * `fresh`: « Start again », or a sign-in after one that did not finish. The request kept is forgotten
 * rather than given back.
 */
export async function startSignIn(
  endpoint: string,
  granted: Promise<boolean>,
  fresh: boolean,
  seams: StartSeams,
): Promise<SignInStart> {
  if (!(await granted.catch(() => false))) return { ok: false, stop: 'blocked' };
  if (fresh) await forgetConnect(seams.connect).catch(() => undefined);
  const started = await startConnect(endpoint, seams.connect).catch(
    () => ({ ok: false, reason: 'unavailable' }) as const,
  );
  if (!started.ok) return { ok: false, stop: STOP_OF_START[started.reason] };
  await seams.rememberConsole(endpoint, started.pending.consoleAt).catch(() => undefined);

  return { ok: true, pending: started.pending };
}

export type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type ClaimLoop = {
  /**
   * Claim at the pace the worker asked. The answer that the screen already shows (`waiting`, or
   * `unavailable` when `unanswered`) claims again; any other answer goes to `onChange`, once, and the
   * loop stops: the page draws its new screen, and starts the loop again if it shows the word.
   */
  wait(pending: Pick<PendingConnect, 'interval'>, unanswered: boolean, onChange: (now: ConnectState) => void): void;
  /** No claim goes on, and the answer of a claim in the air is dropped: the screen it was for is gone. */
  stop(): void;
};

/**
 * The claims of one page. One loop at a time: `wait` and `stop` clear the claim to come, and an
 * answer that arrives after either is not for the screen that is drawn now.
 */
const TIMERS: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

export function claimLoop(connect: ConnectSeams, timers: Timers = TIMERS): ClaimLoop {
  let next: unknown;
  let generation = 0;

  const stop = (): void => {
    generation += 1;
    timers.clearTimeout(next);
    next = undefined;
  };
  const wait: ClaimLoop['wait'] = (pending, unanswered, onChange) => {
    stop();
    const mine = generation;
    next = timers.setTimeout(() => {
      void pollConnect(connect)
        .catch((): ConnectState => 'unavailable')
        .then((now) => {
          if (mine !== generation) return;
          if (now === (unanswered ? 'unavailable' : 'waiting')) wait(pending, unanswered, onChange);
          else onChange(now);
        });
    }, pending.interval * 1000);
  };

  return { wait, stop };
}
