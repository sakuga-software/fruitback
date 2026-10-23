import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored, createEditor, latestOnly } from '../../src/site-editor.ts';
import {
  PREVIEWS_NOT_PROVEN,
  STALE_TEAM_WILDCARD,
  TOO_LARGE_FOR_ACCOUNT,
  pairingFragment,
  pairingLinkIn,
} from '../../src/site-form.ts';
import { lendsSession, parseSitePattern } from '../../src/site-patterns.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { browserTabScripting as scripting } from '../../src/tab-scripting-browser.ts';
import { SYNC_SETTING, fits } from '../../src/site-sync.ts';
import { exportSites, exportedCount, importSites } from '../../src/site-transfer.ts';
import { RULES_FILE, downloadedSummary, shareRules } from '../../src/share-rules.ts';
import {
  type SiteConfig,
  type SiteMode,
  readAll,
  readFreshPreviews,
  removeSite,
  writeSite,
  writeSites,
} from '../../src/sites.ts';
import { type FreshPreviews, touchesPreviews } from '../../src/proven-previews.ts';
import { showProblem } from '../../src/problem-view.ts';
import { IMPORT_PROBLEM } from '../../src/remedy.ts';
import { language, setLanguage, t } from '../../src/i18n.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { type StoredSession, describeIdentity } from '../../src/session.ts';
import {
  type PanelOptions,
  type RuleRow,
  matches,
  menu,
  rulePanel,
  ruleState,
  sitesHead,
  sitesTable,
} from '../../src/site-page.ts';
import { CAPTURE_EVERYWHERE, browserWarning, setCaptureEverywhere } from '../../src/capture-everywhere.ts';
import { holdsRuleAccess, requestRuleAccess } from '../../src/site-grant-browser.ts';
import { storedLanguage } from '../../src/language.ts';
import { CHROMIUM_SHORTCUTS_URL, currentShortcut } from '../../src/shortcut.ts';
import { type Pairing, type WorkerCard, preferencesSection, redrawWorkers } from '../../src/workers-page.ts';
import { isSecureWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import { cloudEndpoint } from '../../src/popup-state.ts';
import { createBrowserAccessReturn } from '../../src/access-return-browser.ts';
import { touchesARefreshToken } from '../../src/session-storage.ts';
import { PAIRING_CODE_REQUIRED, PAIRING_PROBLEM } from '../../src/remedy.ts';
import { NOTES_NAME_KEY, SHOW_SELECTORS_KEY } from '../../src/protocol.ts';
import { PANEL_ON_CLICK_KEY } from '../../src/side-panel.ts';

/**
 * Every site entry, wildcards included, and the rules file a team hands around (FRU-43).
 *
 * What an entry covers is decided in `site-patterns.ts`, what a valid one is in `site-form.ts`, what a
 * button does in `site-editor.ts`, and what a file holds in `site-transfer.ts`. This page builds the
 * elements.
 */

/** What the list shows now. The add form checks for a duplicate here, because a storage read loses the click. */
let current: Record<string, SiteConfig> = {};

/**
 * The controls that read `current`, disabled until the first list is drawn.
 *
 * Before that, `current` is empty: an add would miss an existing rule and replace it, and an export
 * would download a file with no rules.
 */
const needsList: HTMLButtonElement[] = [];

const editor = createEditor({
  // FRU-425: the yes is recorded (`site-grant.ts`).
  request: (pattern) => requestRuleAccess(pattern),
  write: writeSite,
  current: () => current,
  activate: (pattern) => injectIntoOpenTabs(scripting, pattern),
  stored: readAll,
});
const beginRender = latestOnly();

// The language of the account when the extension knows it, the browser's own otherwise. Before the
// first element: every sentence below is written once.
setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

const app = document.querySelector('#app');
/** The table of the rules, drawn again at each change of storage or of a grant. */
const table = document.createElement('div');
table.className = 'sites-table-slot';
/**
 * The panel of a rule, or the form of a new one. Drawn when somebody chooses, and never again by a
 * change of storage: a list drawn again must not clear what somebody is typing.
 */
const panel = document.createElement('div');
panel.className = 'sites-panel-slot';
/** Where a change made from a row reports that it was not confirmed. */
const notice = element('p', '', 'problem');
/** The rule whose panel is open, `add` for the form of a new one, or nothing. */
let chosen: string | undefined;
let filter = '';
/** The rule whose panel is on the page now: `chosen` can name one the list has not read yet. */
let shown: string | undefined;
/** Whether the first list is drawn: until then `current` is empty. */
let listed = false;
/** Whether the page has opened a panel by itself once. */
let opened = false;
let rows: RuleRow[] = [];
/**
 * The rules this page imported, said « imported » on their row and in their panel. Kept in the page
 * only: the stored rule is the same as one typed in, and the browser grants it the same way.
 */
const imported = new Set<string>();
/** Writes the number of rules on the export card, once the page holds the card. */
let setShareCount: (count: number | undefined) => void = () => undefined;
const sessions = createBrowserSessions();
/** The Fruitback of this build, whose session is the account of the person (FRU-238). */
const CLOUD = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);
const returnAccess = createBrowserAccessReturn(sessions);
/** The section « Workers and sessions », drawn again at each change of the rules or of a session. */
const workers = element('div', '', 'workers-slot');
/** A code a pairing link brought here from the popup: `#workers?worker=<endpoint>&code=<code>`. */
let linked = linkedPairing(window.location.hash);
/** The pairing link whose card already took the focus. */
let focusedLink: typeof linked;

