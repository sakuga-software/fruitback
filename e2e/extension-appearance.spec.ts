import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect } from '@playwright/test';
import { addRule, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Appearance » of the page of the extension (FRU-601): the colour of the note button. It paints
 * « Leave a note » of the popup and « Send » of a widget the extension mounts; the widget of an open
 * tab takes it at once, with no new widget, so a note being written stays. The launch button of the
 * widget and its pins keep their colours. A colour under 4.5:1 with white text is refused.
 */

declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };

const ORANGE = 'rgb(194, 65, 12)';
const INK = 'rgb(28, 25, 23)';
const FRUITBACK_RED = 'rgb(221, 44, 39)';
const WHITE = 'rgb(255, 255, 255)';

const background = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
const color = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);

async function stored(extension: { worker: { evaluate: <T>(fn: () => Promise<T>) => Promise<T> } }) {
  return extension.worker.evaluate(async () => (await chrome.storage.local.get('actionColor')).actionColor);
}

async function openAppearance(page: Page, id: string): Promise<void> {
  await page.goto(`chrome-extension://${id}/options.html#appearance`);
  await expect(page.getByRole('heading', { level: 1, name: 'Appearance', exact: true })).toBeVisible();
}

// The click on the toolbar gives the popup the address of the tab (`activeTab`): `tabs` stands for it.
test.describe('with the address of the tab', () => {
  test.use({ extraPermissions: ['tabs'] });

  test('the colour chosen in « Appearance » paints « Leave a note » and « Send », keeps the note being written, and is refused under 4.5:1 (FRU-601)', async ({
    extension,
  }) => {
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
    const site = await extension.context.newPage();
    await openBareSite(site, 'ext-action-color');
    const launch = site.locator('[data-fruitback-host-launch]');
    await launch.click();
    await site.locator('[data-testid="card-latte"] .add').click();
    const note = site.getByPlaceholder('What should change?');
    await note.fill('Written before the colour changed');
    const send = site.getByRole('button', { name: 'Send', exact: true });
    // Nothing chosen: the accent of the widget.
    await expect.poll(() => background(send)).toBe(FRUITBACK_RED);

    const options = await extension.context.newPage();
    await openAppearance(options, extension.id);
    const presets = options.getByRole('group', { name: 'Colour of the note button' });
    await expect(presets.getByRole('radio', { name: 'Fruitback' })).toBeChecked();
    await expect(options.getByRole('button', { name: 'Reset to Fruitback red' })).toBeDisabled();

    // Orange: stored, previewed, and « Send » of the open tab is orange with the note still there.
    await presets.getByRole('radio', { name: 'Orange' }).check();
    await expect.poll(() => stored(extension)).toBe('#c2410c');
    const preview = options.getByRole('group', { name: 'Preview' });
    expect(await background(preview.getByText('Leave a note'))).toBe(ORANGE);
    expect(await background(preview.getByText('Send'))).toBe(ORANGE);
    await expect.poll(() => background(send)).toBe(ORANGE);
    expect(await color(send)).toBe(WHITE);
    await expect(note).toHaveValue('Written before the colour changed');
    await expect(site.locator('[data-fruitback-host]')).toHaveCount(1);
    // The launch button of the widget keeps the accent: only « Send » takes the colour.
    expect(await background(launch)).toBe(FRUITBACK_RED);

    // The popup: « Leave a note » in orange.
    const popup = await openPopup(extension, site);
    const leave = popup.getByRole('button', { name: 'Leave a note' });
    await expect(leave).toBeVisible();
    await expect.poll(() => background(leave)).toBe(ORANGE);
    expect(await color(leave)).toBe(WHITE);
    await popup.close();

    // Ink: the drop stays red, on « Send » and in the preview.
    await options.bringToFront();
    await presets.getByRole('radio', { name: 'Ink' }).check();
    await expect.poll(() => stored(extension)).toBe('#1c1917');
    await expect.poll(() => background(send)).toBe(INK);
    expect(await color(send.locator('svg'))).toBe(FRUITBACK_RED);
    expect(await color(preview.locator('.appearance-send svg'))).toBe(FRUITBACK_RED);
    await expect(note).toHaveValue('Written before the colour changed');

    // A colour of your own under 4.5:1: said, refused, and nothing changes.
    const own = options.getByLabel('Your own colour');
    await own.fill('#facc15');
    await own.press('Enter');
    await expect(options.locator('#appearance-said')).toHaveText('1.5:1 with white text. Pick a darker colour.');
    expect(await stored(extension)).toBe('#1c1917');
    await expect(own).toHaveValue('#facc15');
    // A colour that holds white text: kept when the field is left, and no radio says another one.
    await own.fill('#1d4ed8');
    await expect(options.locator('#appearance-said')).toHaveText('6.7:1 with white text.');
    await own.press('Enter');
    await expect.poll(() => stored(extension)).toBe('#1d4ed8');
    await expect(presets.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect.poll(() => background(send)).toBe('rgb(29, 78, 216)');

    // Reset: no key, the accent again, and the note is still being written.
    await options.getByRole('button', { name: 'Reset to Fruitback red' }).click();
    await expect.poll(() => stored(extension)).toBeUndefined();
    await expect(presets.getByRole('radio', { name: 'Fruitback' })).toBeChecked();
    await expect.poll(() => background(send)).toBe(FRUITBACK_RED);
    await expect(note).toHaveValue('Written before the colour changed');

    // A page loaded after a choice mounts with it.
    await presets.getByRole('radio', { name: 'Deep red' }).check();
    await expect.poll(() => stored(extension)).toBe('#b91c1c');
    await site.reload();
    await site.locator('[data-fruitback-host-launch]').click();
    await site.locator('[data-testid="card-latte"] .add').click();
    await expect
      .poll(() => background(site.getByRole('button', { name: 'Send', exact: true })))
      .toBe('rgb(185, 28, 28)');
  });
});

test('« Appearance » at 1440 and 390 px, in both schemes and in French: axe, nothing wider than the window (FRU-601)', async ({
  extension,
}) => {
  for (const language of ['en', 'fr'] as const) {
    // The language of the browser, read by the page when it loads: for the pages opened after this.
    if (language === 'fr') {
      await extension.context.addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
      });
    }
    const page = await extension.context.newPage();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`chrome-extension://${extension.id}/options.html#appearance`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(language === 'fr' ? 'Apparence' : 'Appearance');
      await expect(page).toHaveTitle(language === 'fr' ? 'Apparence · Fruitback' : 'Appearance · Fruitback');
      // A colour refused is said on the page: its line is read by axe too.
      await page.locator('#appearance-own-color').fill('#facc15');
      await expect(page.locator('#appearance-said')).toHaveText(
        language === 'fr'
          ? '1,5:1 avec un texte blanc. Choisissez une couleur plus foncée.'
          : '1.5:1 with white text. Pick a darker colour.',
      );
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const where = `${language}, ${width} px, ${colorScheme}`;
        expect
          .soft(await page.evaluate(() => document.documentElement.scrollWidth), `${where}: wider than the window`)
          .toBeLessThanOrEqual(width);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect
          .soft(
            violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
            where,
          )
          .toEqual([]);
      }
      // Each of the four colours, in the preview: its white label at 4.5:1 or more, which axe measures.
      for (const name of language === 'fr' ? ['Rouge profond', 'Orange', 'Encre'] : ['Deep red', 'Orange', 'Ink']) {
        await page.getByRole('radio', { name }).check();
        const { violations } = await new AxeBuilder({ page })
          .include('.appearance-preview')
          .withRules(['color-contrast'])
          .analyze();
        expect
          .soft(
            violations.map((violation) => violation.id),
            `${language}, ${width} px, ${name}`,
          )
          .toEqual([]);
      }
      await page
        .getByRole('button', { name: language === 'fr' ? 'Revenir au rouge Fruitback' : 'Reset to Fruitback red' })
        .click();
    }
  }
});
