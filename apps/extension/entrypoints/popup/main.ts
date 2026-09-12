import { browser } from 'wxt/browser';
import { isWorkerEndpoint, normalizeWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import { BRIDGE_FILE, PAGE_FILE, matchPatternFor, publicPath } from '../../src/registration.ts';
import { type SiteConfig, type SiteMode, readSite, writeSite } from '../../src/sites.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { type PairFailure, describeIdentity } from '../../src/session.ts';

/**
 * The switch for the tab you are looking at, and the two fields that make it work (SKG-534).
 *
 * Deliberately not the editor for every site — that is SKG-536, which owns the options page. This is
 * the one question a reviewer asks from the toolbar: is Fruitback on here, and against which worker.
 *
 * There is no framework in this popup on purpose. It is four elements, it opens and closes in under
 * a second, and a bundle for it would be larger than everything it renders.
 */

const app = document.querySelector('#app');

void render();

async function render(): Promise<void> {
  if (app === null) return;

  const tab = await currentTab();
  const origin = originOf(tab?.url);

  if (origin === undefined) {
    // A `chrome://` page, the store, a PDF viewer. Nothing is wrong, and saying so is better than an
    // enabled-looking switch that silently does nothing.
    app.textContent = 'Fruitback works on http and https pages.';

    return;
  }

  const site = await readSite(origin);

  app.replaceChildren(
    element('h1', 'Fruitback'),
    element('p', origin, 'origin'),
    site === undefined ? form(origin) : status(origin, site),
  );

  // Pairing is against the **worker**, not the site, so there is nothing to ask for until one is
  // named. A reviewer holds one session per worker however many of its sites they have turned on.
  if (site !== undefined) app.append(await session(site));
}

/** What a failed pairing is, in the reporter's words. */
const PAIRING_PROBLEM: Record<PairFailure | 'blocked', string> = {
  'code-spent-or-expired': 'That code has been used or has expired. Ask for a new one.',
  unavailable: 'The worker did not answer. Try again.',
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
  const sessions = createBrowserSessions();
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
      void sessions.logout(endpoint).then(render);
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
 * No entry yet: ask for the mode, and for what that mode cannot work without.
 *
 * The client id is asked for in private mode only. In team mode the site embeds its own widget and
 * declares its own client id, and a second one stored here would be a value nothing reads.
 */
function form(origin: string): HTMLElement {
  const mode = modeField();
  const endpoint = field('Worker endpoint', 'https://feedback.acme.dev');
  const clientId = field('Client id', 'acme');
  const save = element('button', 'Turn on for this site');
  const problem = element('p', '', 'problem');

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

    void turnOn(origin, siteFrom(values));
  });

  const wrapper = document.createElement('div');
  wrapper.append(mode.label, endpoint.label, clientId.label, save, problem);

  return wrapper;
}

/** What is wrong with these fields, in the reporter's words, or nothing. */
export function complaint(values: { mode: SiteMode; endpoint: string; clientId: string }): string {
  if (values.endpoint === '') return 'The worker endpoint is required.';
  if (!isWorkerEndpoint(values.endpoint)) return 'The endpoint must be a full http:// or https:// URL.';
  if (values.mode === 'private' && values.clientId === '') return 'The client id is required.';

  return '';
}

/**
 * The entry these fields describe, switched on.
 *
 * **The endpoint is stored in both modes**, and in team mode it is not what the widget is pointed
 * at — the site does that. It is what the relay checks the site's declaration against, so a page
 * cannot name another worker and be handed this reviewer's token for it. See `src/relay.ts`.
 */
export function siteFrom(values: { mode: SiteMode; endpoint: string; clientId: string }): SiteConfig {
  const endpoint = normalizeWorkerEndpoint(values.endpoint);

  return values.mode === 'team'
    ? { mode: 'team', endpoint, enabled: true }
    : { mode: 'private', endpoint, clientId: values.clientId, enabled: true };
}

/**
 * Ask for this origin, then store it.
 *
 * **The request has to come first, and it has to come from this click.** A host permission may only
 * be asked for while a user gesture is being handled, so anything awaited before it — a storage read
 * — loses the gesture and the prompt never appears. And storing first would leave an entry that says
 * "on" for a site the background can never register, which reads as a broken extension.
 */
async function turnOn(origin: string, site: SiteConfig): Promise<void> {
  const granted = await browser.permissions.request({ origins: [matchPatternFor(origin)] });
  if (!granted) return;

  await writeSite(origin, site);
  await injectIntoCurrentTab();
  await render();
}

/**
 * Put the scripts into the page that is open right now.
 *
 * `registerContentScripts` only reaches **future** page loads, so without this the tab the reviewer
 * is looking at stays bare until they navigate — while the popup says the site is on. That is the
 * gap between a switch and what the switch appears to promise, and it was measured only because a
 * reviewer pointed at it: the browser run that "proved" the no-reload flow had seeded storage before
 * the page loaded, which is not what a person does.
 *
 * Injecting a script that is already running is harmless here — the bridge only listens, and the
 * page world refuses a second mount by destroying the first.
 */
async function injectIntoCurrentTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;

  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [publicPath(PAGE_FILE)], world: 'MAIN' });
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [publicPath(BRIDGE_FILE)] });
  } catch {
    // A page the browser will not let anything be injected into — its own error pages, another
    // extension's. The registration still stands for the next load, so this costs the immediate
    // appearance and nothing else.
  }
}

/** Configured: the switch, and what it is switching. */
function status(origin: string, site: SiteConfig): HTMLElement {
  const toggle = element('button', site.enabled ? 'Turn off here' : 'Turn on here');
  toggle.addEventListener('click', () => {
    if (site.enabled) {
      void writeSite(origin, { ...site, enabled: false }).then(render);

      return;
    }

    void turnOn(origin, { ...site, enabled: true });
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', `${site.enabled ? 'On' : 'Off'} · ${describeSite(site)}`, 'state'), toggle);

  return row;
}

/** What this entry is switching, in one phrase: a client id in private mode, the mode in team. */
function describeSite(site: SiteConfig): string {
  return site.mode === 'team' ? "team mode · the site's own widget" : site.clientId;
}

function modeField(): { label: HTMLLabelElement; select: HTMLSelectElement } {
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
