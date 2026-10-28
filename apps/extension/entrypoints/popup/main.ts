import { browser } from 'wxt/browser';
import { isSecureWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import {
  MODES_GUIDE,
  NOTES_NEED_SESSION,
  READ_NEEDS_SESSION,
  WORKER_NOT_FOUND,
  probeRead,
} from '../../src/read-probe.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored } from '../../src/site-editor.ts';
import { complaint, pairingFragment, pairingLinkIn, siteFrom } from '../../src/site-form.ts';
import { type ResolvedSite, isWildcardPattern } from '../../src/site-patterns.ts';
import { type SiteConfig, type SiteMode, findSite, readAll, rememberPreviews, writeSite } from '../../src/sites.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { isHidden, setHidden } from '../../src/page-visibility.ts';
import { browserTabScripting } from '../../src/tab-scripting-browser.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { createBrowserAccessReturn } from '../../src/access-return-browser.ts';
import { type SessionIdentity, type StoredSession, describeIdentity } from '../../src/session.ts';
import { currentShortcut } from '../../src/shortcut.ts';
import { showProblem } from '../../src/problem-view.ts';
import { PAIRING_CODE_REQUIRED, PAIRING_NEEDS_HTTPS, PAIRING_PROBLEM } from '../../src/remedy.ts';
import { type PairLink, parsePairLink } from '../../src/pair-link.ts';
import { createBrowserPending } from '../../src/pending-site-browser.ts';
import {
  type AddFailure,
  type CloudSeams,
  type Offer,
  type SettingsFailure,
  type SiteSettings,
  type Workspace,
  addSite,
  addableWorkspaces,
  cloudEntry,
  finishAdd,
  offerFor,
  setSiteSettings,
  sourceOffer,
} from '../../src/cloud.ts';
import { language, msg, setLanguage, t } from '../../src/i18n.ts';
import { holdsSiteAccess } from '../../src/site-grant.ts';
import { storedLanguage } from '../../src/language.ts';
import { rememberLanguage } from '../../src/language-sync.ts';
import {
  type ConnectState,
  type PendingConnect,
  type StartFailure,
  forgetConnect,
  pollConnect,
  startConnect,
} from '../../src/connect.ts';
import { consoleOf, createBrowserConnect, rememberConsole } from '../../src/connect-browser.ts';
import {
  type AccountState,
  type PopupState,
  cloudEndpoint,
  decide,
  wantsSession as siteWantsSession,
} from '../../src/popup-state.ts';
import { type TabCommand } from '../../src/protocol.ts';
import { type PanelApis, openPanelOrPage } from '../../src/side-panel.ts';
import { type TabCommandAnswer, parseAnswer, tabCommand } from '../../src/tab-command.ts';
import {
  type Account,
  keysOfShortcut,
  showSiteFacts,
  turnOnScreen,
  siteOn,
  connecting,
  hostOf,
  linkButton,
  loading,
  notAWebPage,
  problem,
  shell,
  signInStop,
  signedOut,
  visibilityRow,
} from '../../src/popup-view.ts';

/**
 * The switch for the tab you are looking at (FRU-41), in the shell of the mock-up of 2026-10-13
 * (FRU-251): the logo, the account and the gear above; « Sign in to Fruitback » for a browser that
 * holds nothing.
 *
 * Deliberately not the editor for every site: that is the options page (FRU-43), behind the gear.
 * Which screen is drawn is decided in `popup-state.ts`, and the screens of the sign-in are drawn in
 * `popup-view.ts`, both under `node --test`. What is here gathers the facts and wires the clicks.
 *
 * There is no framework in this popup on purpose. It is four elements, it opens and closes in under
 * a second, and a bundle for it would be larger than everything it renders.
 */

/**
 * One for the whole popup, not one per render.
 *
 * Building it runs the upgrade to one key per endpoint (FRU-63), and `render` runs again after
 * every pairing, logout and site change. Two of these also hold separate in-flight refresh maps, so
 * they can each spend the same refresh token.
 */
const sessions = createBrowserSessions();

/** Gives back to the browser the access that no rule and no session uses (FRU-115). */
const returnAccess = createBrowserAccessReturn(sessions);

/** The site somebody asked for, kept across a permission prompt that can close this popup (FRU-118). */
const pending = createBrowserPending(writeSite, (pattern, intent) => finishAdd(pattern, intent, cloudSeams()));

const app = document.querySelector('#app');

/**
 * The tab the popup was opened on, read once. Every screen is about that page, including the ones
 * drawn after « Sign in to Fruitback » opened the console in another tab: asked again, the active
 * tab would be the console's.
 */
const tabUnderThePopup = currentTab();

/**
 * The Fruitback « Sign in to Fruitback » signs in to, fixed at build (`WXT_FRUITBACK_CLOUD`). None in
 * a build for a self-hosted instance: the popup then sends to the settings alone.
 */
const CLOUD = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);

/** The sign-in that waits for the console, kept in `storage.session` (see `connect-browser.ts`). */
const connect = createBrowserConnect(sessions);

/** The next claim while the popup shows the word. One at a time: every draw clears it. */
let nextClaim: ReturnType<typeof setTimeout> | undefined;

/** Which drawing the screen is: each `render` and each sign-in counts one. */
let drawn = 0;

/** Somebody is in a field of the screen, or wrote in one: a pairing code, a word. */
function typing(): boolean {
  const fields = [...(app?.querySelectorAll('input, textarea') ?? [])] as (HTMLInputElement | HTMLTextAreaElement)[];

  return fields.some(
    (field) => field.ownerDocument.activeElement === field || (field.type !== 'checkbox' && field.value !== ''),
  );
}

/** The kind of the screen drawn last: a late language does not redraw a form (FRU-319). */
let shownKind: PopupState['kind'] | undefined;

/** The value of `drawn` when the last draw ended: equal to `drawn` when no draw is in flight. */
let finished = 0;

/** The screens a late language never draws again. */
const KEEP = new Set<PopupState['kind'] | undefined>(['form', 'pair-link', 'connecting']);

/** Settled when the first screen is on: a language learned before it waits for it. */
let markFirstDrawn: () => void = () => undefined;
const firstDrawn = new Promise<void>((resolve) => {
  markFirstDrawn = resolve;
});

const openSettings = (): void => void browser.runtime.openOptionsPage();

/** The language of the account when the extension knows it, the browser's own otherwise. */
const spoken = storedLanguage(browser.storage.local).then((kept) => {
  setLanguage(kept ?? navigator.language);
  document.documentElement.lang = language();
});

void spoken.then(() => {
  // Before anything is read: the popup never opens on an empty window.
  app?.replaceChildren(loading(document, { onSettings: openSettings }));

  return render();
});
// Not awaited. When the account speaks another language than the one this popup opened in, the
// screen is drawn again in it (FRU-319): the first popup after a change in the console spoke the
// language of before. Not a form: a draw would lose what somebody types there. The next popup
// reads what this one learned.
void rememberLanguage(browser.storage.local, cloudSeams())
  .then(() => firstDrawn)
  .then(async () => {
    const kept = await storedLanguage(browser.storage.local);
    const before = language();
    // Only over a screen that is drawn and stays: no draw in flight, and none that started while the
    // language was read (raised in review of #432). Not over a form, a pairing link, a sign-in that
    // waits for the console (it has its own claims), or a field somebody is in.
    if (finished !== drawn || KEEP.has(shownKind) || typing()) return;
    setLanguage(kept ?? navigator.language);
    if (language() === before) return;
    document.documentElement.lang = language();
    await render();
  })
  .catch(() => undefined);

