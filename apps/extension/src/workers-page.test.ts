import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { PAIRING_NEEDS_HTTPS } from './remedy.ts';
import {
  type WorkerCard,
  PREFERENCE_NOT_SAVED,
  preferencesSection,
  redrawWorkers,
  shortcutKeys,
  sitesCount,
  workersSection,
} from './workers-page.ts';

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
    assert.equal(workers([]).querySelector('h2')?.textContent, 'Serveurs et sessions');
  });
});

describe('« Workers and sessions » drawn again (raised in review)', () => {
  const unpaired: WorkerCard = {
    endpoint: 'https://feedback.acme.dev',
    host: 'feedback.acme.dev',
    sites: 2,
    pairing: 'https',
  };
  const other: WorkerCard = { endpoint: 'https://notes.beta.dev', host: 'notes.beta.dev', sites: 1, pairing: 'https' };
  const handlers = { onPair: nothing, onLogout: nothing };

  it('does not draw again the same cards: a code being typed, and what its line says, stay', () => {
    const document = page();
    const container = document.createElement('div');
    document.body.append(container);
    assert.equal(redrawWorkers(document, container, { cards: [unpaired], ...handlers }), true);
    const input = container.querySelector<HTMLInputElement>('input.worker-code');
    const said = container.querySelector('.worker-said');
    if (input === null || said === null) throw new Error('no field');
    input.value = 'ABCD-EF';
    input.focus();
    said.textContent = 'Enter the code';

    // A refresh of a session turned its tokens: the storage changed, the cards did not.
    assert.equal(redrawWorkers(document, container, { cards: [unpaired], ...handlers }), false);
    assert.equal(container.querySelector('input.worker-code'), input);
    assert.equal(input.value, 'ABCD-EF');
    assert.equal(container.querySelector('.worker-said')?.textContent, 'Enter the code');
  });

  it('puts back a code typed in a card still unpaired, with its focus, when other cards change', () => {
    const document = page();
    const container = document.createElement('div');
    document.body.append(container);
    redrawWorkers(document, container, { cards: [unpaired, other], ...handlers });
    const input = container.querySelector<HTMLInputElement>(`[data-endpoint="${unpaired.endpoint}"] input.worker-code`);
    if (input === null) throw new Error('no field');
    input.value = 'ABCD-EF';
    input.focus();

    // The other worker was paired in the popup meanwhile.
    const paired: WorkerCard = { ...other, session: { name: 'Camille Durand' } };
    assert.equal(redrawWorkers(document, container, { cards: [unpaired, paired], ...handlers }), true);
    const again = container.querySelector<HTMLInputElement>(`[data-endpoint="${unpaired.endpoint}"] input.worker-code`);
    assert.notEqual(again, input);
    assert.equal(again?.value, 'ABCD-EF');
    assert.equal(document.activeElement, again);
    assert.match(container.querySelector(`[data-endpoint="${other.endpoint}"]`)?.textContent ?? '', /Camille Durand/);
  });
});

describe('« Workers and sessions » while a pairing is in progress (raised in review)', () => {
  it('is not drawn again while a button of a card is off, and says a draw waits', () => {
    const document = page();
    const container = document.createElement('div');
    document.body.append(container);
    const unpaired: WorkerCard = {
      endpoint: 'https://feedback.acme.dev',
      host: 'feedback.acme.dev',
      sites: 2,
      pairing: 'https',
    };
    const other: WorkerCard = {
      endpoint: 'https://notes.beta.dev',
      host: 'notes.beta.dev',
      sites: 1,
      pairing: 'https',
    };
    const handlers = { onPair: nothing, onLogout: nothing };
    redrawWorkers(document, container, { cards: [unpaired, other], ...handlers });
    const submit = container.querySelector<HTMLButtonElement>(
      `[data-endpoint="${unpaired.endpoint}"] .worker-pair-button`,
    );
    if (submit === null) throw new Error('no button');
    // « Pair » was pressed: its button is off while the code is spent.
    submit.disabled = true;

    // Another worker was paired in the popup meanwhile: the cards changed, and still no draw.
    const changed = [unpaired, { ...other, session: { name: 'Camille Durand' } }];
    assert.equal(redrawWorkers(document, container, { cards: changed, ...handlers }), false);
    assert.equal(container.querySelector('.worker-pair-button'), submit);
    assert.equal(submit.disabled, true);
    assert.equal(container.dataset.pending, 'true');

    // The pairing ended: its button is on again, and the draw that waited happens.
    submit.disabled = false;
    assert.equal(redrawWorkers(document, container, { cards: changed, ...handlers }), true);
    assert.equal(container.dataset.pending, undefined);
  });
});

