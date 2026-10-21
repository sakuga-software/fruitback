import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, addRule, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { LANGUAGES, LONG_NOTE, LONG_URL, LONG_WORD, WIDTHS, overflows } from './overflow.ts';

/**
 * No text of the extension runs past its box or past the screen (FRU-350): the page of the
 * extension, its welcome page and its side panel at 320, 390 and 1280 px, and the popup at its own
 * 380 px, in English and in French, with long rules — a long host, a long label, a long worker.
 */
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: object): Promise<void> } };
};

const SHOTS = process.env.FRUITBACK_WRAP_SHOTS;
const LONG_HOST = 'https://preview-branch-feature-very-long-name-1234.staging.acme.dev';

async function longRules(extension: LoadedExtension): Promise<void> {
  await extension.worker.evaluate(
    async ({ host, word, url }) => {
      const { sites } = (await chrome.storage.local.get('sites')) as { sites?: Record<string, unknown> };
      await chrome.storage.local.set({
        sites: {
          ...(sites ?? {}),
          [host]: {
            mode: 'private',
            endpoint: url.slice(0, 120),
            clientId: `client-${word}`,
            label: `Préproduction ${word}`,
            enabled: true,
          },
          'https://*.staging.acme-international-holdings.example': {
            mode: 'team',
            endpoint: 'https://notes.worker-of-the-acme-international-holdings.example',
            enabled: false,
          },
        },
        notesName: 'Marie-Antoinette de La Rochefoucauld-Montmorency',
      });
    },
    { host: LONG_HOST, word: LONG_WORD, url: LONG_URL },
  );
}

async function expectNothingRunsPast(page: Page, where: string, shot: string): Promise<void> {
  await page.waitForTimeout(300);
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/extension-${shot}.png`, fullPage: true });
  expect.soft(await overflows(page), where).toEqual([]);
}

for (const language of LANGUAGES) {
  test(`the pages of the extension in ${language}: nothing runs past its box at 320, 390 and 1280 px (FRU-350)`, async ({
    extension,
  }) => {
    // The rule of the playground through the page, so the browser grants it and the widget mounts:
    // the side panel then lists a note with long words.
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
    // The rule first: `addRule` reads the English labels of the page.
    if (language === 'fr') {
      await extension.context.addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
      });
    }
    await longRules(extension);
    const site = await extension.context.newPage();
    await openBareSite(site, `wrap-ext-${language}`);
    await site.locator('[data-fruitback-host-launch]').click();
    await site.locator('[data-testid="card-latte"] .add').click();
    await site.locator('.fruitback-composer textarea').fill(LONG_NOTE);
    await site.locator('.fruitback-composer-send').click();
    await expect(site.locator('[data-fruitback-pin]')).toHaveCount(1, { timeout: 10_000 });
    const page = await extension.context.newPage();
    for (const width of WIDTHS) {
      const at = `${width}-${language}`;
      await page.setViewportSize({ width, height: 900 });

      await page.goto(`chrome-extension://${extension.id}/options.html`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('tr.rule-row')).toHaveCount(3);
      await expectNothingRunsPast(page, `${at}: the page of the extension`, `${at}-options`);

      await page.goto(`chrome-extension://${extension.id}/welcome.html`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNothingRunsPast(page, `${at}: the welcome page`, `${at}-welcome`);

      // The side panel follows the active tab: drawn in a tab of its own, behind the site.
      await page.goto(`chrome-extension://${extension.id}/sidepanel.html`);
      await site.bringToFront();
      await expect(page.locator('.panel-row-note').first()).toBeVisible({ timeout: 10_000 });
      await expectNothingRunsPast(page, `${at}: the side panel`, `${at}-sidepanel`);
      await page.bringToFront();
    }

    // The popup has its own width, 380 px.
    const popup = await openPopup(extension, site);
    await expectNothingRunsPast(popup, `${language}: the popup`, `popup-${language}`);
  });
}
