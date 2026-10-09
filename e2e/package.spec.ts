import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, storedSeeds } from './pin.ts';

/**
 * The built widget on a page, mounted the way a client site mounts it (FRU-16).
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
        // An emoji on purpose: a host's label is the host's word, and FRU-36 took our emoji out of
        // the widget's own chrome without starting to filter theirs. `screenshot.spec.ts` mounts
        // with the same label and exercises the same promise. What changed is the *documented*
        // snippet further down, which no longer suggests one.
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
  await expect(page.getByLabel('Open Fruitback settings')).toBeVisible();
});

test('the tag mounts the widget, follows its attributes, and takes it away with itself (FRU-126)', async ({ page }) => {
  await page.goto('/?widget=off&case=element');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  // The script a page with no build step loads: it holds the widget and registers the tag.
  await page.addScriptTag({ path: 'packages/element/dist/fruitback-element.iife.js' });
  await page.evaluate((endpoint) => {
    const element = document.createElement('fruitback-widget');
    element.setAttribute('endpoint', endpoint);
    element.setAttribute('client-id', 'playground');
    element.setAttribute('locale', 'en-US');
    element.setAttribute('label', 'From a tag');
    document.body.append(element);
  }, WORKER_ORIGIN);

  await expect(page.getByRole('button', { name: 'From a tag' })).toBeVisible();
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);

  await page.evaluate(() => document.querySelector('fruitback-widget')?.setAttribute('label', 'Renamed'));
  await expect(page.getByRole('button', { name: 'Renamed' })).toBeVisible();
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);

  // The control for the count above: with the element gone, nothing of the widget stays.
  await page.evaluate(() => document.querySelector('fruitback-widget')?.remove());
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
});

test('the tag keeps the options a page set before its script ran (FRU-126)', async ({ page }) => {
  await page.goto('/?widget=off&case=element-early-options');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  // The tag is in the page first, as with a deferred script, and the page already gave it options.
  await page.evaluate((endpoint) => {
    const element = document.createElement('fruitback-widget') as HTMLElement & { options?: unknown };
    element.setAttribute('endpoint', endpoint);
    element.setAttribute('client-id', 'playground');
    element.setAttribute('locale', 'en-US');
    element.options = { messages: { en: { 'launch.label': 'Set before the script' } } };
    document.body.append(element);
  }, WORKER_ORIGIN);

  await page.addScriptTag({ path: 'packages/element/dist/fruitback-element.iife.js' });

  await expect(page.getByRole('button', { name: 'Set before the script' })).toBeVisible();
});

test('a host catalog reaches the built widget, over the bundled one, key by key (FRU-37, FRU-38)', async ({ page }) => {
  await page.goto('/?widget=off&case=script-tag-locale');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'fr',
        // French is bundled since FRU-38. The host's own word wins over it, and a key the host leaves
        // out comes from the bundled French rather than from English.
        messages: { fr: { 'launch.label': 'Donner mon avis' } },
      }),
    WORKER_ORIGIN,
  );

  await expect(page.getByRole('button', { name: 'Donner mon avis' })).toBeVisible();
  await page.getByLabel('Ouvrir les réglages Fruitback').click();
  await expect(page.getByRole('dialog', { name: 'Réglages Fruitback' })).toBeVisible();
});

test('the snippet plants a note and reads it back, through its own transport', async ({ page }) => {
  // `init` owns the two fetches now. This is the only test that exercises them: everywhere else the
  // playground does the posting.
  await page.goto('/?widget=off&case=script-tag-write');
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mountFromScriptTag(page);

  await page.getByRole('button', { name: '🌱 Feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What is wrong here?').fill('Planté par le snippet');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

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
  await page.getByPlaceholder('What is wrong here?').fill('Sur la page des formules');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await page.getByRole('link', { name: 'Commander' }).click();
  await page.getByRole('heading', { name: 'Votre commande' }).waitFor();

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
});

/**
 * The documented tag, served from the built file, with the attributes a site wrote on it.
 *
 * `addScriptTag` cannot set attributes, so the auto-mount was only ever asserted against the built
 * source (FRU-16). Playwright can serve the real file from disk, which lets the documented tag be
 * the documented tag.
 */
async function plantFromTheDocumentedTag(
  page: import('@playwright/test').Page,
  testCase: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  await page.route('**/fruitback.iife.js', (route) =>
    route.fulfill({ path: IIFE, contentType: 'application/javascript' }),
  );

  await page.goto(`/?widget=off&case=${testCase}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();

  await page.evaluate(
    ({ endpoint, extra }) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.acme.dev/fruitback.iife.js';
      script.dataset.fruitbackEndpoint = endpoint;
      script.dataset.fruitbackClient = 'playground';
      script.dataset.fruitbackLabel = 'Leave feedback';
      for (const [name, value] of Object.entries(extra)) script.setAttribute(name, value);
      script.defer = true;
      document.head.append(script);
    },
    { endpoint: WORKER_ORIGIN, extra: attributes },
  );

  // Nothing called `init`: the tag configured itself.
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // And it is a working widget, not just a button.
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What is wrong here?').fill('Planté par le snippet du README');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
}

test('the documented snippet mounts on its own, from its data attributes', async ({ page }) => {
  await plantFromTheDocumentedTag(page, 'snippet');

  // The tag asked for nothing more, so the browser of the reporter is not in the note (FRU-84).
  const [seed] = await storedSeeds(page);
  expect(seed?.env).toBeUndefined();
});

test('a tag sends the environment of the reporter only when it says so (FRU-84)', async ({ page }) => {
  // The control for the absence above: the same tag, with the one attribute that turns it on.
  await plantFromTheDocumentedTag(page, 'snippet-env', { 'data-fruitback-include-env': 'true' });

  const [seed] = await storedSeeds(page);
  expect(seed?.env?.userAgent).toEqual(expect.stringContaining('Mozilla'));
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
