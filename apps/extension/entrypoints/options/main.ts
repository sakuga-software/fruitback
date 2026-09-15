import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { STORE_PROBLEM, createEditor, latestOnly } from '../../src/site-editor.ts';
import { parseSitePattern } from '../../src/site-patterns.ts';
import { type TabScripting, injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { type SitesImport, exportSites, importSites } from '../../src/site-transfer.ts';
import { type SiteConfig, type SiteMode, readAll, removeSite, writeSite, writeSites } from '../../src/sites.ts';

/**
 * Every site entry, wildcards included, and the rules file a team hands around (SKG-536).
 *
 * What an entry covers is decided in `site-patterns.ts`, what a valid one is in `site-form.ts`, what a
 * button does in `site-editor.ts`, and what a file holds in `site-transfer.ts`. This page builds the
 * elements.
 */

const IMPORT_PROBLEM: Record<Extract<SitesImport, { ok: false }>['reason'], string> = {
  'not-json': 'That file is not JSON.',
  'not-a-sites-file': 'That file is not a Fruitback rules file.',
  'newer-version': 'That file comes from a newer Fruitback. Update the extension, then import it again.',
};

/** What the list shows now. The add form checks for a duplicate here, because a storage read loses the click. */
let current: Record<string, SiteConfig> = {};

const scripting: TabScripting = {
  query: (matchPattern) => browser.tabs.query({ url: matchPattern }),
  execute: async (tabId, file, world) => {
    await browser.scripting.executeScript({ target: { tabId }, files: [file], world });
  },
};

const editor = createEditor({
  request: (pattern) => browser.permissions.request({ origins: [matchPatternFor(pattern)] }),
  write: writeSite,
  current: () => current,
  activate: (pattern) => injectIntoOpenTabs(scripting, pattern),
});
const beginRender = latestOnly();

const app = document.querySelector('#app');
const list = document.createElement('div');
/** Where a change made from a row reports that it was not confirmed. */
const notice = element('p', '', 'problem');

if (app !== null) {
  app.append(
    element('h1', 'Fruitback sites'),
    element(
      'p',
      'A rule says which worker, and which client, a site belongs to. A site that no rule covers mounts nothing.',
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
  list.replaceChildren(
    patterns.length === 0
      ? element('p', 'No rules yet. Add one below, or turn a site on from the toolbar.', 'state')
      : rows,
  );
}

async function row(pattern: string, site: SiteConfig): Promise<HTMLElement> {
  // A permission does not travel with an imported rule, and it can be revoked in the browser's own
  // settings. The background registers nothing without it, so the row says so.
  const granted = await browser.permissions.contains({ origins: [matchPatternFor(pattern)] });
  const client = site.mode === 'team' ? "team mode · the site's own widget" : site.clientId;

  const buttons = document.createElement('span');
  buttons.className = 'buttons';
  if (!granted) buttons.append(button('Grant access', () => attempt(grant(pattern, site))));
  buttons.append(
    site.enabled
      ? button('Turn off', () => attempt(writeSite(pattern, { ...site, enabled: false })))
      : button('Turn on', () => attempt(editor.switchOn(pattern, site))),
    button('Remove', () => attempt(removeSite(pattern)), 'secondary'),
  );

  const item = document.createElement('li');
  item.append(
    element('span', pattern, 'pattern'),
    buttons,
    element('span', `${site.enabled ? 'On' : 'Off'} · ${client} · ${site.endpoint}`, 'state'),
    element('span', granted ? 'Access granted' : 'No access in this browser', granted ? 'state' : 'problem'),
  );

  return item;
}

/** An enabled rule that just got its grant runs in the tabs already open on it, as a new rule does. */
async function grant(pattern: string, site: SiteConfig): Promise<void> {
  if ((await browser.permissions.request({ origins: [matchPatternFor(pattern)] })) && site.enabled) {
    await injectIntoOpenTabs(scripting, pattern);
  }
}

/**
 * Runs a row's change and reports a rejection under the list.
 *
 * A click is fire-and-forget, so a rejection that is not handled here is reported nowhere.
 */
function attempt(change: Promise<unknown>): void {
  notice.textContent = '';
  change.catch((error: unknown) => {
    console.error('[fruitback] a site change was not confirmed', error);
    notice.textContent = STORE_PROBLEM;
  });
}

function addForm(): HTMLElement {
  const sites = field('Sites', 'https://*.staging.acme.dev');
  const mode = modeField();
  const endpoint = field('Worker endpoint', 'https://feedback.acme.dev');
  const clientId = field('Client id', 'acme');
  const add = button('Add rule', () => {
    void editor
      .add({
        sites: sites.input.value,
        mode: mode.select.value === 'team' ? 'team' : 'private',
        endpoint: endpoint.input.value.trim(),
        clientId: clientId.input.value.trim(),
      })
      .then((text) => {
        problem.textContent = text;
        if (text === '') for (const input of [sites.input, endpoint.input, clientId.input]) input.value = '';
      });
  });
  const problem = element('p', '', 'problem');

  const showFields = (): void => {
    clientId.label.hidden = mode.select.value === 'team';
  };
  mode.select.addEventListener('change', showFields);
  showFields();

  const wrapper = document.createElement('section');
  wrapper.append(element('h2', 'Add a rule'), sites.label, mode.label, endpoint.label, clientId.label, add, problem);

  return wrapper;
}

function transfer(): HTMLElement {
  const exporter = button('Export rules', () => {
    const url = URL.createObjectURL(new Blob([exportSites(current)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fruitback-sites.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  const label = document.createElement('label');
  label.append('Import a rules file', input);
  const result = element('p', '', 'state');

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file === undefined) return;

    void (async () => {
      const parsed = importSites(await file.text());
      input.value = '';
      if (!parsed.ok) {
        result.textContent = IMPORT_PROBLEM[parsed.reason];

        return;
      }

      try {
        await writeSites(parsed.sites);
      } catch (error) {
        console.error('[fruitback] the import was not confirmed', error);
        result.textContent = STORE_PROBLEM;

        return;
      }
      const count = Object.keys(parsed.sites).length;
      const skipped =
        parsed.skipped.length > 0 ? ` Skipped, because they are not valid: ${parsed.skipped.join(', ')}.` : '';
      result.textContent = `Imported ${count} ${count === 1 ? 'rule' : 'rules'}.${skipped}`;
    })();
  });

  const wrapper = document.createElement('section');
  wrapper.append(
    element('h2', 'Share rules'),
    element(
      'p',
      'A rules file holds patterns, modes, endpoints and client ids. It holds no session and no access. An imported rule replaces the rule with the same pattern, and the other rules stay.',
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
    option.textContent = text;
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
