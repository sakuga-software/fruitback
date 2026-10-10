import { browser } from 'wxt/browser';
import { isSecureWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import { MODES_GUIDE, READ_NEEDS_SESSION, probeRead } from '../../src/read-probe.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored } from '../../src/site-editor.ts';
import { complaint, siteFrom } from '../../src/site-form.ts';
import { type ResolvedSite, isWildcardPattern } from '../../src/site-patterns.ts';
import { type SiteConfig, type SiteMode, findSite, readAll, writeSite } from '../../src/sites.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { browserTabScripting } from '../../src/tab-scripting-browser.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { createBrowserAccessReturn } from '../../src/access-return-browser.ts';
import { describeIdentity } from '../../src/session.ts';
import { showProblem } from '../../src/problem-view.ts';
import { PAIRING_CODE_REQUIRED, PAIRING_NEEDS_HTTPS, PAIRING_PROBLEM } from '../../src/remedy.ts';
import { type PairLink, parsePairLink } from '../../src/pair-link.ts';
import { createBrowserPending } from '../../src/pending-site-browser.ts';
import { type CloudSeams, type Offer, cloudEntry, offerFor } from '../../src/cloud.ts';
import { language, msg, setLanguage, t } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { rememberLanguage } from '../../src/language-sync.ts';

/**
 * The switch for the tab you are looking at, and the two fields that make it work (FRU-41).
 *
 * Deliberately not the editor for every site: that is the options page (FRU-43). This is the one
 * question a reviewer asks from the toolbar: is Fruitback on here, which rule says so, and against
 * which worker.
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
const pending = createBrowserPending(writeSite);

const app = document.querySelector('#app');

/** The language of the account when the extension knows it, the browser's own otherwise. */
const spoken = storedLanguage(browser.storage.local).then((kept) => {
  setLanguage(kept ?? navigator.language);
  document.documentElement.lang = language();
});

void spoken.then(() => render());
// Not awaited, and no draw after it: a draw would lose what somebody types in the form. The next
// popup reads what this one learned.
void rememberLanguage(browser.storage.local, cloudSeams()).catch(() => undefined);

/**
 * @param editing Show the fields for an origin that already has an entry.
 *
 * Without it there is no way to change one. An entry is written once and then only switched on and
 * off, so an origin turned on before FRU-57 could never be moved to team mode — which is every
 * origin a reviewer already uses. The options page edits every entry; this is the path from the
 * toolbar.
 */
async function render(editing = false): Promise<void> {
  if (app === null) return;

  const tab = await currentTab();
  const origin = originOf(tab?.url);

  if (origin === undefined) {
    // A `chrome://` page, the store, a PDF viewer. Nothing is wrong, and saying so is better than an
    // enabled-looking switch that silently does nothing.
    app.textContent = t('Fruitback works on http and https pages.');

    return;
  }

  // A pairing link is about a worker, not about a site to review, so it gets a screen of its own:
  // the form to switch this origin on would be the wrong question on a worker's own page.
  const link = parsePairLink(tab?.url);
  if (link !== undefined && !editing) {
    app.replaceChildren(element('h1', 'Fruitback'), element('p', origin, 'origin'), ...(await linked(link)));
    // An address of this shape is not proof of a worker: a page of a site to review can end in
    // `/pair` with a fragment that looks like a code. The way to the site's own screen stays open.
    const site = element('button', t(NOT_A_LINK), 'secondary');
    site.addEventListener('click', () => void render(true));
    app.append(site, optionsButton());

    return;
  }

  // The prompt closed the popup before it could store the site: finish it now if the background did not.
  await pending.settle().catch(() => undefined);

  const found = await findSite(origin);
  const open = found === undefined || editing;
  // What somebody typed before a prompt they refused, or that closed this popup (FRU-117).
  const draft = found === undefined ? await pending.draft(origin).catch(() => undefined) : undefined;

  // FRU-101: a site of the reviewer's workspace needs no form. One click, and nothing typed.
  const offer = found === undefined && !editing ? await offerFor(origin, cloudSeams()) : undefined;
  if (offer !== undefined) {
    app.replaceChildren(element('h1', 'Fruitback'), element('p', origin, 'origin'), oneClick(offer), optionsButton());

    return;
  }

  app.replaceChildren(
    element('h1', 'Fruitback'),
    element('p', origin, 'origin'),
    // FRU-43: why the widget does or does not appear here must be answerable from the toolbar.
    element('p', found === undefined ? t(NO_RULE) : t('Rule: {pattern}', { pattern: found.pattern }), 'rule'),
    open || found === undefined ? form(origin, found, draft) : status(found),
  );

  // Pairing is against the **worker**, not the site, so there is nothing to ask for until one is
  // named. A reviewer holds one session per worker however many of its sites they have turned on.
  if (found !== undefined && !open) app.append(...(await session(found.site)));
  if (found !== undefined && !open && tab?.url !== undefined) app.append(readability(found.site, tab.url));

  app.append(optionsButton());
}

const NO_RULE = msg('No rule covers this origin, so Fruitback does nothing here.');

/** What `offerFor` needs, bound to the popup's one `Sessions`. */
function cloudSeams(): CloudSeams {
  return {
    endpoints: async () => Object.keys(await sessions.list()),
    ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
  };
}

const IN_WORKSPACE = (name: string): string =>
  name === '' ? t('This site is in your workspace.') : t('This site is in the workspace {name}.', { name });
const TURN_ON_HERE = msg('Turn on Fruitback here');

/**
 * The one click (FRU-101). The browser asks for this site only, and the click is the gesture that
 * permission needs: nothing is awaited before `turnOn` asks.
 */
function oneClick(offer: Offer): HTMLElement {
  const wrapper = document.createElement('div');
  const button = element('button', t(TURN_ON_HERE));
  const problem = element('p', '', 'problem');
  const turn = (): void =>
    void turnOn(offer.site.origin, cloudEntry(offer)).then(refused(problem, turn), failed(problem));
  button.addEventListener('click', turn);
  const byHand = element('button', t('Set up by hand'), 'secondary');
  byHand.addEventListener('click', () => void render(true));
  wrapper.append(element('p', IN_WORKSPACE(offer.workspace.name), 'rule'), button, problem, byHand);

  return wrapper;
}

/**
 * Why a private-mode site shows no note on a worker that reads `authenticated` (FRU-66).
 *
 * The line is empty until the worker answers, and stays empty unless the answer is a `401`. The
 * popup does not wait for it: the switch must not sit behind a worker that is slow.
 */
function readability(site: SiteConfig, pageUrl: string): HTMLElement {
  const line = element('p', '', 'problem');
  if (site.mode !== 'private' || !site.enabled) return line;

  void probeRead(site, pageUrl, { fetch: (url, init) => fetch(url, init) }).then((answer) => {
    if (answer !== 'wants-a-session') return;

    const guide = element('a', t('Which mode can read it'));
    guide.href = MODES_GUIDE;
    guide.target = '_blank';
    guide.rel = 'noreferrer';
    line.append(`${t(READ_NEEDS_SESSION)} `, guide);
  });

  return line;
}

/** Every entry, wildcards and the rules file included, on the options page (FRU-43). */
function optionsButton(): HTMLElement {
  const button = element('button', t('All sites and rules'), 'secondary');
  button.addEventListener('click', () => void browser.runtime.openOptionsPage());

  return button;
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
    return [paired(link.endpoint, describeIdentity(held.identity)), element('p', t(LINK_ALREADY_PAIRED), 'state')];
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

  return [wrapper];
}

const NOT_A_LINK = msg('This is a site to review');

const LINK_ALREADY_PAIRED = msg('This browser is already paired with that worker, so the link is not needed.');

/** Who this browser is paired as with a worker, and the way out. */
function paired(endpoint: string, identity: string): HTMLElement {
  const out = element('button', t('Log out'));
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

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', t('Paired as {identity}', { identity }), 'state'), out);

  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(row);

  return wrapper;
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
  if (held !== undefined) return [paired(endpoint, describeIdentity(held.identity))];

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
    showProblem(problem, wrong);
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

/** Configured: the switch, and what it is switching. */
function status({ pattern, site }: ResolvedSite): HTMLElement {
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

  const buttons = document.createElement('span');
  buttons.append(change, toggle);

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', `${site.enabled ? t('On') : t('Off')} · ${describeSite(site)}`, 'state'), buttons);

  const wrapper = document.createElement('div');
  wrapper.append(row, problem);

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

async function currentTab(): Promise<{ url?: string } | undefined> {
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