/**
 * @param editing Show the fields for an origin that already has an entry.
 *
 * Without it there is no way to change one. An entry is written once and then only switched on and
 * off, so an origin turned on before FRU-57 could never be moved to team mode — which is every
 * origin a reviewer already uses. The options page edits every entry; this is the path from the
 * toolbar.
 */
/**
 * @param claimedNow What a claim just answered, when the caller made it: claiming again would find
 * the request already settled and forgotten, and the screen that says why would never be drawn.
 */
async function render(editing = false, claimedNow?: ConnectState): Promise<void> {
  if (app === null) return;
  clearTimeout(nextClaim);
  drawn += 1;
  const thisDraw = drawn;

  const tab = await tabUnderThePopup;
  const origin = originOf(tab?.url);
  const link = parsePairLink(tab?.url);

  // Claimed once now: the console may have approved while the popup was closed.
  const claimed = claimedNow ?? (await pollConnect(connect).catch(() => 'unavailable' as const));
  const pendingNow = await connect.pending.read().catch(() => undefined);
  // A request that another context settled in the meantime is not waiting any more.
  const stillWaiting = claimed === 'waiting' || claimed === 'unavailable';

  // The prompt closed the popup before it could store the site: finish it now if the background did not.
  await pending.settle().catch(() => undefined);

  const held = await sessions.list();
  const accountState = await accountOf(held);
  // Ended just now: `accountOf` forgot the session, and `held` is what was read before it.
  const account = accountState === 'ended' ? undefined : await accountShown(held);

  const found = origin === undefined ? undefined : await findSite(origin);
  // FRU-101: a site of the reviewer's workspace needs no form. One click, and nothing typed.
  const offer =
    origin !== undefined && found === undefined && !editing && !(link !== undefined && !editing)
      ? await offerFor(origin, cloudSeams())
      : undefined;

  const state = decide({
    ...(origin === undefined ? {} : { origin }),
    pairLink: link !== undefined,
    editing,
    canSignIn: CLOUD !== undefined,
    connect: stillWaiting && pendingNow === undefined ? 'none' : claimed,
    rule: found !== undefined,
    accessRemoved: found !== undefined && found.site.enabled && !(await holdsAccess(found.pattern)),
    ruleWantsSession: found !== undefined && (await wantsSession(found.site)),
    // A site of the workspace of this Fruitback, which did not answer (FRU-319).
    ruleUnreachable:
      found !== undefined && found.site.enabled && found.site.endpoint === CLOUD && accountState === 'unreachable',
    offer: offer !== undefined,
    account: accountState,
    sessions: Object.keys(held).length,
  });

  app.replaceChildren(
    await draw(state, { origin: origin ?? '', tab, link, found, offer, account, pending: pendingNow }),
  );
  shownKind = state.kind;
  // A later draw may have started while this one awaited: it is the one that ends the run.
  if (thisDraw === drawn) {
    finished = thisDraw;
    markFirstDrawn();
  }
  if (state.kind === 'connecting' && pendingNow !== undefined) waitForTheConsole(pendingNow, state.unanswered);
}

type Found = {
  origin: string;
  tab: PopupTab | undefined;
  link: PairLink | undefined;
  found: ResolvedSite | undefined;
  offer: Offer | undefined;
  account: Account | undefined;
  pending: PendingConnect | undefined;
};

async function draw(state: PopupState, facts: Found): Promise<HTMLElement> {
  const { origin, account } = facts;
  const frame = (...body: Node[]): HTMLElement =>
    shell(document, { onSettings: openSettings, ...(account === undefined ? {} : { account }) }, ...body);

  switch (state.kind) {
    case 'not-web':
      // A `chrome://` page, the store, a PDF viewer. Nothing is wrong, and saying so is better than an
      // enabled-looking switch that silently does nothing.
      return notAWebPage(document, { onSettings: openSettings, ...(account === undefined ? {} : { account }) });

    case 'pair-link': {
      // A pairing link is about a worker, not about a site to review, so it gets a screen of its own:
      // the form to switch this origin on would be the wrong question on a worker's own page.
      // An address of this shape is not proof of a worker: a page of a site to review can end in
      // `/pair` with a fragment that looks like a code. The way to the site's own screen stays open.
      const site = element('button', t(NOT_A_LINK), 'secondary');
      site.addEventListener('click', () => void render(true));

      return frame(title(origin), ...(await linked(facts.link as PairLink)), actions(site));
    }

    case 'connecting':
      return connecting(document, {
        word: facts.pending?.word ?? '',
        unanswered: state.unanswered,
        onStartAgain: () => signIn(origin, true),
        onSettings: openSettings,
      });

    case 'sign-in-problem':
      return signedOut(document, {
        canSignIn: CLOUD !== undefined,
        stop: signInStop(state.problem),
        onSignIn: () => signIn(origin, true),
        onSettings: openSettings,
      });

    case 'unreachable':
      return unreachableScreen(account);

    case 'no-access':
      return siteWithoutAccess(origin, facts.found as ResolvedSite, account);

    case 'signed-out':
      return signedOut(document, {
        canSignIn: state.canSignIn,
        ended: state.ended,
        onSignIn: () => signIn(origin, false),
        onSettings: openSettings,
      });

    case 'offer':
      return offered(origin, facts.offer as Offer, account);

    case 'new-site':
      return siteOfNoWorkspace(origin, account);

    case 'rule':
    case 'form': {
      const found = facts.found;
      // 07 (FRU-254): a site of a workspace this extension mounts the widget on, by its own origin.
      if (state.kind === 'rule' && found !== undefined && isWorkspaceSite(found)) {
        return siteOfWorkspaceOn(origin, found, facts.tab, account);
      }
      const open = state.kind === 'form';
      // What somebody typed before a prompt they refused, or that closed this popup (FRU-117).
      const draft = found === undefined ? await pending.draft(origin).catch(() => undefined) : undefined;
      const body: Node[] = [
        title(origin),
        // FRU-43: why the widget does or does not appear here must be answerable from the toolbar.
        element('p', found === undefined ? t(NO_RULE) : t('Rule: {pattern}', { pattern: found.pattern }), 'rule'),
        open || found === undefined ? form(origin, found, draft) : status(found, await visibility(origin)),
      ];
      // Pairing is against the **worker**, not the site, so there is nothing to ask for until one is
      // named. A reviewer holds one session per worker however many of its sites they have turned on.
      if (found !== undefined && !open) body.push(...(await session(found.site)));
      if (found !== undefined && !open && facts.tab?.url !== undefined)
        body.push(readability(found.site, facts.tab.url));
      if (found !== undefined && !open) body.push(otherCopyLine(facts.tab, found.site.enabled));

      return frame(...body);
    }
  }
}

