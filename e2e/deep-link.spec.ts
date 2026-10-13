import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A link that opens a note on its page (FRU-253), on the widget as `init` assembles it.
 *
 * The console writes `<page>#fruitback-note=<id>` under « Show on the page ». What only a browser
 * shows: a real address bar, a real `replaceState`, and focus that really moves.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, address: string): Promise<void> {
  // Through a blank page: an address that differs by its fragment alone loads nothing, and the
  // widget of the page before would still be there.
  await page.goto('about:blank');
  await page.goto(address);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      ((globalThis as unknown as { widget: unknown }).widget = (
        globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }
      ).Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US' })),
    WORKER_ORIGIN,
  );
}

/** Plant a note by the parts of the composer, and give back the id the worker keeps it under. */
async function plant(page: Page, selector: string, note: string): Promise<string> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-composer] textarea').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 5_000 });

  return page.evaluate(
    async ([origin, text]) => {
      const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
      const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
      const { issues } = (await response.json()) as { issues: { seed: { id: string; note: string } }[] };

      return issues.find((issue) => issue.seed.note === text)?.seed.id ?? '';
    },
    [WORKER_ORIGIN, note] as const,
  );
}

const thread = (page: Page) => page.locator('[data-fruitback-thread]');

test('a link opens the note on its page, scrolls to it, and leaves the address without its part', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  const address = `/?widget=off&case=deep-link-${test.info().retry}`;
  await mount(page, address);
  await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
  const id = await plant(page, '#checkout-cta', 'Opened by its link');
  expect(id).not.toBe('');

  // The control first: a fragment of the site opens nothing, and is still there afterwards.
  await mount(page, `${address}#formules`);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(thread(page)).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#formules');

  // The link, as the console writes it. The note is at the foot of the page.
  await mount(page, `${address}#fruitback-note=${id}`);
  await expect(thread(page)).toContainText('Opened by its link');
  await expect(page.locator('#checkout-cta')).toBeInViewport();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe(new URL(address, page.url()).search);
  // Focus is in the thread, as after a click on its pin, and Escape gives it back to the pin.
  await expect(page.locator('.fruitback-thread-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(thread(page)).toHaveCount(0);
  await expect(page.locator('.fruitback-pin-badge')).toBeFocused();
  // A reload does not open it again: the address no longer asks for it.
  await mount(page, page.url());
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(thread(page)).toHaveCount(0);

  // With a fragment of the site before it: the note opens, and the site keeps its part.
  await mount(page, `${address}#formules&fruitback-note=${id}`);
  await expect(thread(page)).toContainText('Opened by its link');
  await expect.poll(() => new URL(page.url()).hash).toBe('#formules');

  // An id this page does not have: nothing opens, the address is cleared, and the console stays quiet.
  await mount(page, `${address}#fruitback-note=sd_not_here`);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await expect(thread(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a link that arrives while somebody writes closes nothing, and opens once the note is sent', async ({ page }) => {
  const address = `/?widget=off&case=deep-link-writing-${test.info().retry}`;
  await mount(page, address);
  const id = await plant(page, '[data-testid="card-espresso"] .add', 'The note the link names');

  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-mocha"] .add').click();
  const field = page.locator('[data-fruitback-composer] textarea');
  await field.fill('Half a note');
  const host = await page.evaluateHandle(() => document.querySelector('[data-fruitback-host]'));

  await page.evaluate((note) => (window.location.hash = `#fruitback-note=${note}`), id);

  await expect(page.locator('[data-fruitback-composer]')).toBeVisible();
  await expect(field).toHaveValue('Half a note');
  await expect(field).toBeFocused();
  await expect(thread(page)).toHaveCount(0);
  // The widget was not mounted a second time.
  expect(await page.evaluate((first) => document.querySelector('[data-fruitback-host]') === first, host)).toBe(true);

  // Sent: once the composer has closed, the note the address still asks for opens.
  await page.locator('[data-fruitback-send]').click();
  await expect(thread(page)).toContainText('The note the link names');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});
