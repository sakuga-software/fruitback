import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored, createEditor, latestOnly } from '../../src/site-editor.ts';
import { PREVIEWS_NOT_PROVEN, STALE_TEAM_WILDCARD, TOO_LARGE_FOR_ACCOUNT } from '../../src/site-form.ts';
import { lendsSession, parseSitePattern } from '../../src/site-patterns.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { browserTabScripting as scripting } from '../../src/tab-scripting-browser.ts';
import { SYNC_SETTING, fits } from '../../src/site-sync.ts';
import { exportSites, importSites } from '../../src/site-transfer.ts';
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
import { storedLanguage } from '../../src/language.ts';
import { CHROMIUM_SHORTCUTS_URL, currentShortcut } from '../../src/shortcut.ts';

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
  request: (pattern) => browser.permissions.request({ origins: [matchPatternFor(pattern)] }),
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
const sessions = createBrowserSessions();

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
  share.id = 'share';
  const prefs = await synchronise();
  prefs.id = 'prefs';
  // FRU-291: the key that starts a note, where the mock-up of 2026-10-20 puts it, in the preferences.
  prefs.append(element('h3', t('Keyboard shortcut')), await shortcutLine());
  const content = element('main', '', 'page-content');
  content.append(sites, share, prefs);
  const frame = element('div', '', 'page');
  frame.append(
    menu(document, {
      version: browser.runtime.getManifest().version,
      current: 'sites',
      entries: [
        { id: 'sites', label: t('Sites') },
        { id: 'share', label: t('Share rules') },
        { id: 'prefs', label: t('Preferences') },
      ],
    }),
    content,
  );
  app.append(frame);
}

void renderList();
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
        void editor.save(row.pattern, fields).then((text) => showProblem(said, text, { list: reloadList })),
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
  const granted = await browser.permissions.contains({ origins: [matchPatternFor(pattern)] });
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
  };
}

/**
 * An enabled rule that just got its grant runs in the tabs already open on it, as a new rule does.
 *
 * Answers whether the grant was given, so a refusal is reported like a failure.
 */
async function grant(pattern: string, site: SiteConfig): Promise<boolean> {
  const granted = await browser.permissions.request({ origins: [matchPatternFor(pattern)] });
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
        showProblem(problem, text, { grant: submit, list: reloadList });
        // Stored: the new rule's panel takes the place of the form.
        if (text === '') choose(parseSitePattern(sites.input.value));
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

function transfer(): HTMLElement {
  const exporter = button(t('Export rules'), () => {
    const url = URL.createObjectURL(new Blob([exportSites(current)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fruitback-sites.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
  exporter.disabled = true;
  needsList.push(exporter);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  const label = document.createElement('label');
  label.append(t('Import a rules file'), input);
  const result = element('p', '', 'state');

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file === undefined) return;

    void (async () => {
      const parsed = importSites(await file.text());
      input.value = '';
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
      // An imported rule can already hold its grant, from before it was removed. Its open tabs get the
      // scripts now; a tab without a grant is not returned by the query, so it costs nothing.
      for (const [pattern, site] of Object.entries(parsed.sites)) {
        if (site.enabled) await injectIntoOpenTabs(scripting, pattern);
      }
      const count = Object.keys(parsed.sites).length;
      const imported = count === 1 ? t('Imported 1 rule.') : t('Imported {count} rules.', { count });
      const skipped =
        parsed.skipped.length > 0
          ? ` ${t('Skipped, because they are not valid: {patterns}.', { patterns: parsed.skipped.join(', ') })}`
          : '';
      result.textContent = `${imported}${skipped}`;
    })();
  });

  const wrapper = element('section', '', 'page-section');
  wrapper.append(
    element('h2', t('Share rules')),
    element(
      'p',
      t(
        'A rules file holds patterns, modes, endpoints and client ids. It holds no session and no access. An imported rule replaces the rule with the same pattern, and the other rules stay.',
      ),
    ),
    exporter,
    label,
    result,
  );

  return wrapper;
}

/**
 * The rules in the account of the browser (FRU-72). Off until the reviewer ticks the box: a rule that
 * is synchronised leaves this computer. The background does the copy; this writes the choice only.
 */
async function synchronise(): Promise<HTMLElement> {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = (await browser.storage.local.get(SYNC_SETTING))[SYNC_SETTING] === true;
  box.addEventListener('change', () => void browser.storage.local.set({ [SYNC_SETTING]: box.checked }));
  const label = document.createElement('label');
  label.className = 'choice';
  label.append(box, t('Keep my rules in the account of this browser'));

  const wrapper = element('section', '', 'page-section');
  wrapper.append(
    element('h2', t('Preferences')),
    element('h3', t('Synchronise rules')),
    element(
      'p',
      t(
        'When this is on, your rules (patterns, modes, endpoints, client ids, and the labels and workspace names they hold) are kept by the account of this browser, and reach your other browsers where it is on too. No session and no access travel: on another browser, grant access to each site. Turning it off stops the copy, and removes nothing from the account.',
      ),
    ),
    label,
  );

  return wrapper;
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
 * The key that starts a note, and the way to change it (FRU-291). One line, on its own, so the
 * page of the extension that replaces this one can take it whole.
 *
 * The key is the browser's, read from `commands.getAll()`: the person may have changed it, and a
 * browser installs the command with no key when another extension holds the one suggested.
 */
async function shortcutLine(): Promise<HTMLElement> {
  const line = element('p', '', 'state');
  const shortcut = currentShortcut(await browser.commands.getAll().catch(() => []));
  line.append(
    shortcut === undefined
      ? t('Leave feedback shortcut: none set.')
      : t('Leave feedback shortcut: {shortcut}.', { shortcut }),
    ' ',
  );

  // Firefox 137 opens its own page. Chromium browsers have one, at an address the extension may open.
  // An older Firefox has neither, so the line says where to look.
  const commands = browser.commands as typeof browser.commands & { openShortcutSettings?: () => Promise<void> };
  let open: (() => Promise<unknown> | undefined) | undefined;
  if (typeof commands.openShortcutSettings === 'function') open = () => commands.openShortcutSettings?.();
  else if (!import.meta.env.FIREFOX) open = () => browser.tabs.create({ url: CHROMIUM_SHORTCUTS_URL });
  if (open === undefined) {
    line.append(t('Change it in Add-ons, Manage Extension Shortcuts.'));

    return line;
  }
  // The small outlined button that sits beside a sentence, as a remedy does: no new style.
  const change = element('button', t('Change the shortcut'), 'remedy');
  change.type = 'button';
  change.addEventListener('click', () => void open());
  line.append(change);

  return line;
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