if (app !== null) {
  const sites = element('section', '', 'page-section');
  sites.id = 'sites';
  const body = element('div', '', 'sites-body');
  body.append(table, panel);
  sites.append(
    sitesHead(document, {
      filter,
      onFilter: (text) => {
        filter = text;
        drawTable();
      },
      onAdd: () => choose('add'),
    }),
    body,
    notice,
  );
  const share = transfer();
  const prefs = await preferences();
  const content = element('main', '', 'page-content');
  content.append(sites, workers, share, prefs);
  const frame = element('div', '', 'page');
  frame.append(
    menu(document, {
      version: browser.runtime.getManifest().version,
      current: 'sites',
      entries: [
        { id: 'sites', label: t('Sites') },
        { id: 'workers', label: t('Workers and sessions') },
        { id: 'share', label: t('Share rules') },
        { id: 'prefs', label: t('Preferences') },
      ],
    }),
    content,
  );
  app.append(frame);
}

void renderList();
void renderWorkers();
// A pairing link opened from the popup while this page is open changes the fragment only.
window.addEventListener('hashchange', () => {
  linked = linkedPairing(window.location.hash);
  if (linked !== undefined) void renderWorkers();
});
// FRU-302: a session that is made or ends, here or in the popup, redraws the cards of the workers.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.sites !== undefined || touchesARefreshToken(Object.keys(changes)))) {
    void renderWorkers();
  }
});
// Only the table is drawn again, so a change from the popup does not clear what somebody is typing.
browser.storage.onChanged.addListener((changes, area) => {
  const drawn = changes.sites !== undefined || changes[SYNC_SETTING] !== undefined;
  if (area === 'local' && (drawn || touchesPreviews(Object.keys(changes)))) void renderList();
});
browser.permissions.onAdded.addListener(() => void renderList());
browser.permissions.onRemoved.addListener(() => void renderList());

async function renderList(): Promise<void> {
  const isLatest = beginRender();
  const [sites, proven, copied] = await Promise.all([
    readAll(),
    readFreshPreviews(),
    browser.storage.local.get(SYNC_SETTING).then((stored) => stored[SYNC_SETTING] === true),
  ]);
  const patterns = Object.keys(sites)
    .filter((pattern) => parseSitePattern(pattern) === pattern)
    .sort();

  const read: RuleRow[] = [];
  for (const pattern of patterns) {
    const site = sites[pattern];
    if (site !== undefined) read.push(await ruleRow(pattern, site, proven, copied));
  }

  if (!isLatest()) return;
  current = sites;
  rows = read;
  listed = true;
  for (const control of needsList) control.disabled = false;
  setShareCount(rows.length);
  drawTable();
  // The rule of the open panel is gone: its panel goes too. A panel that is open stays as it is.
  if (chosen !== undefined && chosen !== 'add' && sites[chosen] === undefined && shown === chosen) choose(undefined);
  // A rule chosen before the list could read it (the one just added): its panel opens now.
  if (chosen !== undefined && chosen !== 'add' && sites[chosen] !== undefined && shown !== chosen) choose(chosen);
  else refreshState();
  // The first time, the first rule is open, as the mock-up shows it.
  if (chosen === undefined && panel.childElementCount === 0 && rows[0] !== undefined && !opened) {
    opened = true;
    choose(rows[0].pattern);
  }
}

