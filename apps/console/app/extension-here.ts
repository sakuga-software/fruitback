import { useCallback, useEffect, useState } from 'react';
import { API, answerConnect, connectRequest } from './api.ts';
import { CHROME_WEB_STORE } from './extension-store.ts';
import { instanceOf } from './instance.ts';
import { msg } from './i18n.ts';

/**
 * The extension of this browser, asked by the console of Fruitback Cloud (FRU-487).
 *
 * The extension of the store declares `externally_connectable` for `https://app.fruitback.com` alone
 * (`apps/extension/src/external-console.ts`). On that origin, Chrome gives the page
 * `chrome.runtime.sendMessage(id, …)` to the extensions that declare it, and nothing on any other.
 * Step 3 of the setup asks whether Fruitback is here, and connects it in place: the extension starts
 * a request with the Cloud and answers its id, this page approves it with the session of the person,
 * and the extension claims the session with the secret it kept. No word to compare: the request came
 * from this browser, through the browser.
 *
 * Firefox and Safari have no such way here (`docs/decisions/extension.md`): `chrome.runtime` is not
 * there, every ask answers `undefined`, and the screen offers the flow of before.
 */

/** The id of the extension on the Chrome Web Store, out of its address. Edge installs from there too. */
export const STORE_EXTENSION_ID = CHROME_WEB_STORE.split('/').at(-1) ?? '';

/** An id of Chrome: 32 letters from `a` to `p`. */
const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * The extensions to ask: those `/config.js` names (`extensionIds`), or the one of the store on the
 * console of the Cloud, or none. A self-hosted console asks none by default: the extension of the
 * store answers no other console, and a build for that instance has no console at all.
 */
export function extensionIdsFrom(written: unknown, api: string): string[] {
  const listed = (written as { extensionIds?: unknown } | null | undefined)?.extensionIds;
  if (Array.isArray(listed)) {
    return listed.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id)).slice(0, 4);
  }

  return instanceOf(api).cloud ? [STORE_EXTENSION_ID] : [];
}

/** The extensions this console asks, read once when the bundle starts. */
export const EXTENSION_IDS: readonly string[] = extensionIdsFrom(
  (globalThis as { __FRUITBACK__?: unknown }).__FRUITBACK__,
  API,
);

/** The only part of `chrome` this page uses. */
type Runtime = {
  sendMessage(id: string, message: unknown, answer: (response: unknown) => void): void;
  lastError?: unknown;
};

function runtime(): Runtime | undefined {
  const found = (globalThis as { chrome?: { runtime?: Partial<Runtime> } }).chrome?.runtime;

  return typeof found?.sendMessage === 'function' ? (found as Runtime) : undefined;
}

/** How long an extension has to answer. An absent one answers at once, with an error. */
const ASK_TIMEOUT_MS = 3_000;

/**
 * How long `connect` and `claim` may take: the extension calls the worker before it answers, and
 * its own calls stop after 5 s (`session.ts`). Longer, so a slow worker is not read as a failure.
 */
const WORKER_ASK_TIMEOUT_MS = 15_000;

