import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { GUIDES, type RuleRow, matches, menu, rulePanel, scopeOf, sitesHead, sitesTable } from './site-page.ts';

/**
 * The page of the extension (FRU-301), read on happy-dom: the menu, the head of « Sites », the table
 * and the panel of a rule. The measures and the colours are `e2e/extension-page.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/options.html' }).document as unknown as Document;
}

const nothing = () => {};

const PRIVATE: RuleRow = {
  pattern: 'https://staging.acme.dev',
  site: { mode: 'private', endpoint: 'https://feedback.acme.dev', clientId: 'acme', enabled: true },
  granted: true,
};
const TEAM: RuleRow = {
  pattern: 'https://*.preview.acme.dev',
  site: { mode: 'team', endpoint: 'https://api.fruitback.com', enabled: true },
  granted: false,
};

afterEach(() => setLanguage('en'));

describe('the page of the extension (FRU-301)', () => {
  it('has a menu with the version, the sections, and the two guides in a tab of their own', () => {
    const nav = menu(page(), {
      version: '0.2.0',
      current: 'sites',
      entries: [
        { id: 'sites', label: 'Sites', count: 2 },
        { id: 'share', label: 'Share rules' },
      ],
    });

    assert.equal(nav.getAttribute('aria-label'), 'Console');
    assert.equal(nav.querySelector('.page-version')?.textContent, '0.2.0');
    const entries = [...nav.querySelectorAll('a.page-entry')];
    assert.deepEqual(
      entries.map((entry) => [entry.getAttribute('href'), entry.textContent, entry.getAttribute('aria-current')]),
      [
        ['#sites', 'Sites2', 'true'],
        ['#share', 'Share rules', null],
      ],
    );
    const guides = [...nav.querySelectorAll('a.page-guide')];
    assert.deepEqual(
      guides.map((guide) => [guide.textContent, guide.getAttribute('href'), guide.getAttribute('target')]),
      [
        ['Reviewer guide ↗', GUIDES.reviewing, '_blank'],
        ['Which mode? ↗', GUIDES.modes, '_blank'],
      ],
    );
  });

  it('heads « Sites » with what a rule is, a filter that says what is typed, and « Add a site »', () => {
    const typed: string[] = [];
    let added = 0;
    const document = page();
    const head = sitesHead(document, { filter: '', onFilter: (text) => typed.push(text), onAdd: () => (added += 1) });

    assert.equal(head.querySelector('h1')?.textContent, 'Sites');
    const input = head.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Filter sites');
    input.value = 'acme';
    input.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event('input'));
    (head.querySelector('button') as HTMLButtonElement).click();
    assert.deepEqual(typed, ['acme']);
    assert.equal(added, 1);
  });

  it('filters on the pattern and on the worker, and says what a pattern covers', () => {
    assert.ok(matches(PRIVATE, ''));
    assert.ok(matches(PRIVATE, ' STAGING '));
    assert.ok(matches(TEAM, 'fruitback.com'));
    assert.ok(!matches(PRIVATE, 'preview'));
    assert.equal(scopeOf(PRIVATE.pattern), 'This origin');
    assert.equal(scopeOf(TEAM.pattern), 'Every site this pattern covers');
  });

  it('lists each rule with its mode, worker, access and switch, and opens a rule from its site', () => {
    const chosen: string[] = [];
    const switched: string[] = [];
    const refused: RuleRow = { ...PRIVATE, pattern: 'https://old.acme.dev', refused: 'gone', granted: false };
    const table = sitesTable(page(), {
      rows: [PRIVATE, TEAM, refused],
      selected: TEAM.pattern,
      onSelect: (pattern) => chosen.push(pattern),
      onToggle: (row, on) => switched.push(`${row.pattern} ${on}`),
    });

    assert.deepEqual(
      [...table.querySelectorAll('th')].map((cell) => cell.textContent),
      ['Site', 'Mode', 'Worker', 'Access', 'On'],
    );
    const lines = [...table.querySelectorAll('tbody tr')];
    assert.deepEqual(
      lines.map((line) => [...line.querySelectorAll('td')].slice(1, 4).map((cell) => cell.textContent)),
      [
        ['Private', 'feedback.acme.dev', 'Granted'],
        ['Team', 'api.fruitback.com', 'No access'],
        ['Private', 'feedback.acme.dev', 'Runs nowhere'],
      ],
    );
    assert.equal(lines[1]?.getAttribute('aria-selected'), 'true');
    assert.equal(lines[0]?.getAttribute('aria-selected'), null);
    // A rule that runs nowhere has no switch.
    assert.equal(lines[2]?.querySelector('[role="switch"]'), null);
    const toggle = lines[0]?.querySelector('[role="switch"]') as HTMLButtonElement;
    assert.equal(toggle.getAttribute('aria-label'), 'Fruitback on https://staging.acme.dev');
    assert.equal(toggle.dataset.size, 'table');
    toggle.click();
    // The site of a row is a native button: Enter opens it.
    const open = lines[1]?.querySelector('button.rule-open') as HTMLButtonElement;
    assert.equal(open.type, 'button');
    open.click();
    assert.deepEqual(switched, ['https://staging.acme.dev false']);
    assert.deepEqual(chosen, [TEAM.pattern]);
  });

  it('opens the panel of a rule: its mode in tabs, its fields, and what the browser holds', () => {
    const saved: unknown[] = [];
    const done: string[] = [];
    const document = page();
    const aside = rulePanel(document, {
      row: PRIVATE,
      onGrant: () => done.push('grant'),
      onSave: (fields) => saved.push(fields),
      onRemove: () => done.push('remove'),
    });
    document.body.append(aside);

    assert.equal(aside.getAttribute('aria-label'), 'Site details');
    assert.equal(aside.querySelector('.panel-pattern')?.textContent, 'https://staging.acme.dev');
    assert.equal(aside.querySelector('[role="tab"][aria-selected="true"]')?.textContent, 'Private');
    assert.equal(
      aside.querySelector('.panel-hint')?.textContent,
      'The site ships nothing; the extension mounts the widget for you only.',
    );
    assert.equal((aside.querySelector('.panel-state') as HTMLElement).dataset.state, 'granted');

    const [endpoint, client] = [...aside.querySelectorAll<HTMLInputElement>('.panel-field input')];
    assert.equal(endpoint?.value, 'https://feedback.acme.dev');
    assert.equal(client?.value, 'acme');
    (endpoint as HTMLInputElement).value = ' https://other.acme.dev ';
    // Team hides the client id, and says what team mode does.
    (aside.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1] as HTMLButtonElement).click();
    assert.equal((client as HTMLInputElement).parentElement?.hidden, true);
    assert.equal(
      aside.querySelector('.panel-hint')?.textContent,
      'The site embeds a dormant widget; the extension wakes it and carries your session.',
    );
    (aside.querySelector('.panel-save') as HTMLButtonElement).click();
    (aside.querySelector('.panel-remove') as HTMLButtonElement).click();
    assert.deepEqual(saved, [{ mode: 'team', endpoint: 'https://other.acme.dev', clientId: 'acme' }]);
    assert.deepEqual(done, ['remove']);
  });

  it('names the workspace of a site of Fruitback, whose widget the extension mounts (FRU-319)', () => {
    const cloud: RuleRow = {
      pattern: 'https://staging.acme.dev',
      site: {
        mode: 'team',
        endpoint: 'https://api.fruitback.com',
        enabled: true,
        mount: { clientId: 'w1', workspace: 'Acme' },
      },
      granted: true,
    };
    const document = page();
    const table = sitesTable(document, { rows: [cloud, TEAM], onSelect: nothing, onToggle: nothing });
    assert.deepEqual(
      [...table.querySelectorAll('.rule-scope')].map((scope) => scope.textContent),
      ['This origin · Acme', 'Every site this pattern covers'],
    );
    const aside = rulePanel(document, { row: cloud, onGrant: nothing, onSave: nothing, onRemove: nothing });
    assert.equal(aside.querySelector('.panel-scope')?.textContent, 'This origin · Acme');
    // Not « the site embeds a dormant widget »: the site embeds nothing.
    assert.equal(
      aside.querySelector('.panel-hint')?.textContent,
      'The site ships nothing; the extension mounts the widget of Acme and carries your session.',
    );
    // The control: a team rule with no mount is the site's own widget, as before.
    const own = rulePanel(document, { row: TEAM, onGrant: nothing, onSave: nothing, onRemove: nothing });
    assert.equal(
      own.querySelector('.panel-hint')?.textContent,
      'The site embeds a dormant widget; the extension wakes it and carries your session.',
    );
  });

  it('says a rule that is on has no access, and offers to grant it', () => {
    let granted = 0;
    const aside = rulePanel(page(), { row: TEAM, onGrant: () => (granted += 1), onSave: nothing, onRemove: nothing });

    const state = aside.querySelector('.panel-state') as HTMLElement;
    assert.equal(state.dataset.state, 'no-access');
    assert.equal(state.querySelector('.panel-state-title')?.textContent, 'No access in this browser');
    (state.querySelector('button') as HTMLButtonElement).click();
    assert.equal(granted, 1);
  });

  it('says that a rule that runs nowhere does so, on or off, with its reason (raised in review)', () => {
    const refused: RuleRow = { ...TEAM, refused: 'A wildcard cannot serve team mode.' };
    const aside = rulePanel(page(), { row: refused, onGrant: nothing, onSave: nothing, onRemove: nothing });
    assert.equal(aside.querySelector('.panel-state-title')?.textContent, 'Runs nowhere');
    assert.equal(aside.querySelector('.panel-state-text')?.textContent, 'A wildcard cannot serve team mode.');
    // No grant to offer: removing it is the fix.
    assert.equal(aside.querySelector('.panel-state button'), null);
  });

  it('says who a team rule is paired as, and when it is not', () => {
    const team = { ...TEAM, pattern: 'https://staging.acme.dev', granted: true };
    const paired = rulePanel(page(), {
      row: team,
      pairedAs: 'Camille Durand',
      onGrant: nothing,
      onSave: nothing,
      onRemove: nothing,
    });
    assert.equal(paired.querySelector('.panel-state-title')?.textContent, 'Paired as Camille Durand');
    assert.equal(
      paired.querySelector('.panel-state-text')?.textContent,
      'Your session with api.fruitback.com is attached in the background, never in the page.',
    );
    const alone = rulePanel(page(), { row: team, onGrant: nothing, onSave: nothing, onRemove: nothing });
    assert.equal((alone.querySelector('.panel-state') as HTMLElement).dataset.state, 'unpaired');
  });

  it('speaks French', () => {
    setLanguage('fr');
    const table = sitesTable(page(), { rows: [PRIVATE], onSelect: nothing, onToggle: nothing });
    assert.deepEqual(
      [...table.querySelectorAll('th')].map((cell) => cell.textContent),
      ['Site', 'Mode', 'Serveur', 'Accès', 'Activé'],
    );
    assert.equal(table.querySelector('.access-granted')?.textContent, 'Accordé');
  });
});
