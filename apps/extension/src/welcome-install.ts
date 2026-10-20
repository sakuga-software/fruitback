/**
 * When the page of `welcome.ts` opens (FRU-318). Apart from the page, so the background imports no
 * code that draws.
 */

/** Where the page is in the build: `entrypoints/welcome/index.html`. */
export const WELCOME_PATH = '/welcome.html';

/** Whether this event of `runtime.onInstalled` opens the page: a first install only, never an update. */
export function opensWelcome(details: { reason: string }): boolean {
  return details.reason === 'install';
}