function drawTable(): void {
  const visible = rows.filter((row) => matches(row, filter));
  // The control that has the focus in the table, found again in the table drawn below: a switch
  // pressed from the keyboard keeps the focus on its row (raised in review).
  const focused =
    document.activeElement instanceof HTMLElement && table.contains(document.activeElement)
      ? {
          pattern: document.activeElement.closest('tr')?.dataset.pattern,
          control: document.activeElement.getAttribute('role') === 'switch' ? '[role="switch"]' : 'button.rule-open',
        }
      : undefined;
  if (rows.length === 0) {
    table.replaceChildren(element('p', t('No rules yet. Add one, or turn a site on from the toolbar.'), 'state'));

    return;
  }
  table.replaceChildren(
    sitesTable(document, {
      rows: visible,
      ...(chosen === undefined ? {} : { selected: chosen }),
      onSelect: (pattern) => choose(pattern),
      onToggle: (row, on) =>
        attempt(() =>
          on ? editor.switchOn(row.pattern, row.site) : writeSite(row.pattern, { ...row.site, enabled: false }),
        ),
    }),
  );
  if (visible.length === 0) table.append(element('p', t('No rule matches this filter.'), 'state'));
  if (focused?.pattern !== undefined) {
    const line = [...table.querySelectorAll<HTMLElement>('tr.rule-row')].find(
      (candidate) => candidate.dataset.pattern === focused.pattern,
    );
    line?.querySelector<HTMLElement>(focused.control)?.focus();
  }
}

/**
 * Each choice counts one: the panel of a choice is drawn only if no later choice was made while it
 * read the session (raised in review: A, B, then A again drew A twice).
 */
let choice = 0;

/** Opens the panel of a rule, the form of a new one, or nothing. */
function choose(pattern: string | undefined): void {
  chosen = pattern;
  choice += 1;
  const mine = choice;
  drawTable();
  if (pattern === undefined) {
    shown = undefined;
    panel.replaceChildren();

    return;
  }
  if (pattern === 'add') {
    shown = undefined;
    panel.replaceChildren(addForm());
    panel.querySelector('input')?.focus();

    return;
  }
  const row = rows.find((candidate) => candidate.pattern === pattern);
  // Not read yet (a rule just added): the next list opens it, and what is shown stays until then.
  if (row === undefined) return;
  void pairedAs(row.site).then((name) => {
    if (mine !== choice) return;
    const said = element('p', '', 'problem');
    const aside = rulePanel(document, {
      ...panelOptions(row, name),
      onSave: (fields) =>
        void editor
          .save(row.pattern, fields)
          .then((text) => showProblem(said, text, { list: reloadList, ...pairWith(fields.endpoint) })),
    });
    aside.querySelector('.panel-body')?.append(said);
    shown = pattern;
    panel.replaceChildren(aside);
  });
}

/** What the panel of a rule says and does, read from the rule as the list holds it now. */
function panelOptions(row: RuleRow, name: string | undefined): PanelOptions {
  const now = (): RuleRow => rows.find((candidate) => candidate.pattern === row.pattern) ?? row;

  return {
    row,
    ...(name === undefined ? {} : { pairedAs: name }),
    onGrant: () => attempt(() => grant(row.pattern, now().site)),
    onRemove: () =>
      attempt(async () => {
        await removeSite(row.pattern);
        imported.delete(row.pattern);
        choose(undefined);
      }),
    onSave: () => undefined,
  };
}