/** 4 (FRU-297): the account is kept, and its Fruitback did not answer. */
function unreachableScreen(account: Account | undefined): HTMLElement {
  return problem(document, {
    title: t("Fruitback can't reach {worker}", { worker: hostOf(CLOUD ?? '') }),
    text: t('Check the connection, then try again.'),
    primary: { label: t('Try again'), onClick: () => void render() },
    onSettings: openSettings,
    ...(account === undefined ? {} : { account }),
  });
}

/** Whether the browser still grants the sites of a rule: access can be removed in its settings. */
async function holdsAccess(pattern: string): Promise<boolean> {
  // FRU-425: `<all_urls>` grants no rule (`src/site-grant.ts`).
  return holdsSiteAccess(matchPatternFor(pattern), browser.permissions).catch(() => true);
}

/**
 * 4 · A problem, with its fix (FRU-297): the rule is on, and the browser took its access away.
 *
 * « Allow access again » asks in the click itself: an await before `permissions.request` would lose
 * the gesture. « Turn off for this site » keeps the rule, off.
 */
function siteWithoutAccess(origin: string, { pattern, site }: ResolvedSite, account: Account | undefined): HTMLElement {
  const host = hostOf(origin);
  const screen = problem(document, {
    site: origin,
    title: t("Fruitback can't open this page"),
    text: t('Access to {host} was removed in your browser settings. Your notes are safe.', { host }),
    primary: {
      label: t('Allow access again'),
      onClick: () =>
        void browser.permissions
          .request({ origins: [matchPatternFor(pattern)] })
          .then(async (granted) => {
            if (!granted) return;
            await activateOpenTabs(pattern);
            await render();
          })
          .catch(failed(said)),
    },
    secondary: {
      label: t('Turn off for this site'),
      onClick: () => void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(said)),
    },
    onSettings: openSettings,
    ...(account === undefined ? {} : { account }),
  });
  const said = element('p', '', 'problem');
  screen.querySelector('.popup-body')?.append(said);

  return screen;
}

/**
 * A site of the workspace of this build's Fruitback, mounted by the extension, whose session is gone
 * now: it ended in the console, or a refresh was refused (FRU-238). Read after `accountOf`, which may
 * have forgotten it this very time.
 */
async function wantsSession(site: SiteConfig): Promise<boolean> {
  return siteWantsSession(site, CLOUD, await sessions.list());
}

/** The title of a screen about a site: its host, as the mock-up writes it (06, 07, 08). */
function title(origin: string): HTMLElement {
  return element('h1', hostOf(origin));
}

/**
 * The session of the account of this build's Fruitback, as the popup found it.
 *
 * Asked only when there is one: `ensureAccess` answers from the grant it holds while that is fresh,
 * and refreshes it otherwise. A refusal forgets the session (`session.ts`), so `ended` is said once.
 */
async function accountOf(held: Record<string, StoredSession>): Promise<AccountState> {
  if (CLOUD === undefined || held[CLOUD]?.account !== true) return 'none';
  const access = await sessions.ensureAccess(CLOUD).catch(() => undefined);
  if (access === undefined || (!access.ok && access.reason === 'unavailable')) return 'unreachable';
  if (!access.ok) return access.reason === 'session-revoked-or-expired' ? 'ended' : 'none';

  return 'ok';
}

