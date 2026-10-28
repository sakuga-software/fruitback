import { browser } from 'wxt/browser';
import { workerOrigin } from '../../src/endpoint.ts';
import { language, setLanguage } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { type ConnectState, forgetConnect, pollConnect, startConnect } from '../../src/connect.ts';
import { createBrowserConnect, rememberConsole } from '../../src/connect-browser.ts';
import { cloudEndpoint } from '../../src/popup-state.ts';
import { signInStop } from '../../src/popup-view.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { describeIdentity } from '../../src/session.ts';
import { type WelcomeSignIn, welcomeScreen } from '../../src/welcome.ts';

/** The page that opens at install (FRU-318), and its sign-in (FRU-482): what `src/welcome.ts` draws. */
setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

const CLOUD = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);
const sessions = createBrowserSessions();
const connect = createBrowserConnect(sessions);
const app = document.querySelector('#app');

/** The tab of the console that this page opened, closed once the console approved. */
let approveTab: number | undefined;
let nextClaim: ReturnType<typeof setTimeout> | undefined;
/** Each draw counts: a claim of a screen that is gone does not draw. */
let drawn = 0;

// `action.openPopup` needs no permission. Where the browser does not let a page call it, it rejects,
// and the page says where the icon is.
const openPopup = () => browser.action.openPopup();

function draw(state: WelcomeSignIn | undefined): void {
  drawn += 1;
  clearTimeout(nextClaim);
  app?.replaceChildren(
    welcomeScreen(document, {
      openPopup,
      ...(state === undefined
        ? {}
        : { signIn: { state, onSignIn: () => signIn(false), onStartAgain: () => signIn(true) } }),
    }),
  );
}

/** Where the sign-in is now: an account of the build's Fruitback, a request that waits, or nothing. */
async function current(): Promise<WelcomeSignIn | undefined> {
  if (CLOUD === undefined) return undefined;
  const held = (await sessions.list())[CLOUD];
  if (held?.account === true) return { kind: 'signed-in', who: held.identity.email ?? describeIdentity(held.identity) };
  const waiting = await connect.pending.read();
  if (waiting !== undefined) return { kind: 'connecting', word: waiting.word };

  return { kind: 'signed-out' };
}

async function show(): Promise<void> {
  const state = await current();
  draw(state);
  if (state?.kind === 'connecting') waitForTheConsole(false);
}

/**
 * « Sign in with email », as in the popup (`popup/main.ts`, FRU-251).
 *
 * **The access to Fruitback is asked for first, and nothing is awaited before it**: a host permission
 * may only be asked for while the click is handled.
 */
function signIn(fresh: boolean): void {
  if (CLOUD === undefined) return;
  const endpoint = CLOUD;
  const granted = browser.permissions.request({ origins: [matchPatternFor(workerOrigin(endpoint))] });
  for (const button of app?.querySelectorAll('button') ?? []) button.disabled = true;

  void (async () => {
    if (!(await granted.catch(() => false))) return draw({ kind: 'signed-out', stop: signInStop('blocked') });
    if (fresh) await forgetConnect(connect).catch(() => undefined);
    const started = await startConnect(endpoint, connect).catch(() => ({ ok: false, reason: 'unavailable' }) as const);
    if (!started.ok) {
      return draw({
        kind: 'signed-out',
        stop: signInStop(started.reason === 'untrusted-console' ? 'untrusted' : 'unavailable'),
      });
    }
    await rememberConsole(endpoint, started.pending.consoleAt).catch(() => undefined);
    draw({ kind: 'connecting', word: started.pending.word });
    waitForTheConsole(false);
    approveTab = (await browser.tabs.create({ url: started.pending.approveAt })).id;
  })().catch((error: unknown) => {
    console.error('[fruitback] the sign-in did not start', error);
    draw({ kind: 'signed-out', stop: signInStop('unavailable') });
  });
}

/** Claims at the pace the worker gave, while this page is open: the popup does the same. */
function waitForTheConsole(unanswered: boolean): void {
  const screen = drawn;
  void connect.pending.read().then((waiting) => {
    if (waiting === undefined || screen !== drawn) return;
    nextClaim = setTimeout(() => {
      void pollConnect(connect)
        .catch((): ConnectState => 'unavailable')
        .then((now) => answered(now, screen, waiting.word, unanswered));
    }, waiting.interval * 1000);
  });
}

async function answered(now: ConnectState, screen: number, word: string, unanswered: boolean): Promise<void> {
  if (screen !== drawn) return;
  if (now === 'waiting' || now === 'unavailable') {
    if ((now === 'unavailable') !== unanswered) draw({ kind: 'connecting', word, unanswered: now === 'unavailable' });
    waitForTheConsole(now === 'unavailable');

    return;
  }
  if (now === 'refused' || now === 'expired') return draw({ kind: 'signed-out', stop: signInStop(now) });
  // Signed in here, or claimed by the popup meanwhile (`none`): the session says which.
  if (now === 'signed-in') await backToThisPage();
  await show();
}

/** The tab of the console is done: it closes, and this page comes to the front again. */
async function backToThisPage(): Promise<void> {
  if (approveTab !== undefined) await browser.tabs.remove(approveTab).catch(() => undefined);
  approveTab = undefined;
  const self = await browser.tabs.getCurrent().catch(() => undefined);
  if (self?.id !== undefined) await browser.tabs.update(self.id, { active: true }).catch(() => undefined);
}

await show();
