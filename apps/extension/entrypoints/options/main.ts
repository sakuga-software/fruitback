import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { PATTERN_PROBLEM, complaint, siteFrom } from '../../src/site-form.ts';
import { parseSitePattern } from '../../src/site-patterns.ts';
import { type SitesImport, exportSites, importSites } from '../../src/site-transfer.ts';
import { type SiteConfig, type SiteMode, readAll, removeSite, writeSite, writeSites } from '../../src/sites.ts';

/**
 * Every site entry, wildcards included, and the rules file a team hands around (SKG-536).
 *
 * What an entry covers is decided in `site-patterns.ts`, what a valid one is in `site-form.ts`, and
 * what a file holds in `site-transfer.ts`. This page builds the elements.
 *
 * A host permission may only be asked for while a click is handled. So each button that switches an
 * entry on asks first and awaits nothing before the request, as the popup's `turnOn` does.
 */

const IMPORT_PROBLEM: Record<Extract<SitesImport, { ok: false }>['reason'], string> = {
  'not-json': 'That file is not JSON.',
  'not-a-sites-file': 'That file is not a Fruitback rules file.',
  'newer-version': 'That file comes from a newer Fruitback. Update the extension, then import it again.',
};

/** What the list shows now. The add form checks for a duplicate here, because a storage read loses the click. */
let current: Record<string, SiteConfig> = {};

const app = document.querySelector('#app');
const list = document.createElement('div');

if (app !== null) {
  app.append(
    element('h1', 'Fruitback sites'),
    element(
      'p',
      'A rule says which worker, and which client, a site belongs to. A site that no rule covers mounts nothing.',
    ),
    list,
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
  const sites = await readAll();
  current = sites;
  const patterns = Object.keys(sites)
    .filter((pattern) => parseSitePattern(pattern) === pattern)
    .sort();

  if (patterns.length === 0) {
    list.replaceChildren(element('p', 'No rules yet. Add one below, or turn a site on from the toolbar.', 'state'));

    return;
  }

  const rows = document.createElement('ul');
  rows.className = 'rules';
  for (const pattern of patterns) {
    const site = sites[pattern];
    if (site !== undefined) rows.append(await row(pattern, site));
  }
  list.replaceChildren(rows);
}

async function row(pattern: string, site: SiteConfig): Promise<HTMLElement> {
  // A permission does not travel with an imported rule, and it can be revoked in the browser's own
  // settings. The background registers nothing without it, so the row says so.
  const granted = await browser.permissions.contains({ origins: [matchPatternFor(pattern)] });
  const client = site.mode === 'team' ? "team mode · the site's own widget" : site.clientId;

  const buttons = document.createElement('span');
  buttons.className = 'buttons';
  if (!granted) buttons.append(button('Grant access', () => void grant(pattern)));
  buttons.append(
    site.enabled
      ? button('Turn off', () => void writeSite(pattern, { ...site, enabled: false }))
      : button('Turn on', () => void switchOn(pattern, site)),
    button('Remove', () => void removeSite(pattern), 'secondary'),
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

async function grant(pattern: string): Promise<void> {
  await browser.permissions.request({ origins: [matchPatternFor(pattern)] });
}

async function switchOn(pattern: string, site: SiteConfig): Promise<void> {
  if (await browser.permissions.request({ origins: [matchPatternFor(pattern)] })) {
    await writeSite(pattern, { ...site, enabled: true });
  }
}

function addForm(): HTMLElement {
  const sites = field('Sites', 'https://*.staging.acme.dev');
  const mode = modeField();
  const endpoint = field('Worker endpoint', 'https://feedback.acme.dev');
  const clientId = field('Client id', 'acme');
  const add = button('Add rule', () => {
    const pattern = parseSitePattern(sites.input.value);
    const values = {
      mode: mode.select.value === 'team' ? ('team' as const) : ('private' as const),
      endpoint: endpoint.input.value.trim(),
      clientId: clientId.input.value.trim(),
    };

    if (pattern === undefined) {
      problem.textContent = PATTERN_PROBLEM;

      return;
    }
    problem.textContent =
      current[pattern] === undefined ? complaint(values) : 'A rule for that pattern already exists. Remove it first.';
    if (problem.textContent !== '') return;

    void (async () => {
      if (!(await browser.permissions.request({ origins: [matchPatternFor(pattern)] }))) {
        problem.textContent = 'Fruitback needs access to those sites to run there. Nothing was saved.';

        return;
      }

      await writeSite(pattern, siteFrom(values, true));
      for (const input of [sites.input, endpoint.input, clientId.input]) input.value = '';
    })();
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

      await writeSites(parsed.sites);
      const count = Object.keys(parsed.sites).length;
      const skipped =
        parsed.skipped.length > 0 ? ` Skipped, because they do not parse: ${parsed.skipped.join(', ')}.` : '';
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
