import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * The thread of a pin beside its drop (FRU-304), and the thread of a note chosen in the list, in
 * the column of the list (FRU-312). Measured with the animations off.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** The widget as `init` assembles it: the playground has no button of the list. */
async function mount(page: Page, testCase: string, locale = 'en-US'): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, locale }) => {
      const scope = globalThis as unknown as {
        Fruitback: { init(options: Record<string, string>): unknown };
        fruitbackWidget?: unknown;
      };
      // Kept for the tests that drive what an extension drives, such as the mark of a pin.
      scope.fruitbackWidget = scope.Fruitback.init({ endpoint, clientId: 'playground', locale });
    },
    { endpoint: WORKER_ORIGIN, locale },
  );
}

async function plant(page: Page, selector: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-note]:visible').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

/** Where the thread is, against the point of the open drop. */
function placeOf(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const pin = root.querySelector('[data-fruitback-pin][data-fruitback-open]') as HTMLElement;
    const frame = pin.getBoundingClientRect();
    const bubble = root.querySelector('.fruitback-thread')!.getBoundingClientRect();
    const tipX = frame.left + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x'));

    return { after: bubble.left - tipX, before: tipX - bubble.right, right: bubble.right };
  });
}

test('the thread opens 26 px past the point of the drop, and on the other side near the edge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, 'pins-sides');
  await plant(page, '[data-testid="card-espresso"] .add', 'Left of the page');
  await plant(page, 'main header button', 'Right of the page');

  await page.getByRole('button', { name: /Left of the page/ }).click();
  expect((await placeOf(page)).after).toBeCloseTo(26, 0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Right of the page/ }).click();
  const near = await placeOf(page);
  expect(near.before).toBeCloseTo(26, 0);
  expect(near.right).toBeLessThanOrEqual(1440);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`at ${width} px, a note chosen in the list opens in the list, and covers neither the rows' head nor the list's (FRU-312)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await mount(page, `pins-list-${width}`);
    await plant(page, '[data-testid="card-latte"] .add', 'Chosen in the list');

    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    const list = page.getByRole('dialog', { name: 'Notes on this page' });
    await list.getByRole('button', { name: 'All 1', exact: true }).click();
    const row = list.locator('[data-fruitback-note]');
    await row.click();

    const thread = list.locator('[data-fruitback-thread]');
    await expect(thread).toContainText('Chosen in the list');
    // In the list, under its head: the title, the address and the cross of the list stay in sight.
    const [head, bubble, panel] = await Promise.all([
      list.locator('.fruitback-sidebar-head').boundingBox(),
      thread.boundingBox(),
      list.boundingBox(),
    ]);
    expect(bubble!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
    expect(bubble!.x).toBeGreaterThanOrEqual(panel!.x);
    expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 0.5);
    await expect(list.getByRole('button', { name: 'Close the sidebar' })).toBeInViewport();
    // No thread on the page besides it.
    await expect(page.locator('[data-fruitback-thread]')).toHaveCount(1);

    // « All notes » brings the rows back, with focus on the row of the note.
    await list.getByRole('button', { name: 'All notes' }).click();
    await expect(thread).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing in a thread in the list, and in French it says « Toutes les notes », in the ${scheme} scheme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mount(page, `pins-axe-${scheme}`, 'fr-FR');
    await page.locator('[data-fruitback-host-launch]').click();
    await page.locator('[data-testid="card-mocha"] .add').click();
    await page.locator('[data-fruitback-note]:visible').fill('Une note lue dans la liste');
    await page.locator('[data-fruitback-send]').click();
    await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Voir toutes les notes dans un panneau' }).click();
    const list = page.getByRole('dialog', { name: 'Notes de cette page' });
    await list.getByRole('button', { name: /^Toutes 1$/ }).click();
    await list.locator('[data-fruitback-note]').click();
    await expect(list.getByRole('button', { name: 'Toutes les notes' })).toBeVisible();
    // The thread is drawn, in French. No reply yet: no « Réponses » over nothing (FRU-419).
    await expect(list.locator('.fruitback-thread-note')).toHaveText('Une note lue dans la liste');
    await expect(list.locator('.fruitback-thread-close')).toHaveAccessibleName('Fermer la note');
    await expect(list.locator('.fruitback-thread-answers')).toHaveCount(0);

    const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );
  });
}

test('a marked pin is drawn above the pin it overlaps, and above the page (FRU-299, FRU-326)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, 'pins-marked-stack');
  await plant(page, '[data-testid="card-espresso"] .add', 'The pin to mark');
  await plant(page, '[data-testid="card-latte"] .add', 'The pin over it');
  const pins = page.locator('[data-fruitback-pin]');
  await expect(pins).toHaveCount(2);

  // The first pin in the order of the page: with equal z-indexes, the second would be drawn over it.
  const first = (await pins.first().getAttribute('data-fruitback-pin'))!;
  const second = (await pins.nth(1).getAttribute('data-fruitback-pin'))!;
  const marked = await page.evaluate(
    (id) =>
      (globalThis as unknown as { fruitbackWidget: { markNote(id: string): boolean } }).fruitbackWidget.markNote(id),
    first,
  );
  expect(marked).toBe(true);
  await expect(pins.first()).toHaveAttribute('data-fruitback-marked', '');

  // The second pin is put where the first is, so that the two drops overlap fully.
  const hit = await page.evaluate(
    ([one, two]) => {
      const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
      const under = root.querySelector(`[data-fruitback-pin="${one}"]`) as HTMLElement;
      const over = root.querySelector(`[data-fruitback-pin="${two}"]`) as HTMLElement;
      over.style.left = under.style.left;
      over.style.top = under.style.top;
      over.style.width = under.style.width;
      over.style.height = under.style.height;
      for (const name of ['--fruitback-pin-tip-x', '--fruitback-pin-tip-y', '--fruitback-pin-slot']) {
        over.style.setProperty(name, under.style.getPropertyValue(name));
      }
      const box = under.querySelector('.fruitback-pin-badge')!.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const top = root.elementFromPoint(x, y);
      const atPage = document.elementFromPoint(x, y);

      return {
        pin: top?.closest('[data-fruitback-pin]')?.getAttribute('data-fruitback-pin') ?? null,
        // From the page, the topmost element is the host of the widget, not an element of the page.
        host: atPage === document.querySelector('[data-fruitback-host]'),
        zMarked: Number(getComputedStyle(under).zIndex),
        zOther: Number(getComputedStyle(over).zIndex),
      };
    },
    [first, second],
  );
  expect(hit.zMarked).toBeGreaterThan(hit.zOther);
  expect(hit.pin).toBe(first);
  expect(hit.host).toBe(true);
});
