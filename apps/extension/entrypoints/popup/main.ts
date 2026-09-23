import { browser } from 'wxt/browser';
import { isSecureWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored } from '../../src/site-editor.ts';
import { complaint, siteFrom } from '../../src/site-form.ts';
import { type ResolvedSite, isWildcardPattern } from '../../src/site-patterns.ts';
import { type SiteConfig, type SiteMode, findSite, readAll, writeSite } from '../../src/sites.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { browserTabScripting } from '../../src/tab-scripting-browser.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { type PairFailure, describeIdentity } from '../../src/session.ts';

/**
 * The switch for the tab you are looking at, and the two fields that make it work (SKG-534).
 *
 * Deliberately not the editor for every site: that is the options page (SKG-536). This is the one
 * question a reviewer asks from the toolbar: is Fruitback on here, which rule says so, and against
 * which worker.
 *
 * There is no framework in this popup on purpose. It is four elements, it opens and closes in under
 * a second, and a bundle for it would be larger than everything it renders.
 */

/**
 * One for the whole popup, not one per render.
 *
 * Building it runs the upgrade to one key per endpoint (SKG-602), and `render` runs again after
 * every pairing, logout and site change. Two of these also hold separate in-flight refresh maps, so
 * they can each spend the same refresh token.
 */
const sessions = createBrowserSessions();

const app = document.querySelector('#app');

void render();

/**
 * @param editing Show the fields for an origin that already has an entry.
 *
 * Without it there is no way to change one. An entry is written once and then only switched on and
 * off, so an origin turned on before SKG-596 could never be moved to team mode — which is every
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
    app.textContent = 'Fruitback works on http and https pages.';

    return;
  }

  const found = await findSite(origin);
  const open = found === undefined || editing;

  app.replaceChildren(
    element('h1', 'Fruitback'),
    element('p', origin, 'origin'),
    // SKG-536: why the widget does or does not appear here must be answerable from the toolbar.
    element('p', found === undefined ? NO_RULE : `Rule: ${found.pattern}`, 'rule'),
    open || found === undefined ? form(origin, found) : status(found),
  );

  // Pairing is against the **worker**, not the site, so there is nothing to ask for until one is
  // named. A reviewer holds one session per worker however many of its sites they have turned on.
  if (found !== undefined && !open) app.append(await session(found.site));

  app.append(optionsButton());
}

const NO_RULE = 'No rule covers this origin, so Fruitback does nothing here.';

/** Every entry, wildcards and the rules file included, on the options page (SKG-536). */
function optionsButton(): HTMLElement {
  const button = element('button', 'All sites and rules', 'secondary');
  button.addEventListener('click', () => void browser.runtime.openOptionsPage());

  return button;
}

/** What a failed pairing is, in the reporter's words. */
const PAIRING_PROBLEM: Record<PairFailure | 'blocked', string> = {
  'code-spent-or-expired': 'That code has been used or has expired. Ask for a new one.',
  unavailable: 'The worker did not answer. Try again.',
  'insecure-endpoint': 'That worker is on plain http. A session must not cross it.',
  blocked: 'Fruitback needs permission to reach that worker.',
};

/**
 * Ask for the worker's own origin, which is not the site's.
 *
 * A reviewer grants the **site** they are reviewing; the worker usually lives somewhere else
 * entirely, and nothing had asked for it. The session routes answer a `chrome-extension://` origin
 * with CORS headers that ought to make an unprivileged `fetch` enough — measured against a real
 * worker with a real preflight — but that was measured with `curl`, which does not enforce CORS, and
 * no browser runs on this machine to settle it. So the permission is asked for rather than relied
 * on: granted, the call is privileged and CORS never comes into it. Raised in review, and this is
 * the repository's recurring defect (SKG-518) — correct logic the real caller never reaches.
 *
 * Retained once granted, which is what lets the background refresh and the logout revoke later, with
 * no gesture to ask from.
 */
async function grantWorkerOrigin(endpoint: string): Promise<boolean> {
  return browser.permissions.request({ origins: [matchPatternFor(workerOrigin(endpoint))] });
}

/**
 * Paste a code, see who you are, log out (SKG-599).
 *
 * Deliberately thin: everything it decides lives in `src/session.ts`, where `node --test` can reach
 * it. What is here is four elements and the two strings a person reads.
 */
