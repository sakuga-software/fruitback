import { browser } from 'wxt/browser';
import { type StoredSession, describeIdentity } from '../../src/session.ts';
import { whenNotAnswering } from '../../src/guide.ts';
import { t } from '../../src/i18n.ts';
import { consoleOf, rememberConsole, requestWorkerAccess } from '../../src/connect-browser.ts';
import { type StartStop, startSignIn } from '../../src/connect-loop.ts';
import { type AccountState } from '../../src/popup-state.ts';
import { type Account, problem, signInStop, signedOut } from '../../src/popup-view.ts';
import { hostOf } from '../../src/kit.ts';

import { app, claims, CLOUD, connect, draws, openSettings, render, sessions } from './context.ts';

/** The sign-in to the Fruitback of the build (FRU-251), and the account it holds (FRU-560). */

/** 4 (FRU-297): the account is kept, and its Fruitback did not answer. */
export function unreachableScreen(account: Account | undefined): HTMLElement {
  return problem(document, {
    title: t("Fruitback can't reach {server}", { server: hostOf(CLOUD ?? '') }),
    text: t('Check the connection, then try again.'),
    primary: { label: t('Try again'), onClick: () => void render() },
    help: whenNotAnswering(),
    onSettings: openSettings,
    ...(account === undefined ? {} : { account }),
  });
}

/**
 * The session of the account of this build's Fruitback, as the popup found it.
 *
 * Asked only when there is one: `ensureAccess` answers from the grant it holds while that is fresh,
 * and refreshes it otherwise. A refusal forgets the session (`session.ts`), so `ended` is said once.
 */
export async function accountOf(held: Record<string, StoredSession>): Promise<AccountState> {
  if (CLOUD === undefined || held[CLOUD]?.account !== true) return 'none';
  const access = await sessions.ensureAccess(CLOUD).catch(() => undefined);
  if (access === undefined || (!access.ok && access.reason === 'unavailable')) return 'unreachable';
  if (!access.ok) return access.reason === 'session-revoked-or-expired' ? 'ended' : 'none';

  return 'ok';
}

/** The person in the head and the foot: the account of this build's Fruitback, when it is held. */
export async function accountShown(held: Record<string, StoredSession>): Promise<Account | undefined> {
  const session = CLOUD === undefined ? undefined : held[CLOUD];
  if (CLOUD === undefined || session?.account !== true) return undefined;
  const consoleAt = await consoleOf(CLOUD).catch(() => undefined);

  return {
    name: describeIdentity(session.identity),
    ...(session.identity.email === undefined ? {} : { email: session.identity.email }),
    ...(consoleAt === undefined ? {} : { console: consoleAt }),
  };
}

/**
 * « Sign in to Fruitback » (FRU-251): the extension asks, the console approves.
 *
 * **The access to Fruitback is asked for first, and nothing is awaited before it**, for the reason
 * `pairing` gives: a host permission may only be asked for while the click is handled. It is the
 * optional access the manifest already declares for every origin, asked for this Fruitback only.
 * Then the request, the screen with the word, and the tab of the console, last: opening a tab can
 * close this popup, and the background keeps claiming (`background.ts`).
 *
 * `fresh`: « Start again », or a sign-in after one that did not finish. The request kept is forgotten
 * rather than given back.
 */
export function signIn(origin: string, fresh: boolean): void {
  if (CLOUD === undefined || app === null) return;
  const endpoint = CLOUD;
  // Imported, `app` is not narrowed in the closures below: this one is.
  const screen = app;
  // No claim of the screen before goes on while this sign-in starts.
  claims.stop();
  draws.drawn += 1;
  const granted = requestWorkerAccess(endpoint);
  for (const button of screen.querySelectorAll('button')) button.disabled = true;

  void (async () => {
    const started = await startSignIn(endpoint, granted, fresh, { connect, rememberConsole });
    if (!started.ok) {
      screen.replaceChildren(problemScreen(origin, started.stop));

      return;
    }
    await render();
    await browser.tabs.create({ url: started.pending.approveAt });
  })().catch((error: unknown) => {
    // A click is fire-and-forget: an error nobody catches here is said nowhere, and the buttons
    // stay disabled. The request that waits, if any, is kept: the next popup shows its word.
    console.error('[fruitback] the sign-in did not start', error);
    screen.replaceChildren(problemScreen(origin, 'unavailable'));
  });
}

/** 1, with what stopped the sign-in in an alert above the ways to sign in again (FRU-297). */
export function problemScreen(origin: string, stopped: StartStop): HTMLElement {
  return signedOut(document, {
    canSignIn: CLOUD !== undefined,
    stop: signInStop(stopped),
    onSignIn: () => signIn(origin, true),
    onSettings: openSettings,
  });
}
