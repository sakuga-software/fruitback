import { browser } from 'wxt/browser';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM } from '../../src/site-editor.ts';
import { rememberPreviews, writeSite } from '../../src/sites.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { createBrowserAccessReturn } from '../../src/access-return-browser.ts';
import { showProblem } from '../../src/problem-view.ts';
import { createBrowserPending } from '../../src/pending-site-browser.ts';
import { type CloudSeams, finishAdd } from '../../src/cloud.ts';
import { type ConnectState } from '../../src/connect.ts';
import { createBrowserConnect } from '../../src/connect-browser.ts';
import { claimLoop } from '../../src/connect-loop.ts';
import { cloudEndpoint } from '../../src/popup-state.ts';
import { hostOf, make } from '../../src/kit.ts';

/**
 * What every screen of the popup shares (FRU-560): the one `Sessions`, the sign-in that waits, the
 * site kept across a prompt, the Fruitback of the build, and `render`, which `main.ts` binds.
 */

/**
 * One for the whole popup, not one per render.
 *
 * Building it runs the upgrade to one key per endpoint (FRU-63), and `render` runs again after
 * every pairing, logout and site change. Two of these also hold separate in-flight refresh maps, so
 * they can each spend the same refresh token.
 */
export const sessions = createBrowserSessions();

/** Gives back to the browser the access that no rule and no session uses (FRU-115). */
export const returnAccess = createBrowserAccessReturn(sessions);

/** The site somebody asked for, kept across a permission prompt that can close this popup (FRU-118). */
export const pending = createBrowserPending(writeSite, (pattern, intent) => finishAdd(pattern, intent, cloudSeams()));

export const app = document.querySelector('#app');

/**
 * The Fruitback « Sign in to Fruitback » signs in to, fixed at build (`WXT_FRUITBACK_CLOUD`). None in
 * a build for a self-hosted instance: the popup then sends to the settings alone.
 */
export const CLOUD = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);

/** The sign-in that waits for the console, kept in `storage.session` (see `connect-browser.ts`). */
export const connect = createBrowserConnect(sessions);

/** The claims while the popup shows the word. One loop at a time: every draw stops it. */
export const claims = claimLoop(connect);

export const openSettings = (): void => void browser.runtime.openOptionsPage();

/** The title of a screen about a site: its host, as the mock-up writes it (06, 07, 08). */
export function title(origin: string): HTMLElement {
  return make(document, 'h1', '', hostOf(origin));
}

/** What `offerFor` needs, bound to the popup's one `Sessions`. */
export function cloudSeams(): CloudSeams {
  return {
    endpoints: async () => Object.keys(await sessions.list()),
    ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
    renewAccess: (endpoint, refused) => sessions.renewAccess(endpoint, refused),
    // FRU-103: what the worker lists now is what this browser grants, before the click stores a rule.
    remember: rememberPreviews,
    // The epoch of the session in place: an answer is kept only for the session that asked.
    sessionOf: async (endpoint) => {
      const held = (await sessions.list())[endpoint];

      return held === undefined ? undefined : (held.epoch ?? '');
    },
  };
}

/**
 * A turn-on the reviewer refused: nothing was stored, and the screen says why.
 *
 * `again` is the same turn-on. It runs in the click of the remedy, so the browser asks again.
 */
export function refused(problem: HTMLElement, again: () => void): (granted: boolean) => void {
  return (granted) => {
    showProblem(problem, granted ? '' : NO_ACCESS_PROBLEM, { grant: again });
  };
}

/**
 * A change the background did not confirm, said on the screen and in the console.
 *
 * A click is fire-and-forget, so a rejection that is not handled here is reported nowhere. The change
 * can still be stored when only the answer was lost, so the words do not say it was not saved.
 */
export function failed(problem: HTMLElement): (error: unknown) => void {
  return (error) => {
    console.error('[fruitback] a site change was not confirmed', error);
    // The list is on the options page, and it says what storage holds now.
    showProblem(problem, STORE_PROBLEM, { list: () => void browser.runtime.openOptionsPage() });
  };
}

export function field(label: string, placeholder: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;

  const wrapper = document.createElement('label');
  wrapper.append(label, input);

  return { label: wrapper, input };
}

/** Buttons side by side, with a space between them, that go under each other when the room is short (FRU-169). */
export function actions(...buttons: HTMLElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'actions';
  group.append(...buttons);

  return group;
}

export type PopupTab = { id?: number; url?: string };

/** Which drawing the screen is: each `render` and each sign-in counts one. */
export const draws = { drawn: 0 };

/** What screen 3 says once, when it is drawn again after « Where notes go » saved (FRU-600). */
export const changed: { text?: string } = {};

let drawer: (editing?: boolean, claimedNow?: ConnectState) => Promise<void> = async () => undefined;

/** Draws the popup again. `main.ts` binds what draws (`drawWith`), so a screen needs no import of it. */
export function render(editing = false, claimedNow?: ConnectState): Promise<void> {
  return drawer(editing, claimedNow);
}

export function drawWith(draw: typeof drawer): void {
  drawer = draw;
}