/** One message to one extension: its answer, or `undefined` when none came. Never throws. */
export function ask(
  id: string,
  message: unknown,
  chrome: Runtime | undefined = runtime(),
  timeoutMs: number = ASK_TIMEOUT_MS,
): Promise<unknown> {
  if (chrome === undefined) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    try {
      chrome.sendMessage(id, message, (response) => {
        clearTimeout(timer);
        // Read, so Chrome does not log it as unchecked: no such extension, or it did not answer.
        resolve(chrome.lastError === undefined || chrome.lastError === null ? response : undefined);
      });
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/** The extension in this browser: which id answered, and whether it holds a session of the Cloud. */
export type Here = { id: string; signedIn: boolean };

/** The answer to `hello`, key by key. */
export function parseHello(answer: unknown): boolean | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { v, ok, signedIn } = answer as Record<string, unknown>;

  return v === 1 && ok === true && typeof signedIn === 'boolean' ? signedIn : undefined;
}

/** The first extension of `ids` that answers, or `undefined`. */
export async function findHere(ids: readonly string[], chrome?: Runtime): Promise<Here | undefined> {
  for (const id of ids) {
    const signedIn = parseHello(await ask(id, { type: 'fruitback:hello', v: 1 }, chrome));
    if (signedIn !== undefined) return { id, signedIn };
  }

  return undefined;
}

/**
 * What `connectHere` ended with. `signed-out`: the console has no session to approve with.
 * `approved`: approved, and the extension had not claimed it yet when the page stopped asking: its
 * alarm claims it within a minute, and a new press claims the same request (`startConnect` gives it
 * back while it waits), with no second approval.
 */
export type HereResult = 'connected' | 'approved' | 'failed' | 'signed-out';

export type HereSeams = {
  chrome?: Runtime;
  read?: typeof connectRequest;
  approve?: typeof answerConnect;
  wait?: (ms: number) => Promise<void>;
};

/** What the card says after `connectHere`, or `undefined` once connected. */
export function hereProblemOf(result: HereResult): string | undefined {
  if (result === 'connected') return undefined;
  // The session of the console ended: the extension is fine, and « Try again » would fail the same way.
  if (result === 'signed-out') return msg('Your session ended. Sign in again, then connect this browser.');
  if (result === 'approved') {
    return msg('Approved. The extension finishes connecting within a minute, or press again to finish now.');
  }

  return msg('This browser was not connected. Try again.');
}

/** How often, and how many times, the page asks the extension to claim after the approval. */
const CLAIM_EVERY_MS = 5_500;
const CLAIMS = 8;

/**
 * Connects the extension `id` of this browser to the account of this console: the extension starts
 * the request, this page approves it, the extension claims it.
 *
 * The word and the account are read from the worker, as `/connect` reads them, and sent back with
 * the approval: the worker takes an answer for that word and that account only. The page never
 * reads a claim or a token: the extension keeps both.
 */
export async function connectHere(id: string, seams: HereSeams = {}): Promise<HereResult> {
  // A read or an approval that rejects is a failure said on the card, never a button left busy.
  return connectSteps(id, seams).catch((): HereResult => 'failed');
}

async function connectSteps(id: string, seams: HereSeams): Promise<HereResult> {
  const { read = connectRequest, approve = answerConnect } = seams;
  const wait = seams.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = (await ask(id, { type: 'fruitback:connect', v: 1 }, seams.chrome, WORKER_ASK_TIMEOUT_MS)) as Record<
    string,
    unknown
  >;
  if (started?.v !== 1 || started.ok !== true || typeof started.request !== 'string') {
    // Signed in since the screen asked: it is connected.
    return started?.reason === 'signed-in' ? 'connected' : 'failed';
  }
  const request = started.request;

  const asked = await read(request);
  if (!asked.ok) return asked.status === 401 ? 'signed-out' : 'failed';
  const { word, account, state } = asked.data;
  if (state === 'pending') {
    if (word === undefined || account === undefined) return 'failed';
    const approved = await approve(request, { word, account }, true);
    if (!approved.ok) return approved.status === 401 ? 'signed-out' : 'failed';
  } else if (state !== 'approved' && state !== 'claimed') {
    return 'failed';
  }

  for (let claim = 0; claim < CLAIMS; claim += 1) {
    const answer = (await ask(id, { type: 'fruitback:claim', v: 1, request }, seams.chrome, WORKER_ASK_TIMEOUT_MS)) as
      | Record<string, unknown>
      | undefined;
    // Approved already: no answer this time is not a failure. The next ask, or the alarm, finishes it.
    if (answer === undefined) {
      await wait(CLAIM_EVERY_MS);
      continue;
    }
    if (answer?.v === 1 && answer.ok === true && answer.state === 'signed-in') return 'connected';
    if (answer?.ok !== true || (answer.state !== 'waiting' && answer.state !== 'unavailable')) return 'failed';
    await wait(CLAIM_EVERY_MS);
  }

  // Approved by the worker, not claimed yet: not a failure, and the card says so.
  return 'approved';
}

/**
 * The extension of this browser, for step 3 of the setup: `undefined` while it is asked, and when no
 * extension answered. Asked again when the tab is shown again: the person comes back from the store.
 */
export function useExtensionHere(ids: readonly string[]): {
  here: Here | undefined;
  connect: () => Promise<HereResult>;
} {
  const [here, setHere] = useState<Here | undefined>();
  const key = ids.join(',');
  const look = useCallback(async () => {
    const found = await findHere(key === '' ? [] : key.split(','));
    setHere(found);

    return found;
  }, [key]);

  useEffect(() => {
    if (key === '') return undefined;
    let stopped = false;
    const shown = () => {
      if (document.visibilityState === 'visible' && !stopped) void look();
    };
    void look();
    document.addEventListener('visibilitychange', shown);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', shown);
    };
  }, [key, look]);

  const connect = useCallback(async (): Promise<HereResult> => {
    if (here === undefined) return 'failed';
    const result = await connectHere(here.id);
    await look();

    return result;
  }, [here, look]);

  return { here, connect };
}