async function session(site: SiteConfig): Promise<HTMLElement> {
  const endpoint = site.endpoint;
  const held = (await sessions.list())[endpoint];
  const wrapper = document.createElement('div');
  wrapper.className = 'session';

  if (held !== undefined) {
    const out = element('button', 'Log out');
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
        .then(() => render());
    });

    const row = document.createElement('div');
    row.className = 'row';
    row.append(element('span', `Paired as ${describeIdentity(held.identity)}`, 'state'), out);
    wrapper.append(row);

    return wrapper;
  }

  const code = field('Pairing code', 'ABCD-EFGH-JKMN');
  const submit = element('button', 'Pair with this worker');
  const problem = element('p', '', 'problem');

  // Pairing spends a code and is handed a refresh token — thirty days of access — so it does not
  // happen over plain http. Loopback excepted: that is the dev loop. Raised in review.
  if (!isSecureWorkerEndpoint(endpoint)) {
    submit.disabled = true;
    problem.textContent = 'Pairing needs https (localhost excepted): a session must not cross http.';
  }

  submit.addEventListener('click', () => {
    const value = code.input.value.trim();
    problem.textContent = value === '' ? 'The pairing code is required.' : '';
    if (problem.textContent !== '') return;

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
      problem.textContent = PAIRING_PROBLEM[result === undefined ? 'blocked' : result.reason];
    })();
  });

  const row = document.createElement('div');
  row.className = 'row';
  // Said plainly in team mode, because there it is the difference between a page that shows this
  // reviewer's pins and one that shows nothing at all: the relay refuses a call it has no session
  // for, rather than making it without one.
  const unpaired =
    site.mode === 'team'
      ? 'Not paired — this site cannot reach the worker until you do'
      : 'Not paired with this worker';
  row.append(element('span', unpaired, 'state'));
  wrapper.append(row, code.label, submit, problem);

  return wrapper;
}

/**
 * Ask for the mode, and for what that mode cannot work without.
 *
 * The client id is asked for in private mode only. In team mode the site embeds its own widget and
 * declares its own client id, and a second one stored here would be a value nothing reads.
 */
function form(origin: string, found?: ResolvedSite): HTMLElement {
  const site = found?.site;
  // A wildcard entry is saved under its own pattern, so the change reaches every site it covers.
  const pattern = found?.pattern ?? origin;
  const mode = modeField(site?.mode ?? 'private');
  const endpoint = field('Worker endpoint', 'https://feedback.acme.dev');
  const clientId = field('Client id', 'acme');
  const save = element('button', site === undefined ? 'Turn on for this site' : 'Save');
  const problem = element('p', '', 'problem');

  endpoint.input.value = site?.endpoint ?? '';
  clientId.input.value = site !== undefined && site.mode === 'private' ? site.clientId : '';

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
    problem.textContent = complaint(values);
    if (problem.textContent !== '') return;

    // `enabled` is kept: changing the endpoint of a site that is switched off must not switch it on.
    const next = siteFrom(values, site?.enabled ?? true);

    // And a site that stays off must not ask for access or run anything. `turnOn` requests the host
    // permission and injects both scripts into the open tab, neither of which belongs to saving an
    // entry nobody has switched on. Raised in review.
    if (!next.enabled) {
      void writeSite(pattern, next).then(() => render(), failed(problem));

      return;
    }

    void turnOn(pattern, next).then(refused(problem), failed(problem));
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
  const granted = await browser.permissions.request({ origins: [matchPatternFor(pattern)] });
  if (!granted) return false;

  try {
    await writeSite(pattern, site);
  } catch (error) {
    // A write the background did not confirm can be stored anyway, and this tab would then hold no
    // widget until its next load (SKG-612). `failed` still says the change was not confirmed.
    await activateStored([pattern], readAll, activateOpenTabs);
    throw error;
  }
  // `registerContentScripts` only reaches future page loads. Every tab already open on the pattern
  // gets the scripts now, this one included, and both files refuse to run twice in one frame.
  await activateOpenTabs(pattern);
  await render();

  return true;
}

/** Configured: the switch, and what it is switching. */
function status({ pattern, site }: ResolvedSite): HTMLElement {
  // A wildcard entry switches every site it covers, so the button must not say "here".
  const wide = isWildcardPattern(pattern);
  const off = wide ? 'Turn off for every site this rule covers' : 'Turn off here';
  const on = wide ? 'Turn on for every site this rule covers' : 'Turn on here';
  const toggle = element('button', site.enabled ? off : on);
  const problem = element('p', '', 'problem');
  toggle.addEventListener('click', () => {
    if (site.enabled) {
      void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(problem));

      return;
    }

    void turnOn(pattern, { ...site, enabled: true }).then(refused(problem), failed(problem));
  });

  const change = element('button', 'Change');
  change.className = 'secondary';
  change.addEventListener('click', () => void render(true));

  const buttons = document.createElement('span');
  buttons.append(change, toggle);

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', `${site.enabled ? 'On' : 'Off'} · ${describeSite(site)}`, 'state'), buttons);

  const wrapper = document.createElement('div');
  wrapper.append(row, problem);

  return wrapper;
}

/** A turn-on the reviewer refused: nothing was stored, and the screen says why. */
function refused(problem: HTMLElement): (granted: boolean) => void {
  return (granted) => {
    if (!granted) problem.textContent = NO_ACCESS_PROBLEM;
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
    problem.textContent = STORE_PROBLEM;
  };
}

/** What this entry is switching, in one phrase: a client id in private mode, the mode in team. */
function describeSite(site: SiteConfig): string {
  return site.mode === 'team' ? "team mode · the site's own widget" : site.clientId;
}

function modeField(current: SiteMode): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const select = document.createElement('select');
  for (const [value, text] of [
    ['private', 'Private · the extension mounts the widget'],
    ['team', 'Team · the site embeds it, we relay'],
  ]) {
    const option = document.createElement('option');
    option.value = value as string;
    option.textContent = text as string;
    select.append(option);
  }

  select.value = current;

  const wrapper = document.createElement('label');
  wrapper.append('Mode', select);

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
