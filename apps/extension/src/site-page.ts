import { msg, t } from './i18n.ts';
import { dropMark, segmentedTabs, toggle } from './kit.ts';
import { isWildcardPattern } from './site-patterns.ts';
import type { SiteConfig, SiteMode } from './sites.ts';

/**
 * The page of the extension (FRU-301), as the mock-up of 2026-10-20 draws it: a menu, and the
 * section « Sites », a table of the rules with the panel of the one that is chosen. No `browser`
 * here: `entrypoints/options/main.ts` reads storage and the grants and binds what a click does, so
 * every part is built and read under `node --test` (`site-page.test.ts`, on happy-dom).
 */

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;

  return node;
}

function button(document: Document, className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = make(document, 'button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);

  return node;
}

/** The guides the menu links to, on the documentation site. */
export const GUIDES = {
  reviewing: 'https://sakuga-software.github.io/fruitback/reviewing',
  modes: 'https://sakuga-software.github.io/fruitback/modes',
} as const;

export type MenuEntry = { id: string; label: string; count?: number };

/** The menu: the drop, « Fruitback » and its version, the sections of the page, and the two guides. */
export function menu(
  document: Document,
  options: { version: string; entries: MenuEntry[]; current: string },
): HTMLElement {
  const nav = make(document, 'nav', 'page-menu');
  nav.setAttribute('aria-label', t('Console'));
  const brand = make(document, 'div', 'page-brand');
  brand.append(
    dropMark(document),
    make(document, 'span', 'page-name', 'Fruitback'),
    make(document, 'span', 'page-version', options.version),
  );
  nav.append(brand);
  for (const entry of options.entries) {
    const link = make(document, 'a', 'page-entry', entry.label);
    link.href = `#${entry.id}`;
    if (entry.id === options.current) link.setAttribute('aria-current', 'true');
    if (entry.count !== undefined) link.append(make(document, 'span', 'page-count', String(entry.count)));
    nav.append(link);
  }
  nav.append(make(document, 'div', 'page-rule'));
  for (const [href, label] of [
    [GUIDES.reviewing, t('Reviewer guide')],
    [GUIDES.modes, t('Which mode?')],
  ] as const) {
    const link = make(document, 'a', 'page-guide', `${label} ↗`);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    nav.append(link);
  }

  return nav;
}

/** The head of « Sites »: the title, what a rule is, the filter, and « Add a site ». */
export function sitesHead(
  document: Document,
  options: { filter: string; onFilter: (text: string) => void; onAdd: () => void },
): HTMLElement {
  const head = make(document, 'div', 'sites-head');
  const words = make(document, 'div', 'sites-words');
  words.append(
    make(document, 'h1', '', t('Sites')),
    make(
      document,
      'p',
      'sites-intro',
      t('A rule says which worker, and which client, a site belongs to. A site no rule covers mounts nothing.'),
    ),
  );
  const tools = make(document, 'div', 'sites-tools');
  const search = make(document, 'label', 'sites-filter');
  const input = make(document, 'input', '');
  input.type = 'search';
  input.placeholder = t('Filter sites');
  input.setAttribute('aria-label', t('Filter sites'));
  input.value = options.filter;
  input.addEventListener('input', () => options.onFilter(input.value));
  search.append(input);
  tools.append(search, button(document, 'page-primary', t('Add a site'), options.onAdd));
  head.append(words, tools);

  return head;
}

/** A rule as a row of the table, with what the browser holds for it. */
export type RuleRow = {
  pattern: string;
  site: SiteConfig;
  granted: boolean;
  /** Why the rule runs nowhere (FRU-75, FRU-103): it has no switch, only « Remove rule ». */
  refused?: string;
  /** Why the background does not send it to the account of the browser (FRU-264). */
  tooLarge?: string;
};

/** What a pattern covers, in a few words. */
export function scopeOf(pattern: string): string {
  return isWildcardPattern(pattern) ? t('Every site this pattern covers') : t('This origin');
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Whether a row holds the words of a filter, in its pattern or its worker. */
export function matches(row: RuleRow, filter: string): boolean {
  const words = filter.trim().toLowerCase();

  return words === '' || `${row.pattern} ${row.site.endpoint}`.toLowerCase().includes(words);
}

function modeWord(mode: SiteMode): string {
  return mode === 'team' ? t('Team') : t('Private');
}

/**
 * Access, as the table says it. No access is a problem only for a rule that is on: a rule that is
 * off gave its access back (FRU-115).
 */
function accessCell(document: Document, row: RuleRow): HTMLElement {
  // A rule that runs nowhere says so, on or off: its access is not what is wrong (raised in review).
  if (row.refused !== undefined) return make(document, 'span', 'access-none', t('Runs nowhere'));
  if (row.granted) return make(document, 'span', 'access-granted', t('Granted'));

  return row.site.enabled && row.refused === undefined
    ? make(document, 'span', 'access-none', t('No access'))
    : make(document, 'span', 'access-off', t('No access while it is off'));
}

export type TableOptions = {
  rows: RuleRow[];
  selected?: string;
  onSelect: (pattern: string) => void;
  onToggle: (row: RuleRow, on: boolean) => void;
};

/** The table of the rules. The site of a row is a button: Enter or a click opens its panel. */
export function sitesTable(document: Document, options: TableOptions): HTMLElement {
  const wrap = make(document, 'div', 'sites-table');
  const table = make(document, 'table', '');
  const head = make(document, 'thead', '');
  const titles = make(document, 'tr', '');
  for (const word of [t('Site'), t('Mode'), t('Worker'), t('Access'), t('On')]) {
    const cell = make(document, 'th', '', word);
    cell.scope = 'col';
    titles.append(cell);
  }
  head.append(titles);
  const body = make(document, 'tbody', '');
  for (const row of options.rows) {
    const line = make(document, 'tr', 'rule-row');
    line.dataset.pattern = row.pattern;
    if (row.pattern === options.selected) line.setAttribute('aria-selected', 'true');

    const site = make(document, 'td', '');
    const open = button(document, 'rule-open', '', () => options.onSelect(row.pattern));
    open.append(
      make(document, 'span', 'rule-pattern', row.pattern),
      make(document, 'span', 'rule-scope', scopeOf(row.pattern)),
    );
    site.append(open);

    const mode = make(document, 'td', '');
    mode.append(make(document, 'span', 'mode-pill', modeWord(row.site.mode)));

    const access = make(document, 'td', '');
    access.append(accessCell(document, row));

    const on = make(document, 'td', 'rule-on');
    if (row.refused === undefined) {
      on.append(
        toggle(document, {
          checked: row.site.enabled,
          label: t('Fruitback on {pattern}', { pattern: row.pattern }),
          size: 'table',
          onChange: (checked) => options.onToggle(row, checked),
        }),
      );
    }
    line.append(site, mode, make(document, 'td', 'rule-worker', hostOf(row.site.endpoint)), access, on);
    body.append(line);
  }
  table.append(head, body);
  wrap.append(table);

  return wrap;
}

export type PanelFields = { mode: SiteMode; endpoint: string; clientId: string };

export type PanelOptions = {
  row: RuleRow;
  /** The person of the session of the worker of a team rule, when this browser holds one. */
  pairedAs?: string;
  onGrant: () => void;
  onSave: (fields: PanelFields) => void;
  onRemove: () => void;
};

const MODE_HINT: Record<SiteMode, string> = {
  private: msg('The site ships nothing; the extension mounts the widget for you only.'),
  team: msg('The site embeds a dormant widget; the extension wakes it and carries your session.'),
};

/** The panel of a rule: what it covers, its mode, its worker, what the browser holds, and its two actions. */
export function rulePanel(document: Document, options: PanelOptions): HTMLElement {
  const { row } = options;
  const aside = make(document, 'aside', 'rule-panel');
  aside.setAttribute('aria-label', t('Site details'));

  const top = make(document, 'div', 'panel-top');
  top.append(
    make(document, 'span', 'panel-label', t('Rule')),
    make(document, 'span', 'panel-pattern', row.pattern),
    make(document, 'span', 'panel-scope', scopeOf(row.pattern)),
  );

  let mode: SiteMode = row.site.mode;
  const hint = make(document, 'span', 'panel-hint', t(MODE_HINT[mode]));
  const modes = make(document, 'div', 'panel-field');
  modes.append(
    make(document, 'span', 'panel-label', t('Mode')),
    segmentedTabs(document, {
      label: t('Mode'),
      size: 'page',
      tabs: [
        { id: 'private', label: t('Private') },
        { id: 'team', label: t('Team') },
      ],
      selected: mode,
      onSelect: (id) => {
        mode = id === 'team' ? 'team' : 'private';
        hint.textContent = t(MODE_HINT[mode]);
        client.hidden = mode === 'team';
      },
    }),
    hint,
  );

  const endpoint = textField(document, t('Worker endpoint'), row.site.endpoint, 'url');
  const client = textField(document, t('Client id'), row.site.mode === 'private' ? row.site.clientId : '', 'text');
  client.hidden = mode === 'team';

  const body = make(document, 'div', 'panel-body');
  body.append(modes, endpoint, client, ruleState(document, options));
  if (row.tooLarge !== undefined) body.append(make(document, 'p', 'problem', t(row.tooLarge)));

  const foot = make(document, 'div', 'panel-foot');
  foot.append(
    button(document, 'panel-remove', t('Remove rule'), options.onRemove),
    button(document, 'panel-save', t('Save'), () =>
      options.onSave({
        mode,
        endpoint: (endpoint.querySelector('input') as HTMLInputElement).value.trim(),
        clientId: (client.querySelector('input') as HTMLInputElement).value.trim(),
      }),
    ),
  );
  aside.append(top, body, foot);

  return aside;
}

function textField(document: Document, label: string, value: string, type: 'url' | 'text'): HTMLLabelElement {
  const wrapper = make(document, 'label', 'panel-field');
  const input = make(document, 'input', '');
  input.type = type;
  input.value = value;
  wrapper.append(make(document, 'span', 'panel-label', label), input);

  return wrapper;
}

/**
 * What the browser holds for the rule: no access, a session, or a grant. Exported so that the page
 * can put a new one in place in an open panel, when the rule is switched or granted from elsewhere,
 * without drawing again the fields somebody may be typing in.
 */
export function ruleState(document: Document, options: PanelOptions): HTMLElement {
  const { row } = options;
  const box = make(document, 'div', 'panel-state');
  const say = (kind: string, title: string, text: string): void => {
    box.dataset.state = kind;
    box.append(make(document, 'span', 'panel-state-title', title), make(document, 'span', 'panel-state-text', text));
  };

  if (row.refused !== undefined) {
    // Why it runs nowhere, and the one thing to do: « Remove rule », at the foot.
    say('no-access', t('Runs nowhere'), t(row.refused));
  } else if (!row.granted && row.site.enabled) {
    say(
      'no-access',
      t('No access in this browser'),
      t(
        'Access does not travel with a rule, and it can be removed in the settings of the browser. Nothing is mounted until you grant it.',
      ),
    );
    box.append(button(document, 'page-primary', t('Grant access'), options.onGrant));
  } else if (!row.granted) {
    say('off', t('No access while it is off'), t('Turning the rule on asks the browser for its sites.'));
  } else if (row.site.mode === 'team' && options.pairedAs !== undefined) {
    say(
      'paired',
      t('Paired as {name}', { name: options.pairedAs }),
      t('Your session with {worker} is attached in the background, never in the page.', {
        worker: hostOf(row.site.endpoint),
      }),
    );
  } else if (row.site.mode === 'team') {
    say('unpaired', t('Not paired'), t('A team site stays asleep until this browser holds a session of its worker.'));
  } else {
    say('granted', t('Access granted'), t('Notes on this site are readable by anyone who can build the URL.'));
  }

  return box;
}