/**
 * The open panel says what the browser holds now: its rule was switched in the table, or granted.
 * Only its box of state is put in place: the fields stay as somebody may be typing them (raised in
 * review).
 */
function refreshState(): void {
  const row = rows.find((candidate) => candidate.pattern === shown);
  if (row === undefined || shown !== chosen) return;
  void pairedAs(row.site).then((name) => {
    if (shown !== row.pattern) return;
    panel.querySelector('.panel-state')?.replaceWith(ruleState(document, panelOptions(row, name)));
  });
}

/** The person of the session this browser holds with the worker of a team rule. */
async function pairedAs(site: SiteConfig): Promise<string | undefined> {
  if (site.mode !== 'team') return undefined;
  const session = (await sessions.list().catch(() => ({}) as Record<string, StoredSession>))[site.endpoint];

  return session === undefined ? undefined : describeIdentity(session.identity);
}

async function ruleRow(pattern: string, site: SiteConfig, proven: FreshPreviews, copied: boolean): Promise<RuleRow> {
  // A permission does not travel with an imported rule, and it can be revoked in the browser's own
  // settings. The background registers nothing without it, so the row says so.
  // FRU-425: `<all_urls>` grants no rule (`src/site-grant.ts`).
  const granted = await holdsRuleAccess(pattern);
  // A rule stored before FRU-75, or the previews of a site whose worker does not list them now
  // (FRU-103). It runs nowhere, so the row offers only to remove it, and says which of the two it is.
  const refused = lendsSession(pattern, site, proven);
  const previews = site.mode === 'team' && site.mount !== undefined;

  return {
    pattern,
    site,
    granted,
    ...(refused ? { refused: previews ? PREVIEWS_NOT_PROVEN : STALE_TEAM_WILDCARD } : {}),
    // FRU-264: the background does not send this rule to the account, and the reviewer must know why.
    ...(copied && !fits(pattern, site) ? { tooLarge: TOO_LARGE_FOR_ACCOUNT } : {}),
    ...(imported.has(pattern) ? { imported: true } : {}),
  };
}

/**
 * An enabled rule that just got its grant runs in the tabs already open on it, as a new rule does.
 *
 * Answers whether the grant was given, so a refusal is reported like a failure.
 */
async function grant(pattern: string, site: SiteConfig): Promise<boolean> {
  const granted = await requestRuleAccess(pattern);
  if (granted && site.enabled) await injectIntoOpenTabs(scripting, pattern);

  return granted;
}

/**
 * Runs a row's change and reports what did not happen under the list, with what to do next (FRU-90).
 *
 * A click is fire-and-forget, so a rejection that is not handled here is reported nowhere. A change
 * that asks for access answers `false` when the reviewer refuses it, and that is said too.
 *
 * `change` is a function, so the remedy can run it again in its own click: a change that asks for
 * access needs that click to show the prompt.
 */
function attempt(change: () => Promise<boolean | void>): void {
  showProblem(notice, '');
  change().then(
    (done) => {
      if (done === false) showProblem(notice, NO_ACCESS_PROBLEM, { grant: () => attempt(change) });
    },
    (error: unknown) => {
      console.error('[fruitback] a site change was not confirmed', error);
      showProblem(notice, STORE_PROBLEM, { list: reloadList });
    },
  );
}

/** The list as storage holds it now, which is what a change that was not confirmed leaves in doubt. */
function reloadList(): void {
  void renderList();
}

