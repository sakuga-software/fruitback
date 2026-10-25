import { type Page, expect, test } from '@playwright/test';
import { LANGUAGES, LONG_NOTE, LONG_URL, LONG_WORD, WIDTHS, overflows } from './overflow.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * No text of the widget runs past its box or past the screen (FRU-350): the composer, the bubble of
 * a note, the list of the page and the settings, at 320, 390 and 1280 px, in English and in French,
 * with long data — a note with an address and a word that have no space, a long name, a long reply.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SHOTS = process.env.FRUITBACK_WRAP_SHOTS;

type Widget = { showEveryNote(): void; settings: { open(): void; close(): void } };

/** Every note the worker reads back carries long words: what the store in memory cannot give. */
async function longNotes(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      issues: { stateName: string; comments?: unknown[]; note: Record<string, unknown> }[];
    };
    for (const issue of body.issues) {
      issue.stateName = 'Waiting for the review of the design team';
      issue.note.source = {
        component: 'CheckoutPaymentMethodConfirmationButtonWithLoyaltyPoints',
        file: 'src/features/checkout/payment-method/components/confirmation/ConfirmationButtonWithLoyaltyPoints.tsx',
        line: 142,
      };
      issue.note.reporter = { name: 'Marie-Antoinette de La Rochefoucauld-Montmorency' };
      issue.comments = [
        {
          id: 'reply-1',
          body: `Corrigé dans la préproduction, vérifiez ici : ${LONG_URL}`,
          createdAt: new Date(Date.now() - 86_400_000).toISOString(),
          author: `Jean-Baptiste ${LONG_WORD}`,
        },
      ];
    }
    await route.fulfill({ response, json: body });
  });
}

async function expectNothingRunsPast(page: Page, where: string, shot: string): Promise<void> {
  await page.waitForTimeout(250);
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/widget-${shot}.png` });
  expect.soft(await overflows(page, '[data-fruitback-host]'), where).toEqual([]);
}

for (const width of WIDTHS) {
  for (const language of LANGUAGES) {
    test(`the widget at ${width} px in ${language}: nothing runs past its box (FRU-350)`, async ({ page }) => {
      const at = `${width}-${language}`;
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await longNotes(page);
      await page.goto(`/?widget=off&case=wrap-${at}-${test.info().retry}`);
      await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
      await page.addScriptTag({ path: IIFE });
      await page.evaluate(
        ({ endpoint, locale }) => {
          const scope = globalThis as unknown as { Fruitback: { init(options: unknown): unknown }; widget: unknown };
          scope.widget = scope.Fruitback.init({ endpoint, clientId: 'playground', locale });
        },
        { endpoint: WORKER_ORIGIN, locale: language },
      );

      // The composer, with a long note typed.
      await page.locator('[data-fruitback-host-launch]').click();
      await page.locator('[data-testid="card-espresso"] .add').click();
      await page.locator('.fruitback-composer textarea').fill(LONG_NOTE);
      await expectNothingRunsPast(page, `${at}: the composer`, `${at}-1-composer`);

      // The bubble of the note, once sent and read back with its long words.
      await page.locator('.fruitback-composer-send').click();
      await expect(page.locator('.fruitback-composer')).toBeHidden({ timeout: 10_000 });
      await page.locator('.fruitback-pin-badge').first().click();
      await expect(page.locator('.fruitback-thread')).toBeVisible();
      await expect(page.locator('.fruitback-thread-reply-body')).toBeVisible();
      await expectNothingRunsPast(page, `${at}: the bubble of a note`, `${at}-2-thread`);
      await page.keyboard.press('Escape');

      // The list of the page.
      await page.evaluate(() => (globalThis as unknown as { widget: Widget }).widget.showEveryNote());
      await expect(page.locator('.fruitback-sidebar')).toBeVisible();
      await expectNothingRunsPast(page, `${at}: the list of the page`, `${at}-3-list`);
      await page.keyboard.press('Escape');

      // The settings.
      await page.evaluate(() => (globalThis as unknown as { widget: Widget }).widget.settings.open());
      await expect(page.locator('.fruitback-panel-config')).toBeVisible();
      await expectNothingRunsPast(page, `${at}: the settings`, `${at}-4-settings`);
    });
  }
}
