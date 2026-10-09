import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM, STORE_PROBLEM, activateStored, createEditor, latestOnly } from '../../src/site-editor.ts';
import { STALE_TEAM_WILDCARD } from '../../src/site-form.ts';
import { lendsSession, parseSitePattern } from '../../src/site-patterns.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { browserTabScripting as scripting } from '../../src/tab-scripting-browser.ts';
import { exportSites, importSites } from '../../src/site-transfer.ts';
import { type SiteConfig, type SiteMode, readAll, removeSite, writeSite, writeSites } from '../../src/sites.ts';
import { showProblem } from '../../src/problem-view.ts';
import { IMPORT_PROBLEM } from '../../src/remedy.ts';
import { language, setLanguage, t } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';

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
const list = document.createElement('div');
/** Where a change made from a row reports that it was not confirmed. */
const notice = element('p', '', 'problem');

if (app !== null) {
  app.append(
    element('h1', t('Fruitback sites')),
    element(
      'p',
      t('A rule says which worker, and which client, a site belongs to. A site that no rule covers mounts nothing.'),
    ),
    list,
    notice,
    addForm(),
    transfer(),
  );
}

void renderList();
// Only the list is drawn again, so a change from the popup does not clear what somebody is typing.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites !== undefined) void renderList();
});
browser.permissions.onAdded.addListener(() => void renderList());
browser.permissions.onRemoved.addListener(() => void renderList());

async function renderList(): Promise<void> {
  const isLatest = beginRender();
  const sites = await readAll();
  const patterns = Object.keys(sites)
    .filter((pattern) => parseSitePattern(pattern) === pattern)
    .sort();

  const rows = document.createElement('ul');
  rows.className = 'rules';
  for (const pattern of patterns) {
    const site = sites[pattern];
    if (site !== undefined) rows.append(await row(pattern, site));
  }

  if (!isLatest()) return;
  current = sites;
  for (const control of needsList) control.disabled = false;
  list.replaceChildren(
    patterns.length === 0
      ? element('p', t('No rules yet. Add one below, or turn a site on from the toolbar.'), 'state')
      : rows,
  );
}

async function row(pattern: string, site: SiteConfig): Promise<HTMLElement> {
  // A permission does not travel with an imported rule, and it can be revoked in the browser's own
  // settings. The background registers nothing without it, so the row says so.
  const granted = await browser.permissions.contains({ origins: [matchPatternFor(pattern)] });
  const client = site.mode === 'team' ? t("team mode · the site's own widget") : site.clientId;

  // A rule stored before FRU-75. It runs nowhere now, so the row offers only to remove it.
  const refused = lendsSession(pattern, site);

  const buttons = document.createElement('span');
  buttons.className = 'buttons';
  if (!refused) {
    if (!granted) buttons.append(button(t('Grant access'), () => attempt(() => grant(pattern, site))));
    buttons.append(
      site.enabled
        ? button(t('Turn off'), () => attempt(() => writeSite(pattern, { ...site, enabled: false })))
        : button(t('Turn on'), () => attempt(() => editor.switchOn(pattern, site))),
    );
  }
  buttons.append(button(t('Remove'), () => attempt(() => removeSite(pattern)), 'secondary'));

  const item = document.createElement('li');
  item.append(
    element('span', pattern, 'pattern'),
    buttons,
    element('span', `${site.enabled && !refused ? t('On') : t('Off')} · ${client} · ${site.endpoint}`, 'state'),
    refused
      ? element('span', t(STALE_TEAM_WILDCARD), 'problem')
      : element('span', granted ? t('Access granted') : t('No access in this browser'), granted ? 'state' : 'problem'),
  );

  return item;
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
        if (text === '') for (const input of [sites.input, endpoint.input, clientId.input]) input.value = '';
      });
  };
  const add = button(t('Add rule'), submit);
  add.disabled = true;
  needsList.push(add);
  const problem = element('p', '', 'problem');

  const showFields = (): void => {
    clientId.label.hidden = mode.select.value === 'team';
  };
  mode.select.addEventListener('change', showFields);
  showFields();

  const wrapper = document.createElement('section');
  wrapper.append(element('h2', t('Add a rule')), sites.label, mode.label, endpoint.label, clientId.label, add, problem);

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

  const wrapper = document.createElement('section');
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