/** The person in the head and the foot: the account of this build's Fruitback, when it is held. */
async function accountShown(held: Record<string, StoredSession>): Promise<Account | undefined> {
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
function signIn(origin: string, fresh: boolean): void {
  if (CLOUD === undefined || app === null) return;
  const endpoint = CLOUD;
  // No claim of the screen before goes on while this sign-in starts.
  clearTimeout(nextClaim);
  drawn += 1;
  for (const button of app.querySelectorAll('button')) button.disabled = true;

  void (async () => {
    const granted = await grantWorkerOrigin(endpoint).catch(() => false);
    if (!granted) {
      app.replaceChildren(problemScreen(origin, 'blocked'));

      return;
    }
    if (fresh) await forgetConnect(connect).catch(() => undefined);

    const started = await startConnect(endpoint, connect).catch(() => ({ ok: false, reason: 'unavailable' }) as const);
    if (!started.ok) {
      app.replaceChildren(problemScreen(origin, PROBLEM_OF_START[started.reason]));

      return;
    }
    await rememberConsole(endpoint, started.pending.consoleAt).catch(() => undefined);
    await render();
    await browser.tabs.create({ url: started.pending.approveAt });
  })().catch((error: unknown) => {
    // A click is fire-and-forget: an error nobody catches here is said nowhere, and the buttons
    // stay disabled. The request that waits, if any, is kept: the next popup shows its word.
    console.error('[fruitback] the sign-in did not start', error);
    app.replaceChildren(problemScreen(origin, 'unavailable'));
  });
}

const PROBLEM_OF_START: Record<StartFailure, 'unavailable' | 'untrusted'> = {
  unavailable: 'unavailable',
  'insecure-endpoint': 'unavailable',
  'untrusted-console': 'untrusted',
};

/** 1, with what stopped the sign-in in an alert above the ways to sign in again (FRU-297). */
function problemScreen(origin: string, stopped: 'unavailable' | 'untrusted' | 'blocked'): HTMLElement {
  return signedOut(document, {
    canSignIn: CLOUD !== undefined,
    stop: signInStop(stopped),
    onSignIn: () => signIn(origin, true),
    onSettings: openSettings,
  });
}

/**
 * Claim again at the pace the worker asked, while the word is on the screen.
 *
 * The screen is drawn again only when the answer changes: the same screen drawn every few seconds
 * would take the focus off « Start again » and read the status out again each time.
 */
function waitForTheConsole(waiting: PendingConnect, unanswered: boolean): void {
  clearTimeout(nextClaim);
  // A claim in the air when the screen changes must not start a second loop: it belongs to a
  // screen that is gone (raised in review: « Start again » while a claim was in the air).
  const screen = drawn;
  nextClaim = setTimeout(() => {
    void pollConnect(connect)
      .catch(() => 'unavailable' as const)
      .then((now) => {
        if (screen !== drawn) return;
        if (now === (unanswered ? 'unavailable' : 'waiting')) waitForTheConsole(waiting, unanswered);
        else void render(false, now);
      });
  }, waiting.interval * 1000);
}

const NO_RULE = msg('No rule covers this origin, so Fruitback does nothing here.');

/** What `offerFor` needs, bound to the popup's one `Sessions`. */
function cloudSeams(): CloudSeams {
  return {
    endpoints: async () => Object.keys(await sessions.list()),
    ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
    // FRU-103: what the worker lists now is what this browser grants, before the click stores a rule.
    remember: rememberPreviews,
    // The epoch of the session in place: an answer is kept only for the session that asked.
    sessionOf: async (endpoint) => {
      const held = (await sessions.list())[endpoint];

      return held === undefined ? undefined : (held.epoch ?? '');
    },
  };
}

/** The sites of a workspace in the console, where « Change » leads (FRU-298). */
function consoleSites(account: Account | undefined, workspace: string): (() => void) | undefined {
  if (account?.console === undefined) return undefined;
  const base = account.console.endsWith('/') ? account.console : `${account.console}/`;
  const url = new URL(`w/${encodeURIComponent(workspace)}/sites`, base).toString();

  return () => {
    void browser.tabs.create({ url });
    window.close();
  };
}

/**
 * 2 (FRU-298): a site of a workspace, not on in this browser. The one click (FRU-101): the browser
 * asks for this site only, and the click is the gesture that permission needs, so nothing is awaited
 * before `turnOn` asks.
 */
function offered(origin: string, offer: Offer, account: Account | undefined): HTMLElement {
  const problem = element('p', '', 'problem');
  const turn = (): void => void turnOn(offer.pattern, cloudEntry(offer)).then(refused(problem, turn), failed(problem));
  const change = consoleSites(account, offer.workspace.id);
  // FRU-453: a role that manages the sites chooses here, and each choice is written at once. Written
  // before « Turn on » and not by it: the prompt of the browser can close the popup, and a choice
  // that waited for the click would be lost with it.
  const sources = offer.workspace.sources;
  const save = async (settings: SiteSettings): Promise<boolean> => {
    problem.replaceChildren();
    const set = await setSiteSettings(offer.endpoint, offer.workspace, offer.site.id, settings, cloudSeams());
    if (!set.ok) showProblem(problem, t(SETTINGS_PROBLEM[set.reason]));

    return set.ok;
  };
  const screen = turnOnScreen(document, {
    origin,
    workspace: offer.workspace.name,
    ...(offer.site.destination === undefined ? {} : { destination: offer.site.destination.label }),
    visibility: offer.site.visibility,
    ...(account === undefined ? {} : { account }),
    ...(change === undefined ? {} : { onChange: change }),
    ...(sources === undefined
      ? {}
      : {
          choices: {
            sources: { [offer.workspace.id]: sources },
            workspace: offer.workspace.id,
            ...(offer.site.place === undefined ? {} : { place: offer.site.place }),
            loadOffer: (workspace, connector) => sourceOffer(offer.endpoint, workspace, connector, cloudSeams()),
            onVisibility: (visibility) => save({ visibility }),
            onPlace: (place) => save({ place }),
          },
        }),
    onTurnOn: turn,
    onSettings: openSettings,
  });
  screen.querySelector('.action-block')?.append(problem);

  return screen;
}

const SETTINGS_PROBLEM: Record<SettingsFailure, string> = {
  forbidden: msg('Your role in this workspace does not let you change this site.'),
  'several-places': msg('This site sends to several places. Change them in Fruitback.'),
  'unknown-place': msg('This place is not in the tracker any more. Choose another one.'),
  'signed-out': msg('Fruitback did not answer. Try again.'),
  unavailable: msg('Fruitback did not answer. Try again.'),
};

/**
 * 2 (FRU-298, FRU-255): a site of no workspace of the account. The workspaces where it may add one
 * are read now; none, and the popup says who can. « Turn on » adds it, then turns it on.
 */
async function siteOfNoWorkspace(origin: string, account: Account | undefined): Promise<HTMLElement> {
  const listed = CLOUD === undefined ? [] : await addableWorkspaces(CLOUD, cloudSeams());
  // Fruitback said nothing: that is an outage, not « ask an admin ».
  if (listed === undefined) return unreachableScreen(account);
  const workspaces = listed;
  const problem = element('p', '', 'problem');
  // FRU-453: what is chosen here is written once the site is added, before it is turned on.
  const wanted: SiteSettings = {};
  const screen = turnOnScreen(document, {
    origin,
    // A site is added for the members of its workspace: the worker's default.
    visibility: 'members',
    workspaces,
    choices: {
      sources: Object.fromEntries(workspaces.map((each) => [each.id, each.sources ?? []])),
      place: null,
      loadOffer: (workspace, connector) =>
        CLOUD === undefined ? Promise.resolve(undefined) : sourceOffer(CLOUD, workspace, connector, cloudSeams()),
      onVisibility: async (visibility) => {
        wanted.visibility = visibility;

        return true;
      },
      onPlace: async (place) => {
        wanted.place = place;

        return true;
      },
    },
    ...(account === undefined ? {} : { account }),
    onTurnOn: (id) => {
      const workspace = workspaces.find((each) => each.id === id);
      if (workspace !== undefined) addAndTurnOn(origin, workspace, problem, wanted);
    },
    onSettings: openSettings,
  });
  screen.querySelector('.action-block')?.append(problem);

  return screen;
}

/**
 * « Add to {workspace} and turn on ». **The access to the site is asked for first**, in the click:
 * the site is created after, so a refusal creates nothing, and « Grant access » asks again. Then the
 * site, then the rule, as the one click of 06 stores it.
 */
function addAndTurnOn(origin: string, workspace: Workspace, problem: HTMLElement, wanted: SiteSettings = {}): void {
  if (CLOUD === undefined) return;
  const endpoint = CLOUD;
  const again = (): void => addAndTurnOn(origin, workspace, problem, wanted);
  for (const button of app?.querySelectorAll('button') ?? []) button.disabled = true;
  const done = (): void => {
    for (const button of app?.querySelectorAll('button') ?? []) button.disabled = false;
  };

  // FRU-454: remembered before the prompt, which can close this popup: the background then adds the
  // site and turns it on when the access arrives, and nobody clicks « Turn on » twice. WARNING: not
  // awaited, an await before `permissions.request` loses the gesture.
  void pending
    .rememberAdd(origin, {
      endpoint,
      workspace: { id: workspace.id, name: workspace.name },
      ...(Object.keys(wanted).length === 0 ? {} : { settings: wanted }),
    })
    .catch(() => undefined);
  const forget = (): Promise<void> => pending.forget().catch(() => undefined);
  void (async () => {
    const granted = await browser.permissions.request({ origins: [matchPatternFor(origin)] }).catch(() => false);
    if (!granted) {
      // Refused: no site is added later by surprise, if the access comes another way.
      await forget();
      done();
      showProblem(problem, NO_ACCESS_PROBLEM, { grant: again });

      return;
    }
    const added = await addSite(endpoint, workspace, origin, cloudSeams());
    if (!added.ok) {
      await forget();
      // Drawn again, with the buttons off until then: on, a second click would add once more while the
      // popup reads the session (raised in review).
      if (added.reason === 'signed-out') {
        await render();

        return;
      }
      done();
      showProblem(problem, t(ADD_PROBLEM[added.reason]));

      return;
    }
    // FRU-453: what was chosen on the screen, before the rule. A refusal stops here: the site is in
    // the workspace, as members only and with no place, and « Turn on » again adds nothing more.
    if (wanted.visibility === 'everyone' || (wanted.place !== undefined && wanted.place !== null)) {
      const set = await setSiteSettings(endpoint, workspace, added.offer.site.id, wanted, cloudSeams());
      if (!set.ok) {
        await forget();
        done();
        showProblem(problem, t(SETTINGS_PROBLEM[set.reason]));

        return;
      }
    }
    try {
      await writeSite(origin, cloudEntry(added.offer));
      // Done here: the background has nothing left to finish.
      await forget();
      await activateOpenTabs(origin);
    } catch (error) {
      await forget();
      // The site is in the workspace now, and the rule is not here: drawn again, the popup shows
      // what is true, the site of the workspace and its « Turn on here » (raised in review).
      console.error('[fruitback] the site was added, and its rule was not stored', error);
      await render();

      return;
    }
    await render();
  })().catch((error: unknown) => {
    void forget();
    done();
    failed(problem)(error);
  });
}

const ADD_PROBLEM: Record<Exclude<AddFailure, 'signed-out'>, string> = {
  forbidden: msg('Your role in this workspace does not let you add a site.'),
  'rate-limited': msg('Too many sites were added in the last hour. Try again later.'),
  unavailable: msg('Fruitback did not answer. Try again.'),
};

/**
 * A rule this extension stored for a site of a workspace, on its own origin: the screen of the
 * switch (07). A wildcard of previews keeps the screen of before, whose words say that it switches
 * every site the rule covers: the switch of 07 is about this tab only.
 */
function isWorkspaceSite({ pattern, site }: ResolvedSite): boolean {
  return site.mode === 'team' && site.mount !== undefined && !isWildcardPattern(pattern);
}

async function siteOfWorkspaceOn(
  origin: string,
  { pattern, site }: ResolvedSite,
  tab: PopupTab | undefined,
  account: Account | undefined,
): Promise<HTMLElement> {
  const workspace = site.mode === 'team' ? (site.mount?.workspace ?? '') : '';
  // A session of a pairing with that worker: the head names its person when no account is held, and
  // the foot says it with its « Log out » (FRU-319). The session of the account is not one: it is
  // the head and the foot of the account, and it logs out on the page of the extension.
  const held = (await sessions.list())[site.endpoint];
  const paired = held === undefined || held.account === true ? undefined : held;
  const person = account ?? (paired === undefined ? undefined : { name: describeIdentity(paired.identity) });
  const problem = element('p', '', 'problem');
  // FRU-296: the panel of the browser, opened in this click (before any `await`: the browser opens it
  // only in a gesture). A browser with no panel shows the list of the widget in the page. « Show all
  // notes in a sidebar », and a click on « fixes to check » or « open notes » (FRU-298).
  const openPanel = (): void =>
    void openPanelOrPage(
      browser as unknown as PanelApis,
      { ...(tab?.id === undefined ? {} : { tabId: tab.id }) },
      async () => (await askTab(tab, 'show-notes')).done,
    ).then((shown) => (shown === 'nothing' ? showProblem(problem, t(NOT_THERE)) : window.close()));
  // FRU-291: the keys of « Leave feedback », as the person set them. None: no line.
  const shortcut = currentShortcut(await browser.commands.getAll().catch(() => []));
  const screen = siteOn(document, {
    origin,
    workspace,
    on: site.enabled,
    visibility: await visibility(origin),
    ...(shortcut === undefined ? {} : { shortcut: keysOfShortcut(shortcut) }),
    ...(person === undefined ? {} : { account: person }),
    ...(paired === undefined || account !== undefined ? {} : { foot: pairedFoot(site.endpoint, paired.identity) }),
    onToggle: (on) => {
      if (!on) {
        void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(problem));

        return;
      }
      const turn = (): void =>
        void turnOn(pattern, { ...site, enabled: true }).then(refused(problem, turn), failed(problem));
      turn();
    },
    // The widget takes over the tab: the popup would stand over the page somebody is about to click.
    // It goes only when the widget did it: otherwise it stays, and says why.
    onLeaveFeedback: () =>
      void askTab(tab, 'leave-feedback').then(({ done, busy }) => {
        if (done) window.close();
        // Said only when the widget is there and said no: no answer is a page that is not ready.
        else showProblem(problem, t(busy === true ? NOT_NOW_WRITING : NOT_THERE));
      }),
    onOpenPanel: openPanel,
    onSettings: openSettings,
  });
  screen.querySelector('.popup-body')?.append(problem, otherCopyLine(tab, site.enabled));
  // An account and a pairing with another worker (FRU-319): the foot is the account's, so the
  // pairing keeps its row and its « Log out » in the body.
  if (paired !== undefined && account !== undefined) {
    screen.querySelector('.popup-body')?.append(pairedRow(site.endpoint, paired.identity));
  }
  // FRU-298: where the notes go, the fixes to check and the open notes of the site, as the worker
  // lists them (FRU-295), added when it answers: the screen does not wait for it, and a worker that
  // does not answer leaves the lines out rather than zeros. Not for a screen that is gone by then.
  if (site.enabled) {
    const screenNow = drawn;
    void offerFor(origin, cloudSeams())
      .catch(() => undefined)
      .then((listed) => {
        if (listed === undefined || screenNow !== drawn) return;
        const { notes, destination, toCheck } = listed.site;
        showSiteFacts(
          screen,
          { workspace, on: site.enabled, onOpenPanel: openPanel },
          {
            ...(destination === undefined ? {} : { destination: destination.label }),
            ...(toCheck === undefined ? {} : { toCheck }),
            ...(notes === undefined ? {} : { open: notes.new + notes.todo + notes.progress }),
          },
        );
      });
  }

  return screen;
}

