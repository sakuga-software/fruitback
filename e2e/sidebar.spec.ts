import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The list of every note of the page (FRU-129), on the widget as `init` assembles it.
 *
 * The playground builds the widget part by part and does not have the list, so this spec loads the
 * built script, like `package.spec.ts`.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
}

async function plant(page: Page, card: string, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator(`[data-testid="${card}"] .add`).click();
  await page.getByPlaceholder('What is wrong here?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(note) }).first()).toBeVisible();
  // The popover stays open in its sent state for a moment.
  await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden({ timeout: 5_000 });
}

test('the list shows every note, and a note chosen there opens its thread', async ({ page }) => {
  await mount(page, 'sidebar');
  const open = page.getByRole('button', { name: 'Show every note of this page' });
  const list = page.getByRole('dialog', { name: 'Every note of this page' });

  // Empty first: the control for the two entries below.
  await open.click();
  await expect(list.getByText('No note on this page yet.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(open).toBeFocused();

  await plant(page, 'card-espresso', 'First note of the list');
  await plant(page, 'card-mocha', 'Second note of the list');

  await open.click();
  const entries = list.locator('[data-fruitback-note]');
  await expect(entries).toHaveCount(2);
  await expect(list.getByText('2 notes')).toBeVisible();
  await expect(entries.first()).toBeFocused();

  // Choosing a note opens its thread, and the list stays for the next one.
  await entries.filter({ hasText: 'Second note of the list' }).click();
  const thread = page.getByRole('dialog', { name: /^Feedback / });
  await expect(thread).toContainText('Second note of the list');
  await expect(list).toBeVisible();

  // Escape closes the thread and gives focus back to the entry. A second Escape closes the list.
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
  await expect(entries.filter({ hasText: 'Second note of the list' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
});

test('a note far down the page is brought into view when it is chosen', async ({ page }) => {
  await mount(page, 'sidebar-scroll');
  const target = page.locator('#checkout-cta');
  await target.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await target.click();
  await page.getByPlaceholder('What is wrong here?').fill('A note far down');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden({ timeout: 5_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(target).not.toBeInViewport();

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  await page.getByRole('dialog', { name: 'Every note of this page' }).locator('[data-fruitback-note]').click();

  await expect(target).toBeInViewport();
  await expect(page.getByRole('dialog', { name: /^Feedback / })).toContainText('A note far down');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing in the list, in the ${scheme} scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mount(page, `sidebar-axe-${scheme}`);
    await plant(page, 'card-latte', `Seen by axe, ${scheme}`);
    await page.getByRole('button', { name: 'Show every note of this page' }).click();
    await expect(page.getByRole('dialog', { name: 'Every note of this page' })).toBeVisible();

    const scan = async (): Promise<string[]> => {
      const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();

      return results.violations.flatMap((violation) =>
        violation.nodes.map((node) => `${violation.id} on ${node.target.join(' ')}`),
      );
    };

    expect(await scan()).toEqual([]);

    // The control for the empty list: a byline as pale as the surface must be a finding.
    await page.locator('[data-fruitback-host]').evaluate((host) => {
      (host as HTMLElement).style.setProperty('--fruitback-color-text-muted', '#bbb');
      (host as HTMLElement).style.setProperty('--fruitback-color-surface', '#ccc');
    });
    expect((await scan()).filter((line) => line.startsWith('color-contrast'))).not.toEqual([]);
  });
}
