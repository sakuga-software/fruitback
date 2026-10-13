import { browser } from 'wxt/browser';
import { type ConnectSeams, type PendingArea, browserLabel, parsePending } from './connect.ts';
import { postJson } from './session-browser.ts';
import type { Sessions } from './session.ts';

/**
 * `connect.ts` wired to the real browser (FRU-251), as `session-browser.ts` wires `session.ts`.
 *
 * **The request waits in `storage.session`, and only there.** Its claim takes a session worth thirty
 * days once the console approves it. `session` is emptied when the browser closes, and its default
 * access level keeps it to the popup and the background: no content script reads it, and the page
 * never hears of it. Nothing here calls `setAccessLevel`.
 */
export const PENDING_CONNECT_KEY = 'fruitback:connect';

/** The address of the console of each Fruitback signed in to, for « Open the console ». Not a secret. */
const CONSOLES_KEY = 'fruitback:consoles';

export function browserPendingArea(): PendingArea {
  return {
    read: async () => parsePending((await browser.storage.session.get(PENDING_CONNECT_KEY))[PENDING_CONNECT_KEY]),
    write: async (pending) => {
      if (pending === undefined) await browser.storage.session.remove(PENDING_CONNECT_KEY);
      else await browser.storage.session.set({ [PENDING_CONNECT_KEY]: pending });
    },
  };
}

export function createBrowserConnect(sessions: Pick<Sessions, 'claim' | 'list'>): ConnectSeams {
  return {
    pending: browserPendingArea(),
    post: postJson,
    sessions,
    browser: browserLabel(navigator.userAgent),
  };
}

export async function rememberConsole(endpoint: string, consoleAt: string): Promise<void> {
  const kept = await consoles();
  await browser.storage.local.set({ [CONSOLES_KEY]: { ...kept, [endpoint]: consoleAt } });
}

export async function consoleOf(endpoint: string): Promise<string | undefined> {
  return (await consoles())[endpoint];
}

async function consoles(): Promise<Record<string, string>> {
  const value: unknown = (await browser.storage.local.get(CONSOLES_KEY))[CONSOLES_KEY];
  if (typeof value !== 'object' || value === null) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
