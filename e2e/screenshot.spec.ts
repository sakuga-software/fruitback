import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, openPlayground } from './pin.ts';

/**
 * The optional picture (SKG-495), in a browser — the only place the full path is reachable.
 *
 * `init` uses react-grab's hit testing to decide what was clicked, and happy-dom has neither
 * `elementsFromPoint` nor layout, so the unit tests stop at the setting itself. Everything that
 * happens *after* the reporter turns it on is here.
 *
 * The capture function is the embedder's, so these mount the built widget with one of our own —
 * which is also what a host does.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** Mount the published bundle with a capture function whose behaviour the test chooses. */
async function mountWith(
  page: import('@playwright/test').Page,
  capture: 'ok' | 'throws' | 'nothing' | 'urlless',
) {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ([endpoint, mode]) => {
      const capturers = {
        ok: async () => ({ url: 'https://cdn.test/shot.png', width: 120, height: 40 }),
        throws: async () => {
          throw new Error('SecurityError: tainted canvas');
        },
        nothing: async () => undefined,
        // Type-invalid on purpose: a JavaScript embedder can do this, and the widget has to refuse
        // rather than store a screenshot nobody can open.
        urlless: async () => ({ width: 120, height: 40 }),
      } as const;

      (globalThis as { Fruitback: { init(options: unknown): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: '🌱 Feedback',
        captureScreenshot: capturers[mode as keyof typeof capturers],
      });
    },
    [WORKER_ORIGIN, capture] as const,
  );

  // The setting is off by default; a reporter turns it on in the panel, so the test does too.
  await page.getByLabel('Ouvrir les réglages Fruitback').click();
  await page.locator('[name="screenshot"]').check();
  await page.getByLabel('Ouvrir les réglages Fruitback').click();
}

async function plant(page: import('@playwright/test').Page, note: string) {
  await page.getByRole('button', { name: '🌱 Feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill(note);
  await page.getByRole('button', { name: 'Planter' }).click();
  await expect(page.locator('[data-fruit-pin]')).toHaveCount(1);
}

/** What the worker actually stored, which is the only thing that settles this. */
async function storedScreenshot(page: import('@playwright/test').Page) {
  return page.evaluate(async (origin) => {
    const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
    const { issues } = (await response.json()) as { issues: { seed: { screenshot?: unknown } }[] };

    return issues[0]?.seed.screenshot;
  }, WORKER_ORIGIN);
}

test('a picture reaches the seed when the host can take one', async ({ page }) => {
  await page.goto('/?widget=off&case=shot-ok');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountWith(page, 'ok');

  await plant(page, 'Avec une image');

  expect(await storedScreenshot(page)).toEqual({ url: 'https://cdn.test/shot.png', width: 120, height: 40 });
});

test('a capture that throws costs the picture, never the note', async ({ page }) => {
  // A canvas tainted by a cross-origin image is the ordinary failure, not the exotic one. Losing
  // what someone just wrote over it would be the one thing this widget cannot afford.
  await page.goto('/?widget=off&case=shot-throws');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountWith(page, 'throws');

  await plant(page, 'Sans image, mais planté');

  expect(await storedScreenshot(page)).toBeUndefined();
});

test('a host that returns nothing leaves the field out entirely', async ({ page }) => {
  // `undefined` is a refusal, not an empty picture: the seed round-trip forbids a key nobody gave.
  await page.goto('/?widget=off&case=shot-nothing');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountWith(page, 'nothing');

  await plant(page, 'Le host a décliné');

  expect(await storedScreenshot(page)).toBeUndefined();
});

test('the setting is not offered when the host cannot take a picture', async ({ page }) => {
  await page.goto('/?widget=off&case=shot-absent');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: unknown): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: '🌱 Feedback',
      }),
    WORKER_ORIGIN,
  );

  await page.getByLabel('Ouvrir les réglages Fruitback').click();

  await expect(page.locator('[name="screenshot"]')).toHaveCount(0);
});

test('a capture with no URL is refused rather than stored', async ({ page }) => {
  // `SeedScreenshot` leaves `url` optional — the field was speculative before anything filled it —
  // so the seam requires it in TypeScript and checks it at runtime, because this package ships to
  // JavaScript too. A screenshot with no URL is a row in a Linear issue that opens nothing.
  await page.goto('/?widget=off&case=shot-urlless');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountWith(page, 'urlless');

  await plant(page, 'Une image sans adresse');

  expect(await storedScreenshot(page)).toBeUndefined();
});
