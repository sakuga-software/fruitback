import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type I18n = typeof import('./i18n.ts');

/**
 * A copy of `i18n.ts` with no map loaded, in a browser of `language`. Each copy is a module of its
 * own, as the console is in each tab.
 */
let copies = 0;
async function fresh(language: string): Promise<I18n> {
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
  copies += 1;

  return (await import(`./i18n.ts?copy=${copies}`)) as I18n;
}

describe('the French map, loaded when French is asked for (FRU-494)', () => {
  it('changes the language only once the map is there, then tells the screens', async () => {
    const i18n = await fresh('en-US');
    await i18n.ready();
    let told = 0;
    i18n.onLocale(() => (told += 1));

    const asked = i18n.setLocale('fr', false);
    // Not yet: a screen told now would show English under a French date.
    assert.equal(i18n.locale(), 'en');
    assert.equal(told, 0);

    await asked;
    assert.equal(i18n.locale(), 'fr');
    assert.equal(told, 1);
    assert.equal(i18n.t('Try again'), 'Réessayer');

    // Loaded once: a change back and forth is at once.
    void i18n.setLocale('en', false);
    assert.equal(i18n.locale(), 'en');
    void i18n.setLocale('fr', false);
    assert.equal(i18n.locale(), 'fr');
  });

  it('keeps the language asked for last when the map arrives after it', async () => {
    const i18n = await fresh('en-US');
    const french = i18n.setLocale('fr', false);
    void i18n.setLocale('en', false);
    await french;

    assert.equal(i18n.locale(), 'en');
  });

  it('loads the map of a French browser before the first screen: ready() waits for it', async () => {
    const i18n = await fresh('fr-FR');
    assert.equal(i18n.locale(), 'en');

    await i18n.ready();
    assert.equal(i18n.locale(), 'fr');
    assert.equal(i18n.t('Try again'), 'Réessayer');
  });

  it('loads a map for a reader outside the screens, and changes no screen', async () => {
    const i18n = await fresh('en-US');
    let told = 0;
    i18n.onLocale(() => (told += 1));
    // Not loaded: English, as a screen would show.
    assert.equal(i18n.translate('fr', 'Try again'), 'Try again');

    await i18n.loadLocale('fr');
    assert.equal(i18n.translate('fr', 'Try again'), 'Réessayer');
    assert.equal(i18n.locale(), 'en');
    assert.equal(told, 0);
  });

  it('starts in English when the map does not load, and loads it at the next ask', async (context) => {
    const i18n = await fresh('en-US');
    const load = i18n.LOADERS.fr;
    context.mock.method(console, 'error', () => {});
    i18n.LOADERS.fr = () => Promise.reject(new Error('the chunk is gone'));

    // Resolves: the root waits for `ready()`, and a rejection would leave the console with no screen.
    await i18n.setLocale('fr', false);
    await i18n.ready();
    assert.equal(i18n.locale(), 'en');
    assert.equal(i18n.t('Try again'), 'Try again');

    i18n.LOADERS.fr = load;
    await i18n.setLocale('fr', false);
    assert.equal(i18n.locale(), 'fr');
  });

  it('waits for nothing in an English browser', async () => {
    const i18n = await fresh('en-GB');

    assert.equal(i18n.locale(), 'en');
    assert.equal(i18n.t('Try again'), 'Try again');
  });
});
