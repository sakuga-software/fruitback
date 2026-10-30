import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN, hydrated } from './pin.ts';

/**
 * The note being written survives a reload, Esc, « Cancel » and the cross (FRU-311), on the widget
 * as `init` assembles it: the extension mounts that one. The playground assembles the parts itself.
 *
 * The reload mounts the widget again, as a page or the extension does at each load: it has to find
 * the element again and open the composer on it, with the text, by itself.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  // The widget and the elements a spec adds come after React: see `lateElementAndRead`.
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
      }),
    WORKER_ORIGIN,
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

async function openPlayground(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await mount(page);
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await mount(page);
}

const NOTE = 'Le prix du Latte devrait être 18 €, pas 19 €.';
const field = (page: Page) => page.getByPlaceholder('What should change?');
const status = (page: Page) => page.locator('[data-fruitback-status]');

async function writeOnTheLatte(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await field(page).fill(note);
}

test('a reload opens the composer again on its element, with the text and « Draft restored »', async ({ page }) => {
  await openPlayground(page, 'autosave-reload');
  await writeOnTheLatte(page, NOTE);

  await reload(page);

  await expect(field(page)).toHaveValue(NOTE);
  await expect(field(page)).toBeFocused();
  await expect(status(page)).toHaveText('Draft restored');
  // On the element it was written about: the frame of the capture holds the Latte's button.
  await expect(page.getByRole('dialog', { name: 'New note' })).toContainText('button.add');

  // Sent, it is gone: the next reload opens nothing.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
  await reload(page);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(field(page)).toBeHidden();
});

for (const [way, leave] of [
  ['Esc', (page: Page) => page.keyboard.press('Escape')],
  ['Cancel', (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true }).click()],
] as const) {
  test(`after ${way}, the same element gives the text back`, async ({ page }) => {
    await openPlayground(page, `autosave-${way.replace(' ', '-')}`);
    await writeOnTheLatte(page, NOTE);
    await leave(page);
    await expect(field(page)).toBeHidden();

    await page.getByRole('button', { name: /Leave feedback/ }).click();
    await page.locator('[data-testid="card-latte"] .add').click();

    await expect(field(page)).toHaveValue(NOTE);
    await expect(status(page)).toHaveText('Draft restored');
  });
}

test('another element opens empty, and a composer left with nothing typed saves nothing', async ({ page }) => {
  await openPlayground(page, 'autosave-witness');
  await writeOnTheLatte(page, NOTE);
  await page.keyboard.press('Escape');

  // Another element: its own, empty field.
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('#checkout-cta').click();
  await expect(field(page)).toHaveValue('');
  await expect(status(page)).toHaveText('');
  await page.keyboard.press('Escape');

  // The witness: nothing typed on the checkout, so the tab holds the Latte's text alone.
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fruitback:config:typing') ?? '[]'));
  expect(saved).toHaveLength(1);
  expect(saved[0].text).toBe(NOTE);
});

// Review of #372: a text whose element came late must not reopen over a note the person already
// left on this visit, at a later read that finds that element.
async function mountWithLateText(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  // A text saved for an element that is not on the page when the widget mounts.
  await page.evaluate(() => {
    const anchor = {
      selector: '#late',
      domPath: 'main > button#late',
      tag: 'button',
      text: 'Plus tard',
      bounds: { xPct: 1, yPct: 1, wPct: 5, hPct: 3 },
    };
    // The address as `canonicalizePageUrl` writes it: no fragment, the parameters sorted.
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.sort();
    sessionStorage.setItem(
      'fruitback:config:typing',
      JSON.stringify([{ page: url.toString(), anchor, text: 'Un texte de tout à l’heure', at: Date.now() }]),
    );
  });
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const global = globalThis as unknown as {
      Fruitback: { init(options: Record<string, string>): unknown };
      widget: unknown;
    };
    global.widget = global.Fruitback.init({ endpoint, clientId: 'playground' });
  }, WORKER_ORIGIN);
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

/**
 * The element of the saved text arrives, and a read runs, awaited to its end.
 *
 * Only once React has hydrated the page (`mountWithLateText` waits for it). The server sends the page
 * whole, so its heading is visible before React runs. A button added to `main` before that is a
 * hydration mismatch: React renders the page again on the client, and the button is gone, with
 * the host of the widget beside it. Under load it happened about one run in five with four workers,
 * and the composer never opened (« element(s) not found »), or the retry timed out.
 */
async function lateElementAndRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const late = document.createElement('button');
    late.id = 'late';
    late.textContent = 'Plus tard';
    document.querySelector('main')?.append(late);
  });
  await page.evaluate(() => (globalThis as unknown as { widget: { refresh(): Promise<void> } }).widget.refresh());
}

// The control: the same page with no note left first does reopen the text, so the absence below
// is measured on a path that opens the composer when nothing stops it.
test('a saved text whose element comes late reopens at the read that finds it', async ({ page }) => {
  await mountWithLateText(page, 'autosave-late-control');
  await lateElementAndRead(page);

  await expect(field(page)).toHaveValue('Un texte de tout à l’heure');
  await expect(status(page)).toHaveText('Draft restored');
});

test('a saved text does not reopen by itself once the person chose an element on the page', async ({ page }) => {
  await mountWithLateText(page, 'autosave-late');
  // Another note, on another element, sent.
  await writeOnTheLatte(page, 'Une autre note');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 5_000 });

  await lateElementAndRead(page);

  // The control above opened the composer within this same read. Two seconds is that, with room.
  await expect(field(page)).toBeHidden();
  await page.waitForTimeout(2_000);
  await expect(field(page)).toBeHidden();
});
