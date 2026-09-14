import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES } from '@fruitback/shared';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { ENGLISH, type FruitbackMessages, createTranslator, languageOf } from './messages.ts';
import { createCaptureHost } from './host.ts';
import { createComposer } from './composer.ts';
import { createConfigPanel } from './panel.ts';
import { createConfigStore } from './config.ts';
import { createOverlay } from './overlay.ts';
import { mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

describe('createTranslator', () => {
  it('speaks English when nobody asked for anything', () => {
    const t = createTranslator();

    assert.equal(t.locale, 'en');
    assert.equal(t.text('launch.label'), 'Leave feedback');
    assert.equal(t.plural('orphans.count', 1), '1 detached note');
    assert.equal(t.plural('orphans.count', 2), '2 detached notes');
  });

  it('matches the exact tag before its primary subtag, and English last', () => {
    const messages = { fr: { 'settings.title': 'Réglages' }, 'fr-CA': { 'settings.title': 'Paramètres' } };

    assert.equal(createTranslator({ language: 'fr-CA', messages }).text('settings.title'), 'Paramètres');
    assert.equal(createTranslator({ language: 'fr-FR', messages }).text('settings.title'), 'Réglages');
    assert.equal(createTranslator({ language: 'de-DE', messages }).text('settings.title'), 'Settings');
  });

  it('lets `locale` win over the browser language', () => {
    const messages = { fr: { 'settings.title': 'Réglages' } };

    assert.equal(createTranslator({ locale: 'en', language: 'fr-FR', messages }).text('settings.title'), 'Settings');
    assert.equal(createTranslator({ locale: 'fr', language: 'en-US', messages }).text('settings.title'), 'Réglages');
  });

  it('shows English for a key left out, and ignores a key it does not know or of the wrong shape', () => {
    const messages = {
      fr: {
        'launch.label': 'Laisser un feedback',
        'not.a.key': 'x',
        'settings.title': 42,
        'orphans.count': 'pas un pluriel',
      },
    } as unknown as Record<string, FruitbackMessages>;
    const t = createTranslator({ locale: 'fr', messages });

    assert.equal(t.text('launch.label'), 'Laisser un feedback');
    assert.equal(t.text('settings.close'), 'Close settings');
    assert.equal(t.text('settings.title'), 'Settings');
    assert.equal(t.plural('orphans.count', 3), '3 detached notes');
  });

  it('refuses a plural message with no `other`, because some count will need it', () => {
    const messages = { fr: { 'orphans.count': { one: '{count} note' } } } as unknown as Record<
      string,
      FruitbackMessages
    >;

    assert.equal(createTranslator({ locale: 'fr', messages }).plural('orphans.count', 1), '1 detached note');
  });

  it('selects the plural form through Intl.PluralRules', () => {
    const forms = { one: '{count} notatka', few: '{count} notatki', many: '{count} notatek', other: '{count} notatki' };
    const t = createTranslator({ locale: 'pl', messages: { pl: { 'orphans.count': forms } } });

    assert.deepEqual(
      [1, 2, 5, 22].map((count) => t.plural('orphans.count', count)),
      ['1 notatka', '2 notatki', '5 notatek', '22 notatki'],
    );
  });

  it('uses the English rules for an English fallback under another locale', () => {
    // French puts 0 in `one`. With the French rules, the English fallback would say "0 detached note".
    const t = createTranslator({ locale: 'fr', messages: { fr: { 'launch.label': 'Laisser un feedback' } } });

    assert.equal(t.plural('orphans.count', 0), '0 detached notes');
  });

  it('ignores a locale tag that Intl refuses, rather than throwing', () => {
    const messages = { fr: { 'settings.title': 'Réglages' }, 'not a tag!': { 'settings.title': 'Nope' } };

    assert.equal(
      createTranslator({ locale: 'not a tag!', language: 'fr-FR', messages }).text('settings.title'),
      'Réglages',
    );
    const lost = createTranslator({ locale: 'not a tag!', language: '???', messages });
    assert.equal(lost.locale, 'en');
    assert.equal(lost.plural('orphans.count', 2), '2 detached notes');
  });

  it('substitutes placeholders in one pass, so a value is never read as a template', () => {
    const t = createTranslator();

    assert.equal(t.text('orphans.entry', { stage: '{note}', note: 'a {stage} b' }), '{note} · a {stage} b');
  });

  it('names every stage the contract has', () => {
    const t = createTranslator();

    for (const stage of SEED_STAGES) assert.equal(t.stage(stage), ENGLISH[`stage.${stage}`]);
  });

  it('formats a date in the locale the reader asked for', () => {
    const date = new Date('2026-08-01T12:00:00.000Z');

    assert.equal(createTranslator({ locale: 'fr-FR' }).date(date), '01/08/2026');
    assert.equal(createTranslator({ locale: 'en-US' }).date(date), '8/1/2026');
  });
});

describe('the bundled catalog', () => {
  it('gives the gear and the dialog it opens two different names', () => {
    // Two elements with one accessible name are ambiguous to a screen reader and to every E2E spec.
    assert.notEqual(ENGLISH['settings.open'], ENGLISH['settings.dialog']);
  });
});

describe('languageOf', () => {
  it('reads the navigator of the mounted page, not the global one', () => {
    const page = mountPage('<main></main>');
    Object.defineProperty(page.view.navigator, 'language', { value: 'fr-FR', configurable: true });

    assert.notEqual(
      globalThis.navigator?.language,
      'fr-FR',
      'the global navigator must disagree, or this proves nothing',
    );
    assert.equal(languageOf(page.document), 'fr-FR');
  });
});

describe('every word the widget shows', () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const destroy of cleanup.splice(0).reverse()) destroy();
  });

  /** Each key renders as its own name in brackets, so a word that is not a key is easy to find. */
  function pseudoCatalog(): FruitbackMessages {
    const catalog: Record<string, unknown> = {};
    for (const [key, message] of Object.entries(ENGLISH)) {
      catalog[key] = typeof message === 'string' ? `⟦${key}⟧` : { one: `⟦${key}⟧`, other: `⟦${key}⟧` };
    }

    return catalog as FruitbackMessages;
  }

  /** Text nodes and the attributes a reader or a screen reader gets, everywhere but in a stylesheet. */
  function shown(root: ShadowRoot): string[] {
    const found: string[] = [];
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'STYLE') continue;
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') found.push(node.textContent ?? '');
      }
      for (const name of ['aria-label', 'placeholder', 'title']) {
        const value = element.getAttribute(name);
        if (value) found.push(value);
      }
    }

    return found;
  }

  it('comes from the catalog, in every part of the widget', async () => {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const translator = createTranslator({ locale: 'en-XA', messages: { 'en-XA': pseudoCatalog() } });

    const host = createCaptureHost({ document: page.document, translator, onSelect: () => {}, onConfigure: () => {} });
    cleanup.push(() => host.destroy());
    const store = createConfigStore({
      defaults: { endpoint: 'https://worker.test', clientId: 'acme', hiddenStages: [], screenshot: false },
      storage: null,
    });
    const panel = createConfigPanel({
      document: page.document,
      host: host.root,
      store,
      translator,
      screenshotSupported: true,
    });
    cleanup.push(() => panel.destroy());
    const composer = createComposer({
      document: page.document,
      host: host.panel,
      translator,
      onSubmit: async () => true,
    });
    cleanup.push(() => composer.destroy());
    const overlay = createOverlay({ document: page.document, host: host.root, translator });
    cleanup.push(() => overlay.destroy());

    const found = seedIssueFixture({
      identifier: 'ID-1',
      stateName: '',
      comments: [],
      seed: seedFixture({
        id: 'sd_found',
        note: 'NOTE ONE',
        anchor: {
          selector: '[data-testid="cta"]',
          tag: 'button',
          text: 'Commander',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
    });
    const detached = seedIssueFixture({
      identifier: 'ID-2',
      stateName: '',
      comments: [{ id: 'c1', body: 'BODY', createdAt: '2026-08-01T12:00:00.000Z' }],
      seed: seedFixture({
        id: 'sd_gone',
        note: 'NOTE TWO',
        anchor: {
          selector: '#gone',
          tag: 'textarea',
          text: 'Disparu',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
    });
    overlay.render([found, detached]);

    const snapshots: string[] = [];
    const badges = [...host.root.querySelectorAll('.fruitback-pin-badge')] as HTMLElement[];
    for (const badge of badges) {
      badge.click();
      snapshots.push(...shown(host.root));
    }
    composer.open({ left: 0, top: 0, bottom: 10, right: 10 });
    snapshots.push(...shown(host.root));
    (composer.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    snapshots.push(...shown(host.root));

    // The detector first: a walk that finds no marker would pass the check below with nothing checked.
    const markers = new Set(snapshots.flatMap((text) => [...text.matchAll(/⟦([^⟧]+)⟧/g)].map((match) => match[1])));
    for (const key of [
      'launch.label',
      'settings.open',
      'settings.dialog',
      'settings.title',
      'settings.screenshot',
      'stage.ripe',
      'composer.placeholder',
      'composer.emailLabel',
      'composer.send',
      'composer.harvested',
      'pin.label',
      'pin.labelUncertain',
      'thread.close',
      'thread.anonymous',
      'thread.noReplies',
      'thread.team',
      'thread.orphan',
      'orphans.count',
      'orphans.entry',
    ]) {
      assert.ok(markers.has(key), `never rendered ${key}, so this test does not reach it`);
    }

    const data = ['NOTE ONE', 'NOTE TWO', 'ID-1', 'ID-2', 'BODY', 'https://…', 'acme'];
    const untranslated = snapshots.filter((text) => {
      const rest = data.reduce((left, value) => left.split(value).join(''), text.replace(/⟦[^⟧]+⟧/g, ''));

      return /\p{L}/u.test(rest);
    });
    assert.deepEqual([...new Set(untranslated)], []);
  });
});