const NOT_NOW_WRITING = msg('A note is being written on the page. Send it or close it first.');
const NOT_THERE = msg('The page did not answer. Reload it, then try again.');

/** A command to the widget of the tab the popup was opened on (FRU-254). See `tab-command.ts`. */
async function askTab(tab: PopupTab | undefined, command: TabCommand): Promise<TabCommandAnswer> {
  if (tab?.id === undefined) return { done: false };

  return parseAnswer(await browser.tabs.sendMessage(tab.id, tabCommand(command)).catch(() => undefined));
}

/**
 * FRU-397: another copy of Fruitback runs on this page, an old one or an unpacked one. Its rules and
 * its widget are its own, and nothing in this copy can stop them: removing it is the one thing that
 * helps. Empty until the tab answers, and when it says nothing of another copy.
 */
function otherCopyLine(tab: PopupTab | undefined, on: boolean): HTMLElement {
  const line = element('p', '', 'problem');
  if (!on) return line;
  void askTab(tab, 'counts').then(({ otherCopy }) => {
    if (otherCopy === undefined) return;
    const place = import.meta.env.FIREFOX ? 'about:addons' : 'chrome://extensions';
    line.textContent =
      otherCopy.version === undefined
        ? t(OTHER_COPY, { place })
        : t(OTHER_COPY_VERSION, { version: otherCopy.version, place });
  });

  return line;
}

// Reload first (heavy review of #533): a tab open across an update of this extension keeps the page
// script of the version before, which looks like a copy of before until the page is loaded again.
const OTHER_COPY = msg(
  'Another copy of Fruitback runs on this page, or the version of before of this one. Reload the page. If this stays, remove the other copy in {place}.',
);
const OTHER_COPY_VERSION = msg(
  'Another copy of Fruitback ({version}) runs on this page. Reload the page. If this stays, remove that copy in {place}.',
);

