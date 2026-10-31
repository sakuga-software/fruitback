import { browser } from 'wxt/browser';
import { language, msg, setLanguage, t } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { type ConnectState } from '../../src/connect.ts';
import { claimLoop, startSignIn } from '../../src/connect-loop.ts';
import { type CloudSeams, type Offer, cloudEntry, sitesOf } from '../../src/cloud.ts';
import { consoleOf, createBrowserConnect, rememberConsole, requestWorkerAccess } from '../../src/connect-browser.ts';
import { pickOnFirstActivation } from '../../src/first-pick.ts';
import { cloudEndpoint } from '../../src/popup-state.ts';
import { signInStop } from '../../src/popup-view.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { describeIdentity } from '../../src/session.ts';
import { readAll, rememberPreviews, writeSite } from '../../src/sites.ts';
import { parseAnswer, tabCommand } from '../../src/tab-command.ts';
import { injectIntoOpenTabs, tabLoaded } from '../../src/tab-injection.ts';
import { browserTabScripting } from '../../src/tab-scripting-browser.ts';
import { type WelcomeSignIn, type WelcomeSite, welcomeScreen } from '../../src/welcome.ts';

/** The page that opens at install (FRU-318), and its sign-in (FRU-482): what `src/welcome.ts` draws. */
setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

const CLOUD = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);
const sessions = createBrowserSessions();
const connect = createBrowserConnect(sessions);
const app = document.querySelector('#app');

/** The tab of the console that this page opened, closed once the console approved. */
let approveTab: number | undefined;
/** The claims while the page shows the word: the same loop as the popup's. Every draw stops it. */
const claims = claimLoop(connect);
/** Each draw counts: a claim of a screen that is gone does not draw. */
let drawn = 0;
/** The sites of the account, by origin, as the last read listed them (FRU-483). */
let offers = new Map<string, Offer>();

const NO_ACCESS = msg('The browser did not give access to this site. Press Turn on again, then allow it.');
const NOT_TURNED_ON = msg('The site could not be turned on. Try again.');

// `action.openPopup` needs no permission. Where the browser does not let a page call it, it rejects,
// and the page says where the icon is.
const openPopup = () => browser.action.openPopup();

function draw(state: WelcomeSignIn | undefined): void {
  drawn += 1;
  claims.stop();
  app?.replaceChildren(
    welcomeScreen(document, {
      openPopup,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      ...(state === undefined
        ? {}
        : {
            signIn: {
              state,
              onSignIn: () => signIn(false),
              onStartAgain: () => signIn(true),
              onTurnOn: turnOnAndOpen,
              onOpen: (origin: string) => void browser.tabs.create({ url: origin }),
              onAddSite: () => void addSite(),
            },
          }),
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

async function show(problem?: string): Promise<void> {
  const state = await current();
  draw(state);
  if (state?.kind === 'connecting') waitForTheConsole(false);
  if (state?.kind !== 'signed-in') return;
  const screen = drawn;
  const sites = await sitesNow();
  if (screen === drawn) draw({ ...state, sites, ...(problem === undefined ? {} : { problem }) });
}

/** What `sitesOf` needs, bound to this page's one `Sessions`, as `cloudSeams` of the popup. */
function cloudSeams(): CloudSeams {
  return {
    endpoints: async () => Object.keys(await sessions.list()),
    ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
    remember: rememberPreviews,
    sessionOf: async (endpoint) => {
      const held = (await sessions.list())[endpoint];

      return held === undefined ? undefined : (held.epoch ?? '');
    },
  };
}

/** The sites of the account, each on when a rule of this browser turns it on. */
async function sitesNow(): Promise<readonly WelcomeSite[] | 'unavailable'> {
  const listed = CLOUD === undefined ? undefined : await sitesOf(CLOUD, cloudSeams()).catch(() => undefined);
  if (listed === undefined) return 'unavailable';
  offers = new Map(listed.map((offer) => [offer.pattern, offer]));
  const rules = await readAll();

  return listed.map((offer) => ({ origin: offer.pattern, on: rules[offer.pattern]?.enabled === true }));
}

/**
 * « Turn on <site> » (FRU-483), as « Turn on » of the popup: the browser asks for that site, the rule
 * is written, and the site opens with its widget.
 *
 * **The request comes first, from this click**: a host permission may only be asked for while the
 * click is handled, so nothing is awaited before it.
 */
function turnOnAndOpen(origin: string): void {
  const offer = offers.get(origin);
  if (offer === undefined) return;
  const granted = browser.permissions.request({ origins: [matchPatternFor(offer.pattern)] });
  for (const button of app?.querySelectorAll('button') ?? []) button.disabled = true;

  void (async () => {
    if (!(await granted.catch(() => false))) return show(t(NO_ACCESS));
    await writeSite(offer.pattern, cloudEntry(offer));
    const opened = await browser.tabs.create({ url: origin });
    await show();
    if (opened.id === undefined) return;
    const tab = opened.id;
    // The site can load before the background registers the scripts: as the popup does, the tab
    // gets them after its load. Both files refuse to run twice in one frame.
    await tabLoaded(browser.tabs, tab);
    await injectIntoOpenTabs(browserTabScripting, offer.pattern);
    // FRU-485: the first activation opens the choice of an element, once the widget is there.
    // It never rejects: the site is on, whatever the storage of the first activation does.
    void pickOnFirstActivation(browser.storage.local, offer.pattern, async () =>
      parseAnswer(await browser.tabs.sendMessage(tab, tabCommand('leave-feedback'))),
    );
  })().catch((error: unknown) => {
    console.error('[fruitback] could not turn the site on', error);
    void show(t(NOT_TURNED_ON));
  });
}

/** The setup of the console: an account with no site adds its first one there. */
async function addSite(): Promise<void> {
  const consoleAt = CLOUD === undefined ? undefined : await consoleOf(CLOUD);
  if (consoleAt !== undefined) await browser.tabs.create({ url: `${consoleAt}/setup` });
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
  const granted = requestWorkerAccess(endpoint);
  for (const button of app?.querySelectorAll('button') ?? []) button.disabled = true;

  void (async () => {
    const started = await startSignIn(endpoint, granted, fresh, { connect, rememberConsole });
    if (!started.ok) return draw({ kind: 'signed-out', stop: signInStop(started.stop) });
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
    claims.wait(waiting, unanswered, (now) => void answered(now, screen, waiting.word, unanswered));
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
