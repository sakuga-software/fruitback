import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The files of a note in the composer (FRU-332), in French, at 390 px, with axe, in both schemes.
 *
 * The bundle is mounted with a transport that answers the read with `canAttach: true` and keeps a
 * file as the worker does, and with a capture of the host that answers a PNG: what the extension
 * gives a site of a workspace. The path through the real relay and worker is in `extension.spec.ts`.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as { Fruitback: { init(options: unknown): unknown }; areas: unknown[] };
    scope.areas = [];
    let n = 0;
    (scope.Fruitback as { init(options: unknown): unknown }).init({
      endpoint,
      clientId: 'playground',
      locale: 'fr',
      label: 'Laisser une note',
      captureVisible: async (area?: unknown) => {
        scope.areas.push(area ?? null);

        return { name: area === undefined ? 'page.png' : 'zone.png', type: 'image/png', size: 4, base64: 'iVBORw==' };
      },
      transport: async (request: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
        const url = new URL(request.url);
        if (url.pathname === '/attachments') {
          n += 1;

          return { ok: true, status: 201, body: JSON.stringify({ id: `att_${String(n).padStart(32, '0')}` }) };
        }
        const answer = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        const body = await answer.text();
        if (request.method === 'GET' && answer.ok) {
          return { ok: true, status: 200, body: JSON.stringify({ ...JSON.parse(body), canAttach: true }) };
        }

        return { ok: answer.ok, status: answer.status, body };
      },
    });
  }, WORKER_ORIGIN);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`in French at 390 px, the files and the area of a capture work with the keyboard, and axe finds nothing (${scheme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/?case=attachments-${scheme}&widget=off`);
    await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
    await mount(page);

    await page.getByRole('button', { name: 'Laisser une note' }).click();
    await page.locator('[data-testid="card-latte"] .add').click();
    const files = page.getByRole('group', { name: 'Pièces jointes' });
    await expect(files).toBeVisible();
    await expect(page.locator('[data-fruitback-attach-file-input]')).toBeHidden();

    // The area, with the keyboard only: the arrows, Shift and the arrows, Enter.
    await files.getByRole('button', { name: 'Capturer une zone' }).focus();
    await page.keyboard.press('Enter');
    const area = page.getByRole('dialog', { name: 'Choisir une zone de la page' });
    await expect(area).toBeVisible();
    const axeArea = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(axeArea.violations).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await expect(area).toBeHidden();
    await expect(page.locator('.fruitback-composer-file-name')).toHaveText(['zone.png']);
    const taken = (await page.evaluate(() => (globalThis as unknown as { areas: unknown[] }).areas)) as {
      left: number;
      width: number;
      height: number;
    }[];
    expect(taken).toHaveLength(1);
    expect(taken[0]?.left).toBeCloseTo(390 * 0.25 + 10, 0);

    // Esc cancels, and nothing is joined.
    await files.getByRole('button', { name: 'Capturer une zone' }).focus();
    await page.keyboard.press('Enter');
    await expect(area).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(area).toBeHidden();
    await expect(page.locator('.fruitback-composer-file')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Retirer zone.png' })).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    );
  });
}