/**
 * Why a private-mode site shows no note on a worker that reads `authenticated` (FRU-66), and, in both
 * modes, a rule whose worker is not at its address (FRU-395).
 *
 * The line is empty until the worker answers, and stays empty unless the answer is a `401`. The
 * popup does not wait for it: the switch must not sit behind a worker that is slow.
 */
function readability(site: SiteConfig, pageUrl: string): HTMLElement {
  const line = element('p', '', 'problem');
  if (!site.enabled) return line;

  // FRU-395: in both modes, a worker that is not at the address of the rule. The client is the one
  // the widget reads with, when the rule names one.
  const clientId = site.mode === 'private' ? site.clientId : site.mount?.clientId;
  void probeRead({ endpoint: site.endpoint, clientId }, pageUrl, { fetch: (url, init) => fetch(url, init) }).then(
    (answer) => {
      if (answer === 'not-found') {
        line.append(t(WORKER_NOT_FOUND));

        return;
      }
      if (site.mode !== 'private') return;
      if (answer !== 'wants-a-session' && answer !== 'members-only') return;

      const guide = element('a', t('Which mode can read it'));
      guide.href = MODES_GUIDE;
      guide.target = '_blank';
      guide.rel = 'noreferrer';
      // FRU-330: a site whose notes are « Members only » refuses the notes of private mode too.
      const sentence = answer === 'members-only' ? NOTES_NEED_SESSION : READ_NEEDS_SESSION;
      line.append(`${t(sentence)} `, guide);
    },
  );

  return line;
}

/**
 * Ask for the worker's own origin, which is not the site's.
 *
 * A reviewer grants the **site** they are reviewing; the worker usually lives somewhere else
 * entirely, and nothing had asked for it. The session routes answer a `chrome-extension://` origin
 * with CORS headers that ought to make an unprivileged `fetch` enough — measured against a real
 * worker with a real preflight — but that was measured with `curl`, which does not enforce CORS, and
 * no browser runs on this machine to settle it. So the permission is asked for rather than relied
 * on: granted, the call is privileged and CORS never comes into it. Raised in review, and this is
 * the repository's recurring defect (FRU-25) — correct logic the real caller never reaches.
 *
 * Retained once granted, which is what lets the background refresh and the logout revoke later, with
 * no gesture to ask from.
 */
async function grantWorkerOrigin(endpoint: string): Promise<boolean> {
  return browser.permissions.request({ origins: [matchPatternFor(workerOrigin(endpoint))] });
}

/**
 * The screen for a tab that is a pairing link (FRU-92): the worker it names, and one button.
 *
 * The worker is the page the link is on, so the reviewer reads here what they are about to trust.
 * The person the code was minted for is not known before the code is spent. The worker answers it,
 * and the row then says `Paired as …`: a name read from the link would be the word of whoever
 * wrote the link.
 */
async function linked(link: PairLink): Promise<HTMLElement[]> {
  const held = (await sessions.list())[link.endpoint];
  if (held !== undefined) {
    // FRU-289: paired by this link, just now, is a success; « already paired » is only for a browser
    // that was paired before the link.
    const said = pairedNow.has(link.endpoint) ? LINK_PAIRED : LINK_ALREADY_PAIRED;

    return [pairedRow(link.endpoint, held.identity), element('p', t(said), 'state')];
  }

  const submit = element('button', t('Pair with this worker'));
  const problem = element('p', '', 'problem');
  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(
    element('p', t('This page is a pairing link for {worker}.', { worker: link.endpoint }), 'state'),
    submit,
    problem,
  );

  if (!isSecureWorkerEndpoint(link.endpoint)) {
    submit.disabled = true;
    showProblem(problem, PAIRING_NEEDS_HTTPS);

    return [wrapper];
  }

  const attempt = pairing(link.endpoint, () => link.code, submit, problem, {});
  submit.addEventListener('click', attempt);
  // FRU-302: the same pairing, on the card of the worker in the page of the extension, code filled.
  const page = element('button', t('Pair in the page of the extension'), 'secondary');
  page.addEventListener('click', () => {
    const query = new URLSearchParams({ worker: link.endpoint, code: link.code });
    void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#workers?${query.toString()}` });
    window.close();
  });
  wrapper.append(page);

  return [wrapper];
}

const NOT_A_LINK = msg('This is a site to review');

const LINK_ALREADY_PAIRED = msg('This browser is already paired with that worker, so the link is not needed.');

const LINK_PAIRED = msg('Paired. This browser reads and writes the notes of this worker.');

/** The workers this popup paired with, while it is open: the screen after a pairing says it is done. */
const pairedNow = new Set<string>();

/**
 * Who this browser is paired as with a worker, and the way out. With no name, « Paired » alone and
 * the e-mail under it, in the secondary text (FRU-289), as the card of the page of the extension.
 */
function pairedRow(endpoint: string, identity: SessionIdentity): HTMLElement {
  const out = logOut(endpoint, element('button', t('Log out')));

  const row = document.createElement('div');
  row.className = 'row';
  const name = identity.name?.trim();
  row.append(
    element(
      'span',
      name === undefined || name === '' ? t('Paired') : t('Paired as {identity}', { identity: name }),
      'state',
    ),
    out,
  );

  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(row);
  if ((name === undefined || name === '') && identity.email !== undefined) {
    const email = element('p', identity.email, 'state');
    email.classList.add('identity-email');
    wrapper.append(email);
  }

  return wrapper;
}

/**
 * The foot of screen 3 for a session of a pairing (FRU-319): who it is, once, and « Log out » as a
 * link. The person was written three times there (the head, a row « Paired as » and the foot), and
 * « Log out » was a filled pill of the weight of « Leave feedback ».
 */
function pairedFoot(endpoint: string, identity: SessionIdentity): HTMLElement {
  const foot = element('div', '', 'popup-foot');
  foot.classList.add('popup-foot-account');
  // The rule of the row (FRU-289): « Paired as » a name, never as an address. With no name, « Paired »
  // and the address beside it.
  const name = identity.name?.trim();
  const email = identity.email?.trim();
  let who = t('Paired');
  if (name !== undefined && name !== '') who = t('Paired as {identity}', { identity: name });
  else if (email !== undefined && email !== '') who = `${who} · ${email}`;
  foot.append(
    element('span', who, 'who'),
    logOut(
      endpoint,
      linkButton(document, t('Log out'), () => undefined),
    ),
  );

  return foot;
}