function addForm(): HTMLElement {
  const sites = field(t('Sites'), 'https://*.staging.acme.dev');
  const mode = modeField();
  const endpoint = field(t('Worker endpoint'), 'https://feedback.acme.dev');
  const clientId = field(t('Client id'), 'acme');
  const submit = (): void => {
    void editor
      .add({
        sites: sites.input.value,
        mode: mode.select.value === 'team' ? 'team' : 'private',
        endpoint: endpoint.input.value.trim(),
        clientId: clientId.input.value.trim(),
      })
      .then((text) => {
        showProblem(problem, text, { grant: submit, list: reloadList, ...pairWith(endpoint.input.value) });
        // Stored: the new rule's panel takes the place of the form. Typed in, it is not « imported ».
        const added = parseSitePattern(sites.input.value);
        if (text === '' && added !== undefined) imported.delete(added);
        if (text === '') choose(added);
      });
  };
  const add = button(t('Add rule'), submit);
  // The form opens at a click, often after the first list: it is ready if that list is drawn.
  add.disabled = !listed;
  if (!listed) needsList.push(add);
  const problem = element('p', '', 'problem');

  const showFields = (): void => {
    clientId.label.hidden = mode.select.value === 'team';
  };
  mode.select.addEventListener('change', showFields);
  showFields();

  const wrapper = element('aside', '', 'rule-panel');
  wrapper.classList.add('add-panel');
  wrapper.setAttribute('aria-label', t('Add a rule'));
  const body = element('div', '', 'panel-body');
  body.append(element('h2', t('Add a rule')), sites.label, mode.label, endpoint.label, clientId.label, add, problem);
  wrapper.append(body);

  return wrapper;
}

/**
 * « Share rules » (FRU-290): « Download » writes the rules the table lists, and a file chosen or
 * dropped on « Import a rules file » is read, stored, and reported in the card.
 */
function transfer(): HTMLElement {
  const share = shareRules(document, {
    onDownload: () => {
      const text = exportSites(current);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = RULES_FILE;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      share.result.classList.remove('problem');
      // The rules the file holds, counted by the rule that writes it, not by reading the file back.
      share.result.textContent = downloadedSummary(exportedCount(current));
    },
    onFile: (file) => void importFile(file, share.result),
  });
  needsList.push(share.download);
  setShareCount = share.setCount;

  return share.section;
}

/** Reads a rules file, stores its rules, and says in the card what happened. */
async function importFile(file: File, result: HTMLElement): Promise<void> {
  showProblem(result, '');
  // A refusal reads as a problem; « Imported … » takes the plain colour back below.
  result.classList.add('problem');
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    console.error('[fruitback] the rules file could not be read', error);
    showProblem(result, IMPORT_PROBLEM['not-json']);

    return;
  }
  const parsed = importSites(text);
  if (!parsed.ok) {
    showProblem(result, IMPORT_PROBLEM[parsed.reason]);

    return;
  }

  try {
    await writeSites(parsed.sites);
  } catch (error) {
    console.error('[fruitback] the import was not confirmed', error);
    showProblem(result, STORE_PROBLEM, { list: reloadList });
    // The entries can be stored anyway, and the tabs open on them would hold no widget until
    // their next load (FRU-73).
    await activateStored(Object.keys(parsed.sites), readAll, (pattern) => injectIntoOpenTabs(scripting, pattern));

    return;
  }
  // The rows say « imported » until the page is closed: the file is why they have no access yet.
  for (const pattern of Object.keys(parsed.sites)) imported.add(pattern);
  void renderList();
  // An imported rule can already hold its grant, from before it was removed. Its open tabs get the
  // scripts now; a tab without a grant is not returned by the query, so it costs nothing.
  for (const [pattern, site] of Object.entries(parsed.sites)) {
    if (site.enabled) await injectIntoOpenTabs(scripting, pattern);
  }
  const count = Object.keys(parsed.sites).length;
  const said = count === 1 ? t('Imported 1 rule.') : t('Imported {count} rules.', { count });
  const skipped =
    parsed.skipped.length > 0
      ? ` ${t('Skipped, because they are not valid: {patterns}.', { patterns: parsed.skipped.join(', ') })}`
      : '';
  result.classList.remove('problem');
  result.textContent = `${said}${skipped}`;
}

function modeField(): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const select = document.createElement('select');
  const modes: [SiteMode, string][] = [
    ['private', 'Private · the extension mounts the widget'],
    ['team', 'Team · the site embeds it, we relay'],
  ];
  for (const [value, text] of modes) {
    const option = document.createElement('option');
    option.value = value;
    // The label stays English in the list above: the guide is checked against it.
    option.textContent = t(text);
    select.append(option);
  }

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

function button(text: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = element('button', text, className);
  node.addEventListener('click', onClick);

  return node;
}

/**
 * FRU-395: a pairing link typed where the worker goes. « Pair with this link » takes it to its
 * worker's card, in « Workers and sessions », with the code filled in.
 */