describe('« Corner of the widget » (FRU-443)', () => {
  const base = {
    panelOnClick: false,
    onPanelOnClick: nothing,
    name: '',
    onName: nothing,
    synced: false,
    onSynced: nothing,
    selectors: false,
    onSelectors: nothing,
    capturesEverywhere: false,
    captureWarning: 'Read and change all your data on all websites',
    onCapturesEverywhere: async (on: boolean) => on,
  };

  it('is a named select of the four corners, on the corner kept, and writes the one chosen', () => {
    const chosen: string[] = [];
    const section = preferencesSection(page(), {
      ...base,
      dockPosition: 'top-left',
      onDockPosition: (position) => void chosen.push(position),
    });
    const select = section.querySelector<HTMLSelectElement>('select.pref-select');
    assert.ok(select);
    assert.equal(select.getAttribute('aria-label'), 'Corner of the widget');
    assert.deepEqual(
      [...select.options].map((option) => `${option.value}:${option.textContent}`),
      ['bottom-right:Bottom right', 'bottom-left:Bottom left', 'top-right:Top right', 'top-left:Top left'],
    );
    assert.equal(select.value, 'top-left');

    select.value = 'bottom-left';
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    assert.deepEqual(chosen, ['bottom-left']);
  });

  it('goes back to the corner kept when the write fails, and says so', async () => {
    const section = preferencesSection(page(), {
      ...base,
      dockPosition: 'bottom-right',
      onDockPosition: () => Promise.reject(new Error('full')),
    });
    const select = section.querySelector<HTMLSelectElement>('select.pref-select');
    assert.ok(select);
    select.value = 'top-right';
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(select.value, 'bottom-right');
    assert.equal(section.querySelector('.pref-problem')?.textContent, 'This preference could not be saved. Try again.');
  });

  it('speaks French', () => {
    setLanguage('fr');
    try {
      const section = preferencesSection(page(), { ...base, dockPosition: 'bottom-right', onDockPosition: nothing });
      assert.deepEqual(
        [...(section.querySelector<HTMLSelectElement>('select.pref-select')?.options ?? [])].map((o) => o.textContent),
        ['En bas à droite', 'En bas à gauche', 'En haut à droite', 'En haut à gauche'],
      );
    } finally {
      setLanguage('en');
    }
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
    selectors: false,
    onSelectors: nothing,
    dockPosition: 'bottom-right' as const,
    onDockPosition: nothing,
    capturesEverywhere: false,
    captureWarning: 'Read and change all your data on all websites',
    onCapturesEverywhere: async (on: boolean) => on,
    ...extra,
  });

  it('has the rows of the mock-up, and « Show CSS selectors » after the name (FRU-349), in order', () => {
    const section = preferencesSection(page(), options({ shortcut: 'Alt+Shift+F', onShortcut: nothing }));

    assert.equal(section.id, 'prefs');
    assert.deepEqual(
      [...section.querySelectorAll('.pref-title')].map((title) => title.textContent),
      [
        'Open notes in the sidebar',
        'Name on my notes',
        'Show CSS selectors',
        'Corner of the widget',
        'Allow captures on every site',
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
      options({
        onPanelOnClick: (on) => void calls.push(`panel:${on}`),
        onSynced: (on) => void calls.push(`sync:${on}`),
        onSelectors: (on) => void calls.push(`selectors:${on}`),
      }),
    );
    const switches = [...section.querySelectorAll<HTMLButtonElement>('[role="switch"]')];

    assert.deepEqual(
      switches.map((each) => each.getAttribute('aria-label')),
      [
        'Open notes in the sidebar',
        'Show CSS selectors',
        'Allow captures on every site',
        'Keep my rules in the account of this browser',
      ],
    );
    for (const each of switches) each.click();
    assert.deepEqual(calls, ['panel:true', 'selectors:true', 'sync:true']);
  });

  it('asks for the captures on every site in the click, quotes the prompt, and puts the switch back when it is refused (FRU-425)', async () => {
    const asked: boolean[] = [];
    let answer = false;
    const section = preferencesSection(
      page(),
      options({
        onCapturesEverywhere: (on) => {
          asked.push(on);

          return Promise.resolve(answer);
        },
      }),
    );
    const knob = section.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Allow captures on every site"]');
    assert.ok(knob);
    assert.match(
      section.textContent ?? '',
      /Your browser will say that Fruitback can “Read and change all your data on all websites”/,
    );
    knob.click();
    // Asked in the click itself: nothing awaited before.
    assert.deepEqual(asked, [true]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(knob.getAttribute('aria-checked'), 'false', 'a refused prompt puts the switch back');
    answer = true;
    knob.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(knob.getAttribute('aria-checked'), 'true');
  });

  it('draws no panel row where the browser has no panel to open', () => {
    const { panelOnClick: _panel, ...firefox } = options();
    const section = preferencesSection(page(), firefox);

    assert.equal(section.querySelectorAll('[role="switch"]').length, 3);
  });

  it('keeps the name as it is typed, trimmed, at most 120 characters', () => {
    const names: string[] = [];
    const document = page();
    const section = preferencesSection(document, options({ name: 'Camille', onName: (name) => void names.push(name) }));
    const input = section.querySelector<HTMLInputElement>('.pref-name');

    assert.equal(input?.value, 'Camille');
    assert.equal(input?.maxLength, 120);
    assert.equal(input?.getAttribute('aria-label'), 'Name on my notes');
    if (input !== null) input.value = '  Camille Durand ';
    input?.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event('change'));
    assert.deepEqual(names, ['Camille Durand']);
  });

  it('shows « Show CSS selectors » off by default, and on when the preference is (FRU-349)', () => {
    const switchOf = (section: HTMLElement) =>
      section.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Show CSS selectors"]');

    assert.equal(switchOf(preferencesSection(page(), options()))?.getAttribute('aria-checked'), 'false');
    assert.equal(
      switchOf(preferencesSection(page(), options({ selectors: true })))?.getAttribute('aria-checked'),
      'true',
    );
  });

  it('says « Not set » with no key, and where to change it with no settings to open', () => {
    const section = preferencesSection(page(), options());

    assert.match(section.textContent ?? '', /Not set/);
    assert.match(section.textContent ?? '', /Change it in Add-ons, Manage Extension Shortcuts\./);
    assert.deepEqual(shortcutKeys('Alt+Shift+F'), ['Alt', 'Shift', 'F']);
    // Chrome on macOS: one sign for each key, with no `+`.
    assert.deepEqual(shortcutKeys('⌥⇧F'), ['⌥', '⇧', 'F']);
  });

  it('names Safari Settings on Safari, which has no page of shortcuts to open (FRU-380)', () => {
    const text = preferencesSection(page(), options({ shortcutPlace: 'safari' })).textContent ?? '';

    assert.match(text, /Change it in Safari Settings, Extensions\./);
    assert.doesNotMatch(text, /Manage Extension Shortcuts/);
  });

  it('offers no copy of the rules where the browser syncs nothing (Safari, FRU-380)', () => {
    const { synced: _synced, ...unsynced } = options();
    const titles = (section: HTMLElement) =>
      [...section.querySelectorAll('.pref-title')].map((title) => title.textContent);

    // The control: the row is there when the browser syncs.
    assert.ok(titles(preferencesSection(page(), options())).includes('Keep my rules in the account of this browser'));
    assert.ok(!titles(preferencesSection(page(), unsynced)).includes('Keep my rules in the account of this browser'));
  });

  it('quotes no prompt where the words of the browser are not known (Safari, FRU-380)', () => {
    const { captureWarning: _quoted, ...unquoted } = options();
    const text = preferencesSection(page(), unquoted).textContent ?? '';

    assert.match(text, /Your browser will ask you to allow Fruitback on every website\./);
    assert.doesNotMatch(text, /“/);
  });
});

describe('« Preferences » whose write failed (raised in review)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const refuse = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));

  it('puts each control back where it was, and says the preference was not saved', async () => {
    const section = preferencesSection(page(), {
      panelOnClick: false,
      onPanelOnClick: refuse,
      name: 'Ana',
      onName: refuse,
      synced: true,
      onSynced: refuse,
      selectors: false,
      onSelectors: refuse,
      dockPosition: 'bottom-right',
      onDockPosition: refuse,
      capturesEverywhere: false,
      captureWarning: 'Read and change all your data on all websites',
      onCapturesEverywhere: refuse,
    });
    const [panel, selectors, captures, synced] = [...section.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    const name = section.querySelector<HTMLInputElement>('input.pref-name');
    if (
      panel === undefined ||
      selectors === undefined ||
      captures === undefined ||
      synced === undefined ||
      name === null
    ) {
      throw new Error('no control');
    }

    panel.click();
    assert.equal(panel.getAttribute('aria-checked'), 'true');
    await settle();
    assert.equal(panel.getAttribute('aria-checked'), 'false', 'the switch shows a value that was not kept');
    assert.equal(section.querySelector('.pref-problem')?.textContent, PREFERENCE_NOT_SAVED);

    selectors.click();
    await settle();
    assert.equal(selectors.getAttribute('aria-checked'), 'false', 'the switch shows a value that was not kept');

    // FRU-425: a request that throws puts the switch back too, and says so.
    captures.click();
    await settle();
    assert.equal(captures.getAttribute('aria-checked'), 'false');
    assert.equal(section.querySelector('.pref-problem')?.textContent, PREFERENCE_NOT_SAVED);

    synced.click();
    await settle();
    assert.equal(synced.getAttribute('aria-checked'), 'true');

    name.value = 'Camille Durand';
    name.dispatchEvent(new (name.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    await settle();
    assert.equal(name.value, 'Ana', 'the field shows a name that was not kept');
  });

  it('says nothing when the write goes through, and clears what a failed one said', async () => {
    let fail = true;
    const section = preferencesSection(page(), {
      panelOnClick: false,
      onPanelOnClick: () => (fail ? refuse() : Promise.resolve()),
      name: '',
      onName: () => Promise.resolve(),
      synced: false,
      onSynced: () => Promise.resolve(),
      selectors: false,
      onSelectors: () => Promise.resolve(),
      dockPosition: 'bottom-right',
      onDockPosition: () => Promise.resolve(),
      capturesEverywhere: false,
      captureWarning: 'Read and change all your data on all websites',
      onCapturesEverywhere: (on) => Promise.resolve(on),
    });
    const panel = section.querySelector<HTMLButtonElement>('[role="switch"]');
    if (panel === null) throw new Error('no switch');
    panel.click();
    await settle();
    assert.equal(section.querySelector('.pref-problem')?.textContent, PREFERENCE_NOT_SAVED);
    fail = false;
    panel.click();
    await settle();
    assert.equal(panel.getAttribute('aria-checked'), 'true');
    assert.equal(section.querySelector('.pref-problem')?.textContent, '');
  });
});