/** Logs out of the session of `endpoint` on a click of `out`, then draws the popup again. */
function logOut<B extends HTMLButtonElement>(endpoint: string, out: B): B {
  out.addEventListener('click', () => {
    out.disabled = true;
    // `logout` revokes on the worker first and clears here whatever that answers. See its comment:
    // a screen that says signed out while this extension still holds a working credential is the
    // one outcome worth avoiding.
    void sessions
      .logout(endpoint)
      // Redrawn whatever it answered, because `logout` clears here whatever the revoke or the
      // epoch write did. Rendering only on success leaves the row saying paired over storage that
      // holds nothing, with a dead button. And a click is fire-and-forget, so a failure nobody
      // logs here is logged nowhere at all. Raised in review.
      .catch((error: unknown) => console.error('[fruitback] the log out did not finish', error))
      // FRU-115: the session was what the access to the worker was for. It stays when a site that is
      // switched on uses that worker, and when the log out left the session in storage.
      .then(() => returnAccess([workerOrigin(endpoint)]))
      .catch((error: unknown) => console.error('[fruitback] could not give back the access to the worker', error))
      .then(() => {
        // The account of that session spoke for the language. Ask who is left to speak for it.
        void rememberLanguage(browser.storage.local, cloudSeams()).catch(() => undefined);

        return render();
      });
  });

  return out;
}

/**
 * One attempt to pair, from the button or from the remedy under a failed one (FRU-90).
 *
 * Both are clicks, and that is the point: the attempt asks for a permission first, and a remedy
 * that ran outside a click would ask for it with no gesture and get no prompt.
 *
 * `change` opens the fields of the rule. A pairing link has no rule, so it passes none.
 */
function pairing(
  endpoint: string,
  code: () => string,
  submit: HTMLButtonElement,
  problem: HTMLElement,
  { change }: { change?: () => void },
): () => void {
  const attempt = (): void => {
    const value = code().trim();
    showProblem(problem, value === '' ? PAIRING_CODE_REQUIRED : '');
    if (value === '') return;

    // A code is spendable once. A second click while the first is in flight would spend it, then be
    // told by the worker that it is spent — a success reported as a failure. Same rule as the
    // widget's send button.
    submit.disabled = true;

    void (async () => {
      // The permission request is first and nothing is awaited before it, because a host permission
      // may only be asked for while a user gesture is being handled. Same rule as `turnOn`, for the
      // same reason and the same trap: one storage read in front of it and no prompt ever appears.
      const granted = await grantWorkerOrigin(endpoint);
      const result = granted ? await sessions.pair(endpoint, value) : undefined;
      if (result?.ok === true) {
        pairedNow.add(endpoint);
        void render();

        return;
      }

      submit.disabled = false;
      showProblem(problem, PAIRING_PROBLEM[result === undefined ? 'blocked' : result.reason], {
        retry: attempt,
        grant: attempt,
        ...(change === undefined ? {} : { change }),
      });
    })();
  };

  return attempt;
}

/**
 * Paste a code, see who you are, log out (FRU-60).
 *
 * Deliberately thin: everything it decides lives in `src/session.ts`, where `node --test` can reach
 * it. What is here is four elements and the two strings a person reads.
 */
async function session(site: SiteConfig): Promise<HTMLElement[]> {
  const endpoint = site.endpoint;
  const held = (await sessions.list())[endpoint];
  // Private mode carries no session, so it offers no pairing (FRU-88). A session that this worker
  // already holds stays on the screen, with its log out.
  if (held === undefined && site.mode !== 'team') return [];
  if (held !== undefined) return [pairedRow(endpoint, held.identity)];

  const code = field(t('Pairing code'), 'ABCD-EFGH-JKMN');
  const submit = element('button', t('Pair with this worker'));
  const problem = element('p', '', 'problem');

  // The worker this rule names is what is wrong, so the way out is the fields of the rule.
  const change = (): void => void render(true);

  // Pairing spends a code and is handed a refresh token — thirty days of access — so it does not
  // happen over plain http. Loopback excepted: that is the dev loop. Raised in review.
  if (!isSecureWorkerEndpoint(endpoint)) {
    submit.disabled = true;
    showProblem(problem, PAIRING_NEEDS_HTTPS, { change });
  }

  submit.addEventListener(
    'click',
    pairing(endpoint, () => code.input.value, submit, problem, { change }),
  );

  // A link pairs with no code to copy (FRU-92), so the field is one step away: it is what a
  // reviewer uses when the link did not reach them, or when the operator read a code out.
  const typed = document.createElement('div');
  typed.hidden = isSecureWorkerEndpoint(endpoint);
  typed.append(code.label, submit, problem);

  const reveal = element('button', t('I have a code'), 'secondary');
  reveal.hidden = typed.hidden === false;
  reveal.setAttribute('aria-expanded', 'false');
  reveal.addEventListener('click', () => {
    typed.hidden = false;
    reveal.hidden = true;
    reveal.setAttribute('aria-expanded', 'true');
    code.input.focus();
  });

  const row = document.createElement('div');
  row.className = 'row';
  // Said plainly, because it is the difference between a page that shows this reviewer's pins and
  // one that shows nothing at all: the relay refuses a call it has no session for, rather than
  // making it without one.
  row.append(element('span', t('Not paired — this site cannot reach the worker until you do'), 'state'));

  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(row, element('p', t(HOW_TO_PAIR), 'state'), reveal, typed);

  return [wrapper];
}

const HOW_TO_PAIR = msg('Open the pairing link you were sent, then click this icon on that page.');

/**
 * Ask for the mode, and for what that mode cannot work without.
 *
 * The client id is asked for in private mode only. In team mode the site embeds its own widget and
 * declares its own client id, and a second one stored here would be a value nothing reads.
 */
