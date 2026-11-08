import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * The narrow screen and the large volumes of P7 (FRU-611, points 4 and 5), on the widget as `init`
 * mounts it: the sheet of a phone, « Send » on its whole width, targets of 44 px, the element above the
 * sheet; « 99+ » in the list with the notes to check exact; a long host cut at its start.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mountAt(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  await page.locator('[data-fruitback-host-launch]').waitFor();
}

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    });

for (const scheme of ['light', 'dark'] as const) {
  test(`at 390 px the composer is a sheet under its element, « Send » on its whole width, every target 44 px, ${scheme} scheme (FRU-611)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mountAt(page, `/?widget=off&case=${caseOf(`narrow-${scheme}`)}`);
    await page.locator('[data-fruitback-host-launch]').click();
    const composer = page.locator('[data-fruitback-composer]');

    // An element low in the window, on a page that can scroll: the page scrolls it above the sheet.
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="card-mocha"] .add') as HTMLElement;
      window.scrollTo(0, card.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 4);
    });
    await page.locator('[data-testid="card-mocha"] .add').click();
    await expect(composer).toBeVisible();
    let sheet = await box(page, '[data-fruitback-composer]');
    expect(Math.round(sheet.bottom)).toBe(844);
    expect(Math.round(sheet.width)).toBe(390);
    const card = await box(page, '[data-testid="card-mocha"] .add');
    expect(card.bottom).toBeLessThanOrEqual(sheet.top);
    expect(card.top).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(composer).toBeHidden();

    // The element at the very foot of a page that cannot scroll more: the sheet stands on the top,
    // and the element stays in sight under it. The page gets no margin.
    await page.locator('[data-fruitback-host-launch]').click();
    await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.locator('#checkout-cta').click();
    await expect(composer).toBeVisible();
    await expect(composer).toHaveAttribute('data-fruitback-sheet', 'top');
    sheet = await box(page, '[data-fruitback-composer]');
    expect(Math.round(sheet.top)).toBe(0);
    const cta = await box(page, '#checkout-cta');
    expect(cta.top).toBeGreaterThanOrEqual(sheet.bottom);
    expect(cta.bottom).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);

    // « Send » on a line of its own, on the width of the foot.
    const send = await box(page, '.fruitback-composer-send-group');
    const foot = await box(page, '.fruitback-composer-foot');
    expect(send.width).toBeGreaterThan(foot.width - 40);
    // Every button of the sheet is 44 px tall at least.
    const short = await composer.evaluate((node) =>
      [...node.querySelectorAll('button')]
        .filter((button) => button.getClientRects().length > 0 && button.getBoundingClientRect().height < 44)
        .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
    );
    expect(short).toEqual([]);
  });
}

test.describe('on a phone, where the pointer is coarse too (review of #860)', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('every target of the sheet is still 44 px', async ({ page }) => {
    await mountAt(page, `/?widget=off&case=${caseOf('narrow-coarse')}`);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('[data-fruitback-host-launch]').tap();
    await page.locator('[data-testid="card-latte"] .add').tap();
    const composer = page.locator('[data-fruitback-composer]');
    await expect(composer).toBeVisible();
    const short = await composer.evaluate((node) =>
      [...node.querySelectorAll('button')]
        .filter((button) => button.getClientRects().length > 0 && button.getBoundingClientRect().height < 44)
        .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
    );
    expect(short).toEqual([]);
  });
});

test('at 1440 px « Send » keeps its own width, the control of the sheet (FRU-611)', async ({ page }) => {
  await mountAt(page, `/?widget=off&case=${caseOf('wide-send')}`);
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeVisible();
  const send = await box(page, '.fruitback-composer-send-group');
  const foot = await box(page, '.fruitback-composer-foot');
  expect(send.width).toBeLessThan(foot.width / 2);
});

/** A read of `open` new notes and `check` done notes of the reader, whatever the worker holds. */
async function manyNotes(page: Page, open: number, check: number): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { issues: Record<string, unknown>[] };
    const model = body.issues[0];
    if (model === undefined) return route.fulfill({ response, json: body });
    const copies = (count: number, stage: string, mine: boolean) =>
      Array.from({ length: count }, (_, index) => ({
        ...model,
        id: `${String(model.id)}-${stage}-${index}`,
        identifier: `DEV-${stage}-${index}`,
        stage,
        stateName: stage === 'done' ? 'Done' : 'New',
        ...(mine ? { mine: true } : {}),
        note: { ...(model.note as Record<string, unknown>), id: `${stage}-${index}`, text: `${stage} ${index}` },
      }));
    await route.fulfill({
      response,
      json: { ...body, issues: [...copies(open, 'new', false), ...copies(check, 'done', true)] },
    });
  });
}

test('a list of many notes says « 99+ » above 99, and the notes to check exactly (FRU-611)', async ({ page }) => {
  test.slow();
  await manyNotes(page, 120, 101);
  await mountAt(page, `/?widget=off&case=${caseOf('many-notes')}`);
  // One note to copy: the read gives it back as 221.
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.locator('[data-fruitback-note]:visible').fill('One note, copied by the read');
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
  await page.reload();
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  await page.getByRole('button', { name: /^Show every note in a sidebar/ }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await expect(list.getByRole('tab')).toHaveText(['To check · 101', 'Open · 99+', 'Done · 0'], { timeout: 15_000 });
  // The tabs keep one line and their width.
  expect(
    await list.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().height)),
  ).toEqual([32, 32, 32]);
});

test('a long host is cut at its start: its end stays in sight, and its tooltip holds it whole (FRU-611)', async ({
  page,
}) => {
  // Chromium sends every subdomain of localhost to the loopback.
  const host = 'review-4521-a-very-long-branch-name-for-the-preview.localhost:5177';
  await mountAt(page, `http://${host}/?widget=off&case=${caseOf('long-host')}`);
  await page.getByRole('button', { name: /^Show every note in a sidebar/ }).click();
  const tail = page.locator('.fruitback-sidebar-address .fruitback-host-tail');
  await expect(tail).toHaveAttribute('title', host);
  const drawn = await tail.evaluate((node) => {
    const words = node.firstElementChild?.firstChild as Text;
    const range = node.ownerDocument.createRange();
    const at = (index: number) => {
      range.setStart(words, index);
      range.setEnd(words, index + 1);
      return range.getBoundingClientRect();
    };
    const box = node.getBoundingClientRect();
    const last = at(words.length - 1);
    const first = at(0);
    return {
      cut: node.scrollWidth > node.clientWidth,
      lastInside: last.right <= box.right + 1 && last.left >= box.left - 1,
      firstOutside: first.right <= box.left + 1,
    };
  });
  // Cut, with the end of the host in the box and its start out of it.
  expect(drawn).toEqual({ cut: true, lastInside: true, firstOutside: true });
});
