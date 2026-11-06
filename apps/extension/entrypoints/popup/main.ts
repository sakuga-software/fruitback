import { browser } from 'wxt/browser';
import { type ResolvedSite } from '../../src/site-patterns.ts';
import { findSite } from '../../src/sites.ts';
import { currentShortcut } from '../../src/shortcut.ts';
import { type PairLink, parsePairLink } from '../../src/pair-link.ts';
import { type Offer, offerFor } from '../../src/cloud.ts';
import { language, msg, setLanguage, t } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { rememberLanguage } from '../../src/language-sync.ts';
import { type ConnectState, type PendingConnect, pollConnect } from '../../src/connect.ts';
import { type PopupState, decide } from '../../src/popup-state.ts';
import { showUpdateLine } from '../../src/update-notice-browser.ts';
import { followActionColor } from '../../src/action-color-browser.ts';
import { keepInPopup } from '../../src/update-notice.ts';
import {
  type Account,
  keysOfShortcut,
  connecting,
  loading,
  notAWebPage,
  shell,
  signInStop,
  signedOut,
} from '../../src/popup-view.ts';
import { make } from '../../src/kit.ts';

import { isWorkspaceSite, offered, siteOfNoWorkspace, siteOfWorkspaceOn } from './cloud-screens.ts';
import { NO_RULE, form, readability, siteWithoutAccess, status } from './rule-screens.ts';
import { linked, session } from './pairing.ts';
import { holdsAccess, otherCopyLine, visibility, wantsSession } from './site-actions.ts';
import { accountOf, accountShown, signIn, unreachableScreen } from './sign-in.ts';
import {
  actions,
  app,
  drawWith,
  claims,
  CLOUD,
  cloudSeams,
  connect,
  draws,
  openSettings,
  pending,
  type PopupTab,
  render,
  sessions,
  title,
} from './context.ts';

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
 * The tab the popup was opened on, read once. Every screen is about that page, including the ones
 * drawn after « Sign in to Fruitback » opened the console in another tab: asked again, the active
 * tab would be the console's.
 */
const tabUnderThePopup = currentTab();

// The screens draw the popup again through `render` of `context.ts`: this is what it draws.
drawWith(renderPopup);

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

// FRU-601: « Leave a note » in the colour of « Appearance ».
followActionColor(document);

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
// FRU-519: « Fruitback 0.6.0 is out », above the foot of every screen. Each draw puts a new shell in
// `#app`, so the line goes back into each one.
void spoken.then(() =>
  showUpdateLine((line) => {
    if (app !== null) keepInPopup(app, line);
  }),
);
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
    if (finished !== draws.drawn || KEEP.has(shownKind) || typing()) return;
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
async function renderPopup(editing = false, claimedNow?: ConnectState): Promise<void> {
  if (app === null) return;
  claims.stop();
  draws.drawn += 1;
  const thisDraw = draws.drawn;

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
  if (thisDraw === draws.drawn) {
    finished = thisDraw;
    markFirstDrawn();
  }
  // The screen is drawn again only when the answer changes: the same screen drawn every few seconds
  // would take the focus off « Start again » and read the status out again each time.
  if (state.kind === 'connecting' && pendingNow !== undefined) {
    claims.wait(pendingNow, state.unanswered, (now) => void render(false, now));
  }
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
    case 'not-web': {
      // A `chrome://` page, the store, a PDF viewer. Nothing is wrong: the screen says why nothing
      // runs here, and the keys the person set (FRU-526).
      const shortcut = currentShortcut(await browser.commands.getAll().catch(() => []));

      return notAWebPage(document, {
        onSettings: openSettings,
        ...(account === undefined ? {} : { account }),
        ...(shortcut === undefined ? {} : { shortcut: keysOfShortcut(shortcut) }),
      });
    }

    case 'pair-link': {
      // A pairing link is about a worker, not about a site to review, so it gets a screen of its own:
      // the form to switch this origin on would be the wrong question on a worker's own page.
      // An address of this shape is not proof of a worker: a page of a site to review can end in
      // `/pair` with a fragment that looks like a code. The way to the site's own screen stays open.
      const site = make(document, 'button', 'secondary', t(NOT_A_LINK));
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
        make(
          document,
          'p',
          'rule',
          found === undefined ? t(NO_RULE) : t('Rule: {pattern}', { pattern: found.pattern }),
        ),
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

const NOT_A_LINK = msg('This is a site to review');

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