function form(origin: string, found?: ResolvedSite, draft?: SiteConfig): HTMLElement {
  const site = found?.site;
  // The fields show the entry, or what was typed for a site that has none yet.
  const shown = site ?? draft;
  // A wildcard entry is saved under its own pattern, so the change reaches every site it covers.
  const pattern = found?.pattern ?? origin;
  const mode = modeField(shown?.mode ?? 'private');
  const endpoint = field(t('Worker endpoint'), 'https://feedback.acme.dev');
  const clientId = field(t('Client id'), 'acme');
  const save = element('button', site === undefined ? t('Turn on for this site') : t('Save'));
  const problem = element('p', '', 'problem');

  endpoint.input.value = shown?.endpoint ?? '';
  clientId.input.value = shown !== undefined && shown.mode === 'private' ? shown.clientId : '';

  const showFields = (): void => {
    clientId.label.hidden = mode.select.value === 'team';
  };
  mode.select.addEventListener('change', showFields);
  showFields();

  save.addEventListener('click', () => {
    const values = {
      mode: mode.select.value === 'team' ? ('team' as const) : ('private' as const),
      endpoint: endpoint.input.value.trim(),
      clientId: clientId.input.value.trim(),
    };

    // Said out loud rather than refused in silence. The bridge applies the same rule before it
    // mounts, so an endpoint that fails here would have been stored, shown as **On**, and then
    // ignored by a page that reported nothing — which reads as a broken extension. Raised in review.
    const wrong = complaint(values, pattern);
    // FRU-395: a pairing link where the worker goes. Its pairing is on the page of the extension.
    const link = pairingLinkIn(values.endpoint);
    showProblem(problem, wrong, {
      ...(link === undefined
        ? {}
        : {
            pair: () => {
              void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}${pairingFragment(link)}` });
              window.close();
            },
          }),
    });
    if (wrong !== '') return;

    // `enabled` is kept: changing the endpoint of a site that is switched off must not switch it on.
    const formed = siteFrom(values, site?.enabled ?? true);
    // The form knows two modes and no mount (FRU-101). Saving a site of a workspace with its endpoint
    // unchanged keeps the widget the extension mounts there, which the form cannot show.
    const next: SiteConfig =
      formed.mode === 'team' && site?.mode === 'team' && site.mount !== undefined && formed.endpoint === site.endpoint
        ? { ...formed, mount: site.mount }
        : formed;

    // And a site that stays off must not ask for access or run anything. `turnOn` requests the host
    // permission and injects both scripts into the open tab, neither of which belongs to saving an
    // entry nobody has switched on. Raised in review.
    if (!next.enabled) {
      void writeSite(pattern, next).then(() => render(), failed(problem));

      return;
    }

    const turn = (): void => void turnOn(pattern, next).then(refused(problem, turn), failed(problem));
    turn();
  });

  const wrapper = document.createElement('div');
  wrapper.append(mode.label, endpoint.label, clientId.label, save, problem);

  return wrapper;
}

/** The tabs already open on a pattern get both scripts. */
function activateOpenTabs(pattern: string): Promise<void> {
  return injectIntoOpenTabs(browserTabScripting, pattern);
}

/**
 * Ask for this pattern, then store it. For a wildcard, the browser asks for every site it covers.
 *
 * **The request has to come first, and it has to come from this click.** A host permission may only
 * be asked for while a user gesture is being handled, so anything awaited before it — a storage read
 * — loses the gesture and the prompt never appears. And storing first would leave an entry that says
 * "on" for a site the background can never register, which reads as a broken extension.
 *
 * Answers whether access was granted, so a refusal is said on the screen.
 */
async function turnOn(pattern: string, site: SiteConfig): Promise<boolean> {
  // WARNING: not awaited. An await before `permissions.request` loses the gesture, and the prompt
  // can close this popup: the background then finishes what is remembered here.
  void pending.remember(pattern, site).catch(() => undefined);
  const granted = await browser.permissions.request({ origins: [matchPatternFor(pattern)] });
  // A refusal keeps the values as a draft, so the form shows them again (FRU-117).
  if (!granted) return false;

  try {
    await writeSite(pattern, site);
  } catch (error) {
    // A write the background did not confirm can be stored anyway, and this tab would then hold no
    // widget until its next load (FRU-73). `failed` still says the change was not confirmed.
    await activateStored([pattern], readAll, activateOpenTabs);
    throw error;
  }
  // `registerContentScripts` only reaches future page loads. Every tab already open on the pattern
  // gets the scripts now, this one included, and both files refuse to run twice in one frame.
  await pending.forget().catch(() => undefined);
  await activateOpenTabs(pattern);
  await render();

  return true;
}

/**
 * « Show Fruitback on this page » (FRU-444). Hidden, the bridge of each tab of the origin posts
 * `unmount` and the background leaves the origin out of the scripts. Shown again, the tabs that
 * loaded while it was hidden get the scripts now, as a site turned on does.
 */
async function visibility(origin: string): Promise<{ shown: boolean; onChange: (shown: boolean) => void }> {
  const shown = !(await isHidden(browser.storage.local, origin));

  return {
    shown,
    onChange: (next) =>
      void setHidden(browser.storage.local, origin, !next)
        .then(() => (next ? activateOpenTabs(origin) : undefined))
        .then(
          () => render(),
          (error: unknown) => console.error('[fruitback] could not show or hide the widget on this page', error),
        ),
  };
}

/** Configured: the switch, and what it is switching. */
function status({ pattern, site }: ResolvedSite, shown?: Awaited<ReturnType<typeof visibility>>): HTMLElement {
  // A wildcard entry switches every site it covers, so the button must not say "here".
  const wide = isWildcardPattern(pattern);
  const off = wide ? t('Turn off for every site this rule covers') : t('Turn off here');
  const on = wide ? t('Turn on for every site this rule covers') : t('Turn on here');
  const toggle = element('button', site.enabled ? off : on);
  const problem = element('p', '', 'problem');
  toggle.addEventListener('click', () => {
    if (site.enabled) {
      void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(problem));

      return;
    }

    const turn = (): void =>
      void turnOn(pattern, { ...site, enabled: true }).then(refused(problem, turn), failed(problem));
    turn();
  });

  const change = element('button', t('Change'));
  change.className = 'secondary';
  change.addEventListener('click', () => void render(true));

  // The sentence of a rule that covers many sites is longer than the popup: that button may wrap.
  if (wide) toggle.classList.add('long');
  const buttons = actions(change, toggle);

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', `${site.enabled ? t('On') : t('Off')} · ${describeSite(site)}`, 'state'), buttons);

  const wrapper = document.createElement('div');
  wrapper.append(row);
  if (site.enabled && shown !== undefined) wrapper.append(visibilityRow(document, shown));
  wrapper.append(problem);

  return wrapper;
}

/**
 * A turn-on the reviewer refused: nothing was stored, and the screen says why.
 *
 * `again` is the same turn-on. It runs in the click of the remedy, so the browser asks again.
 */
function refused(problem: HTMLElement, again: () => void): (granted: boolean) => void {
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
function failed(problem: HTMLElement): (error: unknown) => void {
  return (error) => {
    console.error('[fruitback] a site change was not confirmed', error);
    // The list is on the options page, and it says what storage holds now.
    showProblem(problem, STORE_PROBLEM, { list: () => void browser.runtime.openOptionsPage() });
  };
}

/** What this entry is switching, in one phrase: a client id in private mode, the mode in team. */
function describeSite(site: SiteConfig): string {
  if (site.mode === 'private') return site.clientId;
  if (site.mount !== undefined) {
    return t('workspace · {name}', { name: site.mount.workspace ?? site.mount.clientId });
  }

  return t("team mode · the site's own widget");
}

function modeField(current: SiteMode): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const select = document.createElement('select');
  for (const [value, text] of [
    ['private', 'Private · the extension mounts the widget'],
    ['team', 'Team · the site embeds it, we relay'],
  ]) {
    const option = document.createElement('option');
    option.value = value as string;
    // The label stays English in the list above: the guide is checked against it.
    option.textContent = t(text as string);
    select.append(option);
  }

  select.value = current;

  const wrapper = document.createElement('label');
  wrapper.append(t('Mode'), select);

  return { label: wrapper, select };
}

function field(label: string, placeholder: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;

  const wrapper = document.createElement('label');
  wrapper.append(label, input);

  return { label: wrapper, input };
}

/** Buttons side by side, with a space between them, that go under each other when the room is short (FRU-169). */
function actions(...buttons: HTMLElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'actions';
  group.append(...buttons);

  return group;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) node.className = className;

  return node;
}

type PopupTab = { id?: number; url?: string };

async function currentTab(): Promise<PopupTab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  return tab;
}

/**
 * The origin, or nothing when the widget could not run there anyway.
 *
 * Restricted to the two schemes a content script is allowed on, so the popup never offers a switch
 * for a page the extension cannot reach.
 */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;

  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
