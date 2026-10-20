import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { PAIRING_NEEDS_HTTPS } from './remedy.ts';
import { type WorkerCard, preferencesSection, shortcutKeys, sitesCount, workersSection } from './workers-page.ts';

/**
 * « Workers and sessions » and « Preferences » of the page of the extension (FRU-302), on happy-dom.
 * Pairing, logging out and the preferences in a real browser are `e2e/extension-page.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/options.html' }).document as unknown as Document;
}

const nothing = () => {};
const workers = (cards: WorkerCard[], calls: string[] = []) =>
  workersSection(page(), {
    cards,
    onPair: (endpoint, code) => calls.push(`pair:${endpoint}:${code}`),
    onLogout: (endpoint) => calls.push(`logout:${endpoint}`),
  });

afterEach(() => setLanguage('en'));

describe('« Workers and sessions » (FRU-302)', () => {
  it('says what pairing is for, and has one card for each worker, with its sites', () => {
    const section = workers([
      { endpoint: 'https://feedback.acme.dev', host: 'feedback.acme.dev', sites: 2, pairing: 'https' },
      { endpoint: 'http://localhost:8787', host: 'localhost:8787', sites: 1, pairing: 'local' },
    ]);

    assert.equal(section.id, 'workers');
    assert.equal(section.querySelector('h2')?.textContent, 'Workers and sessions');
    assert.equal(
      section.querySelector('.workers-intro')?.textContent,
      'You pair with a worker, not with a site: one session covers every site that reports to it. Only team mode needs one.',
    );
    assert.deepEqual(
      [...section.querySelectorAll('.worker-card')].map((card) => [
        card.querySelector('.worker-host')?.textContent,
        card.querySelector('.worker-sites')?.textContent,
      ]),
      [
        ['feedback.acme.dev', '2 sites'],
        ['localhost:8787', '1 site'],
      ],
    );
  });

  it('shows who the session is, with « Log out »', () => {
    const calls: string[] = [];
    const section = workers(
      [
        {
          endpoint: 'https://feedback.acme.dev',
          host: 'feedback.acme.dev',
          sites: 2,
          pairing: 'https',
          session: { name: 'Camille Durand' },
        },
      ],
      calls,
    );
    const card = section.querySelector('.worker-card');

    assert.equal(card?.querySelector('.worker-who')?.textContent, 'Paired as Camille Durand');
    assert.equal(card?.querySelector('.worker-who strong')?.textContent, 'Camille Durand');
    assert.equal(card?.querySelector('.worker-dot')?.getAttribute('data-on'), 'true');
    assert.match(card?.textContent ?? '', /Verified by the worker · renews on its own/);
    card?.querySelector<HTMLButtonElement>('button')?.click();
    assert.deepEqual(calls, ['logout:https://feedback.acme.dev']);
  });

  // FRU-289: with no name, the identity stays readable.
  it('says « Paired » alone, and the e-mail under it, for a session with no name', () => {
    const section = workers([
      {
        endpoint: 'https://feedback.acme.dev',
        host: 'feedback.acme.dev',
        sites: 1,
        pairing: 'https',
        session: { email: 'camille@acme.dev' },
      },
    ]);

    assert.equal(section.querySelector('.worker-who')?.textContent, 'Paired');
    assert.equal(section.querySelector('.worker-who + .worker-hint')?.textContent, 'camille@acme.dev');
  });

  it('says « Signed in as » for the account of the Cloud', () => {
    const section = workers([
      {
        endpoint: 'https://api.fruitback.com',
        host: 'api.fruitback.com',
        sites: 0,
        pairing: 'https',
        account: true,
        session: { name: 'Camille Durand' },
      },
    ]);

    assert.equal(section.querySelector('.worker-who')?.textContent, 'Signed in as Camille Durand');
    assert.match(section.textContent ?? '', /One account for the console and this extension/);
  });

  it('offers a code and « Pair » to a worker with no session, prefilled from a link', () => {
    const calls: string[] = [];
    const section = workers(
      [
        {
          endpoint: 'https://feedback.acme.dev',
          host: 'feedback.acme.dev',
          sites: 1,
          pairing: 'https',
          code: 'ABCD-EFGH-JKMN',
        },
      ],
      calls,
    );
    const input = section.querySelector<HTMLInputElement>('input');

    assert.equal(
      section.querySelector('.worker-text')?.textContent,
      'Not paired. Private-mode sites read without a session; a team site would stay asleep.',
    );
    assert.equal(input?.getAttribute('aria-label'), 'Pairing code');
    assert.equal(input?.value, 'ABCD-EFGH-JKMN');
    section
      .querySelector('form')
      ?.dispatchEvent(new (page().defaultView as unknown as typeof globalThis).Event('submit'));
    assert.deepEqual(calls, ['pair:https://feedback.acme.dev:ABCD-EFGH-JKMN']);
    assert.equal(section.querySelector('.worker-said')?.getAttribute('role'), 'status');
  });

  it('says plain http works on this machine only, and offers no pairing off it', () => {
    const local = workers([{ endpoint: 'http://localhost:8787', host: 'localhost:8787', sites: 1, pairing: 'local' }]);
    assert.match(local.textContent ?? '', /Plain http on localhost\. Pairing works here/);
    assert.ok(local.querySelector('form'));

    const insecure = workers([
      { endpoint: 'http://192.168.1.10:8788', host: '192.168.1.10:8788', sites: 1, pairing: 'insecure' },
    ]);
    assert.equal(insecure.querySelector('.worker-text')?.textContent, PAIRING_NEEDS_HTTPS);
    assert.equal(insecure.querySelector('form'), null);
  });

  it('counts sites in French for a French reader', () => {
    setLanguage('fr');
    assert.equal(sitesCount(1), '1 site');
    assert.equal(sitesCount(3), '3 sites');
    assert.equal(workers([]).querySelector('h2')?.textContent, 'Workers et sessions');
  });
});

describe('« Preferences » (FRU-302)', () => {
  const options = (extra: Partial<Parameters<typeof preferencesSection>[1]> = {}) => ({
    panelOnClick: false,
    onPanelOnClick: nothing,
    name: '',
    onName: nothing,
    synced: false,
    onSynced: nothing,
    ...extra,
  });

  it('has the four rows of the mock-up, in order', () => {
    const section = preferencesSection(page(), options({ shortcut: 'Alt+Shift+F', onShortcut: nothing }));

    assert.equal(section.id, 'prefs');
    assert.deepEqual(
      [...section.querySelectorAll('.pref-title')].map((title) => title.textContent),
      [
        'Open notes in the sidebar',
        'Name on my notes',
        'Leave feedback shortcut',
        'Keep my rules in the account of this browser',
      ],
    );
    assert.deepEqual(
      [...section.querySelectorAll('kbd')].map((key) => key.textContent),
      ['Alt', 'Shift', 'F'],
    );
  });

  it('switches the panel on the icon, and the copy of the rules', () => {
    const calls: string[] = [];
    const section = preferencesSection(
      page(),
      options({ onPanelOnClick: (on) => calls.push(`panel:${on}`), onSynced: (on) => calls.push(`sync:${on}`) }),
    );
    const switches = [...section.querySelectorAll<HTMLButtonElement>('[role="switch"]')];

    assert.deepEqual(
      switches.map((each) => each.getAttribute('aria-label')),
      ['Open notes in the sidebar', 'Keep my rules in the account of this browser'],
    );
    for (const each of switches) each.click();
    assert.deepEqual(calls, ['panel:true', 'sync:true']);
  });

  it('draws no panel row where the browser has no panel to open', () => {
    const { panelOnClick: _panel, ...firefox } = options();
    const section = preferencesSection(page(), firefox);

    assert.equal(section.querySelectorAll('[role="switch"]').length, 1);
  });

  it('keeps the name as it is typed, trimmed, at most 120 characters', () => {
    const names: string[] = [];
    const document = page();
    const section = preferencesSection(document, options({ name: 'Camille', onName: (name) => names.push(name) }));
    const input = section.querySelector<HTMLInputElement>('.pref-name');

    assert.equal(input?.value, 'Camille');
    assert.equal(input?.maxLength, 120);
    assert.equal(input?.getAttribute('aria-label'), 'Name on my notes');
    if (input !== null) input.value = '  Camille Durand ';
    input?.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event('change'));
    assert.deepEqual(names, ['Camille Durand']);
  });

  it('says « Not set » with no key, and where to change it with no settings to open', () => {
    const section = preferencesSection(page(), options());

    assert.match(section.textContent ?? '', /Not set/);
    assert.match(section.textContent ?? '', /Change it in Add-ons, Manage Extension Shortcuts\./);
    assert.deepEqual(shortcutKeys('Alt+Shift+F'), ['Alt', 'Shift', 'F']);
  });
});
