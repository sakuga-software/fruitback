import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The built widget on a page, mounted the way a client site mounts it (SKG-505).
 *
 * Every other spec drives the widget the playground assembled by hand. This one loads `dist` — the
 * two files that are actually published — and lets the snippet do the assembling, because a package
 * whose `dist` is broken has a green suite and ships nothing.
 */

// Relative to the repo root, which is where Playwright runs. `import.meta.url` is not available:
// the specs are compiled to CommonJS, and it becomes a `require` that throws before any test loads.
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/**
 * Load the built global, then mount.
 *
 * The published snippet reads its endpoint off the tag's `data-` attributes, and `addScriptTag`
 * cannot set those — so what runs here is the global and `init`, not the auto-mount. That last step
 * is asserted against the built source in `package.test.ts`; everything below is the real file
 * executing on a real page.
 */
async function mountFromScriptTag(page: import('@playwright/test').Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: '🌱 Feedback',
      }),
    WORKER_ORIGIN,
  );
}

test('a script tag mounts the widget, with no build step on the page', async ({ page }) => {
  // A bare page: no playground glue, no React, nothing but what the snippet brings.
  await page.goto('/?widget=off&case=script-tag');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();

  await mountFromScriptTag(page);

  // The label came off the tag, which is the whole of the configuration a snippet carries.
  await expect(page.getByRole('button', { name: '🌱 Feedback' })).toBeVisible();
  await expect(page.getByLabel('Ouvrir les réglages Fruitback')).toBeVisible();
});

test('the snippet plants a note and reads it back, through its own transport', async ({ page }) => {
  // `init` owns the two fetches now. This is the only test that exercises them: everywhere else the
  // playground does the posting.
  await page.goto('/?widget=off&case=script-tag-write');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountFromScriptTag(page);

  await page.getByRole('button', { name: '🌱 Feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Planté par le snippet');
  await page.getByRole('button', { name: 'Planter' }).click();

  // The pin appears because `init` re-read after writing, not because anything told it to.
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // And it survives a reload, which is the read path answering on a page the widget mounted itself.
  await page.reload();
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountFromScriptTag(page);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test('a client-side navigation changes which pins are on screen', async ({ page }) => {
  // No framework to ask: `init` patches `history` and listens for `popstate`, because a pin belongs
  // to a URL and `pushState` fires no event of its own.
  await page.goto('/?widget=off&case=script-tag-nav');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountFromScriptTag(page);

  await page.getByRole('button', { name: '🌱 Feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Sur la page des formules');
  await page.getByRole('button', { name: 'Planter' }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await page.getByRole('link', { name: 'Commander' }).click();
  await page.getByRole('heading', { name: 'Votre commande' }).waitFor();

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
});

test('the documented snippet mounts on its own, from its data attributes', async ({ page }) => {
  // The one path SKG-505 shipped unverified in a browser: `addScriptTag` cannot set attributes, so
  // the auto-mount was only ever asserted against the built source. Playwright can serve the real
  // file from disk, which lets the documented tag be the documented tag.
  await page.route('**/fruitback.iife.js', (route) =>
    route.fulfill({ path: IIFE, contentType: 'application/javascript' }),
  );

  await page.goto('/?widget=off&case=snippet');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();

  await page.evaluate((endpoint) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.acme.dev/fruitback.iife.js';
    script.dataset.fruitbackEndpoint = endpoint;
    script.dataset.fruitbackClient = 'playground';
    script.dataset.fruitbackLabel = '🌱 Leave feedback';
    script.defer = true;
    document.head.append(script);
  }, WORKER_ORIGIN);

  // Nothing called `init`: the tag configured itself.
  await expect(page.getByRole('button', { name: '🌱 Leave feedback' })).toBeVisible();

  // And it is a working widget, not just a button.
  await page.getByRole('button', { name: '🌱 Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Planté par le snippet du README');
  await page.getByRole('button', { name: 'Planter' }).click();

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test('a half-configured tag leaves the page alone', async ({ page }) => {
  // Documented behaviour: it auto-mounts only when **both** `endpoint` and `client` are on the tag.
  // A widget that mounted with one of them missing would post nowhere and look broken, so the tag
  // here carries an endpoint and no client — the near miss, not the empty case.
  await page.route('**/fruitback.iife.js', (route) =>
    route.fulfill({ path: IIFE, contentType: 'application/javascript' }),
  );

  await page.goto('/?widget=off&case=snippet-bare');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();

  await page.evaluate((endpoint) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.acme.dev/fruitback.iife.js';
    script.dataset.fruitbackEndpoint = endpoint;
    document.head.append(script);
  }, WORKER_ORIGIN);

  // Waited for rather than assumed: the tag loads asynchronously, and asserting before it ran would
  // pass for the wrong reason — nothing mounted because nothing had executed yet.
  await page.waitForFunction(() => 'Fruitback' in globalThis);

  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  // The global is there for a site with its own bootstrap; it simply did not mount itself.
  expect(await page.evaluate(() => typeof (globalThis as { Fruitback?: { init?: unknown } }).Fruitback?.init)).toBe(
    'function',
  );
});
