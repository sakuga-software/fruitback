import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * The widget without a pointer, and under axe-core (SKG-544).
 *
 * The unit tests hold the key handling. These hold what happy-dom cannot show: that a real browser
 * moves focus where the handlers say, and that the real page does not scroll away or press a button.
 */

async function walkTo(page: Page, target: Locator): Promise<void> {
  const highlight = page.locator('[data-fruitback-host-highlight]');
  for (let step = 0; step < 400; step += 1) {
    await page.keyboard.press('ArrowDown');
    const [want, got] = await Promise.all([target.boundingBox(), highlight.boundingBox()]);
    if (want !== null && got !== null && Math.abs(want.x - got.x) < 2 && Math.abs(want.y - got.y) < 2) {
      if (Math.abs(want.width - got.width) < 2 && Math.abs(want.height - got.height) < 2) return;
    }
  }
  throw new Error('the keyboard cursor never reached the target');
}

test('a note can be planted with the keyboard alone', async ({ page }) => {
  await openPlayground(page, 'keyboard-plant');
  const launch = page.getByRole('button', { name: /Leave feedback/ });

  await launch.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-fruitback-host]')).toHaveAttribute('data-fruitback-capturing', '');
  await expect(page.locator('[data-fruitback-announcer]')).toContainText('arrow keys');

  await walkTo(page, page.locator('#checkout-cta'));
  await expect(page.locator('[data-fruitback-announcer]')).toContainText(/^button: /);
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Leave a note' });
  const field = page.getByPlaceholder('What is wrong here?');
  await expect(dialog).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');

  await page.keyboard.type('Planté sans souris');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Plant', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(dialog).toBeHidden({ timeout: 5_000 });
  await expect(launch).toBeFocused();
});

test('Escape leaves the capture mode without scrolling the page or pressing anything', async ({ page }) => {
  await openPlayground(page, 'keyboard-escape');
  await page.getByRole('button', { name: /Leave feedback/ }).focus();
  await page.keyboard.press('Enter');
  const scrolled = await page.evaluate(() => window.scrollY);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-fruitback-host]')).not.toHaveAttribute('data-fruitback-capturing');
  await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden();
});

test('the settings dialog holds focus, and gives it back to the gear', async ({ page }) => {
  await openPlayground(page, 'keyboard-settings');
  const gear = page.getByRole('button', { name: 'Open Fruitback settings' });

  await gear.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Fruitback settings' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('[name="endpoint"]')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('checkbox', { name: 'Hide resolved feedback' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(gear).toBeFocused();
});

test('the thread takes focus, and gives it back to its pin', async ({ page }) => {
  await openPlayground(page, 'keyboard-thread');
  await plantPin(page, page.locator('#checkout-cta'), 'Lu au clavier');
  const badge = badgeFor(page, 'Lu au clavier');

  await badge.focus();
  await page.keyboard.press('Enter');
  const thread = page.getByRole('dialog', { name: /^Feedback / });
  await expect(thread).toBeVisible();
  await expect(thread.getByRole('button', { name: 'Close' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
  await expect(badge).toBeFocused();
});

/** The accent fails 4.5:1 on white and on the dark surface, and waits for a design decision (`contrast.test.ts`). */
const ACCENT = '#e53935';

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing but the accent in the widget, in each state, in the ${scheme} scheme`, async ({
    page,
  }) => {
    // Axe reads the colours as painted, and an opening animation paints them at part opacity.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openPlayground(page, `axe-${scheme}`);
    const cta = page.locator('#checkout-cta');
    const note = `Vu par axe, ${scheme}`;
    await plantPin(page, cta, note);

    const violations: string[] = [];
    const accent: string[] = [];
    const scan = async (state: string) => {
      // Scoped to the widget: the playground's own markup is not what this ticket audits.
      const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
      for (const violation of results.violations) {
        for (const node of violation.nodes) {
          const data = node.any[0]?.data as { fgColor?: string; bgColor?: string } | undefined;
          const line = `${state}: ${violation.id} on ${node.target.join(' ')} ${JSON.stringify(data ?? '')}`;
          const onAccent = data?.fgColor === ACCENT || data?.bgColor === ACCENT;
          if (violation.id === 'color-contrast' && onAccent) accent.push(line);
          else violations.push(line);
        }
      }
    };

    await scan('resting');

    await page.getByRole('button', { name: /Leave feedback/ }).click();
    await page.keyboard.press('ArrowDown');
    await scan('capturing');
    await page.keyboard.press('Escape');

    await badgeFor(page, note).click();
    await expect(page.getByRole('dialog', { name: /^Feedback / })).toBeVisible();
    await scan('thread');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Fruitback settings' })).toBeVisible();
    await scan('settings');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /Leave feedback/ }).click();
    await cta.click();
    await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeVisible();
    await scan('composer');

    expect(violations).toEqual([]);
    // The control for the filter: if the accent passes one day, the filter must go.
    expect(accent.length, 'the accent passes now: remove ACCENT and its filter').toBeGreaterThan(0);
  });
}