function pairWith(endpoint: string): { pair?: () => void } {
  const link = pairingLinkIn(endpoint);

  return link === undefined ? {} : { pair: () => void (window.location.hash = pairingFragment(link)) };
}

function linkedPairing(hash: string): { endpoint: string; code: string } | undefined {
  const query = hash.startsWith('#workers?') ? new URLSearchParams(hash.slice('#workers?'.length)) : undefined;
  const endpoint = query?.get('worker');
  const code = query?.get('code');

  return endpoint && code ? { endpoint, code } : undefined;
}

/** What a worker takes: https, plain http of this machine, or nothing. */
function pairingOf(endpoint: string): Pairing {
  if (!isSecureWorkerEndpoint(endpoint)) return 'insecure';

  return endpoint.startsWith('http://') ? 'local' : 'https';
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * One card for each worker a rule names, and for a worker this browser holds a session with and no
 * rule names (the Cloud of an account). Read again at each change: no state of its own.
 */
async function renderWorkers(): Promise<void> {
  const [sites, held] = await Promise.all([
    readAll(),
    sessions.list().catch(() => ({}) as Record<string, StoredSession>),
  ]);
  const counted = new Map<string, number>();
  for (const [pattern, site] of Object.entries(sites)) {
    if (parseSitePattern(pattern) !== pattern) continue;
    counted.set(site.endpoint, (counted.get(site.endpoint) ?? 0) + 1);
  }
  for (const endpoint of Object.keys(held)) if (!counted.has(endpoint)) counted.set(endpoint, 0);
  // The code of a link is spent once its worker holds a session: a log out later does not offer it
  // again (raised in review).
  if (linked !== undefined && held[linked.endpoint] !== undefined) linked = undefined;
  if (linked !== undefined && !counted.has(linked.endpoint)) counted.set(linked.endpoint, 0);
  const cards: WorkerCard[] = [...counted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([endpoint, count]) => {
      const session = held[endpoint];

      return {
        endpoint,
        host: hostOf(endpoint),
        sites: count,
        pairing: pairingOf(endpoint),
        ...(session === undefined
          ? {}
          : {
              session: {
                ...(session.identity.name === undefined ? {} : { name: session.identity.name }),
                ...(session.identity.email === undefined ? {} : { email: session.identity.email }),
              },
            }),
        ...(endpoint === CLOUD ? { account: true } : {}),
        ...(linked?.endpoint === endpoint && session === undefined ? { code: linked.code } : {}),
      };
    });
  const drew = redrawWorkers(document, workers, { cards, onPair: pair, onLogout: logout });
  // The menu counts the workers, as the mock-up does: « Workers and sessions 3 ».
  const entry = document.querySelector('.page-entry[href="#workers"]');
  let menuCount = entry?.querySelector('.page-count') ?? null;
  if (entry !== null && menuCount === null) {
    menuCount = element('span', '', 'page-count');
    entry.append(menuCount);
  }
  if (menuCount !== null) menuCount.textContent = String(cards.length);
  // The card of a pairing link takes the focus when it is drawn for it, not at each later draw.
  if (linked !== undefined && drew && linked !== focusedLink) {
    focusedLink = linked;
    document.querySelector<HTMLElement>(`.worker-card[data-endpoint="${CSS.escape(linked.endpoint)}"] input`)?.focus();
  }
}

/**
 * One attempt to pair, from « Pair » or from the remedy under a failed one (FRU-90). The permission
 * of the worker's origin is asked first, before anything is awaited: a browser shows the prompt only
 * in a gesture. Then the code is spent once: the button waits while it is.
 */
function pair(endpoint: string, code: string, said: HTMLElement, submit: HTMLButtonElement): void {
  const value = code.trim();
  showProblem(said, value === '' ? PAIRING_CODE_REQUIRED : '');
  if (value === '') return;
  submit.disabled = true;
  const again = (): void => pair(endpoint, code, said, submit);
  void (async () => {
    const granted = await browser.permissions.request({ origins: [matchPatternFor(workerOrigin(endpoint))] });
    const result = granted ? await sessions.pair(endpoint, value) : undefined;
    // The button is turned back on first: a card with a button off is not drawn again (`redrawWorkers`).
    submit.disabled = false;
    if (result?.ok === true) {
      // The card says who now (FRU-289): it is drawn again from the session just stored.
      await renderWorkers();

      return;
    }
    // A draw that waited for this pairing, now that it failed: its line below stays if the cards did not change.
    if (workers.dataset.pending === 'true') await renderWorkers();
    showProblem(said, PAIRING_PROBLEM[result === undefined ? 'blocked' : result.reason], {
      retry: again,
      grant: again,
    });
  })();
}

/** Log out: the worker revokes, then this browser forgets, then gives back the access it was for. */
function logout(endpoint: string, out: HTMLButtonElement): void {
  out.disabled = true;
  void sessions
    .logout(endpoint)
    .catch((error: unknown) => console.error('[fruitback] the log out did not finish', error))
    .then(() => returnAccess([workerOrigin(endpoint)]))
    .catch((error: unknown) => console.error('[fruitback] could not give back the access to the worker', error))
    .then(() => {
      out.disabled = false;

      return renderWorkers();
    });
}

/** « Preferences » (FRU-302): the panel on the icon, the name, the shortcut, the copy of the rules. */
async function preferences(): Promise<HTMLElement> {
  const stored = await browser.storage.local.get([
    PANEL_ON_CLICK_KEY,
    NOTES_NAME_KEY,
    SYNC_SETTING,
    SHOW_SELECTORS_KEY,
  ]);
  const shortcut = currentShortcut(await browser.commands.getAll().catch(() => []));
  // Firefox 137 opens its own page. Chromium browsers have one, at an address the extension may open.
  // An older Firefox has neither, so the row says where to look.
  const commands = browser.commands as typeof browser.commands & { openShortcutSettings?: () => Promise<void> };
  let onShortcut: (() => void) | undefined;
  if (typeof commands.openShortcutSettings === 'function') onShortcut = () => void commands.openShortcutSettings?.();
  else if (!import.meta.env.FIREFOX) onShortcut = () => void browser.tabs.create({ url: CHROMIUM_SHORTCUTS_URL });
  const panel = (browser as unknown as { sidePanel?: unknown }).sidePanel !== undefined;
  // FRU-425: `<all_urls>`, asked for here and nowhere else.
  const capturesEverywhere = await browser.permissions
    .contains({ origins: [...CAPTURE_EVERYWHERE.origins] })
    .catch(() => false);

  return preferencesSection(document, {
    // The icon opens the panel only where the browser has one to open (Chrome): no row on Firefox.
    ...(panel ? { panelOnClick: stored[PANEL_ON_CLICK_KEY] === true } : {}),
    onPanelOnClick: (on) => browser.storage.local.set({ [PANEL_ON_CLICK_KEY]: on }),
    name: typeof stored[NOTES_NAME_KEY] === 'string' ? stored[NOTES_NAME_KEY] : '',
    onName: (name) =>
      name === ''
        ? browser.storage.local.remove(NOTES_NAME_KEY)
        : browser.storage.local.set({ [NOTES_NAME_KEY]: name }),
    ...(shortcut === undefined ? {} : { shortcut }),
    ...(onShortcut === undefined ? {} : { onShortcut }),
    synced: stored[SYNC_SETTING] === true,
    onSynced: (on) => browser.storage.local.set({ [SYNC_SETTING]: on }),
    selectors: stored[SHOW_SELECTORS_KEY] === true,
    // Absent is off: turning it off removes the key rather than keeping a `false`.
    onSelectors: (on) =>
      on ? browser.storage.local.set({ [SHOW_SELECTORS_KEY]: true }) : browser.storage.local.remove(SHOW_SELECTORS_KEY),
    capturesEverywhere,
    captureWarning: browserWarning(import.meta.env.FIREFOX),
    onCapturesEverywhere: (on) =>
      setCaptureEverywhere(on, {
        request: (wanted) => browser.permissions.request({ origins: [...wanted.origins] }),
        remove: (given) => browser.permissions.remove({ origins: [...given.origins] }),
      }),
  });
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
