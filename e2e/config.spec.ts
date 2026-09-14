import { expect, test } from '@playwright/test';
import { openPlayground, plantPin, status } from './pin.ts';

/**
 * The config panel (SKG-503), in a browser that has a real Shadow root and a real localStorage.
 *
 * What is checked here and not in `node --test`: that the settings survive a reload, and that hiding
 * a stage actually removes the pin the client can see.
 */

const panel = '[data-fruitback-config]';

test('the settings open from the floating button and survive a reload', async ({ page }) => {
  await openPlayground(page, 'config');

  await expect(page.locator(panel)).toBeHidden();
  await page.getByLabel('Open Fruitback settings').click();
  await expect(page.locator(panel)).toBeVisible();

  // The client id is what the worker routes on, so it is the setting worth proving persists.
  const client = page.locator('[name="client"]');
  await expect(client).toHaveValue('playground');
  await client.fill('acme');

  await page.reload();
  await page.getByLabel('Open Fruitback settings').click();

  await expect(page.locator('[name="client"]')).toHaveValue('acme');

  // Put it back: the worker refuses an unknown client, and the suite shares one process.
  await page.locator('[name="client"]').fill('playground');
});

test('hiding a stage takes its pin off the page, and showing it puts it back', async ({ page }) => {
  await openPlayground(page, 'config-filter');
  const button = page.locator('[data-testid="card-latte"] .add');

  await plantPin(page, button, 'Un pin qui va être masqué');
  // Read the stage rather than assume it: it is the Linear workflow state that decides, and this
  // suite runs against whatever the fake Linear opens an issue in.
  const stage = await page.locator('[data-fruitback-pin]').first().getAttribute('data-fruitback-stage');
  const box = page.locator(`[name="stage-${stage}"]`);

  await page.getByLabel('Open Fruitback settings').click();
  await box.uncheck();

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);

  // And back from the issues already held — no reload, no second request.
  await box.check();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test('the panel belongs to the widget, so the page cannot restyle it', async ({ page }) => {
  await openPlayground(page, 'config-isolation');
  await page.addStyleTag({ content: 'input { background: lime !important; border: 8px solid blue !important; }' });

  await page.getByLabel('Open Fruitback settings').click();
  const background = await page
    .locator('[name="client"]')
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  expect(background).not.toBe('rgb(0, 255, 0)');
});

test('pointing at the settings button never captures it', async ({ page }) => {
  // The widget already excludes itself from hit testing; the gear is new chrome inside the same
  // Shadow root, so this is the assertion that it was not forgotten.
  await openPlayground(page, 'config-ignore');

  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.getByLabel('Open Fruitback settings').click();

  await expect(page.locator(panel)).toBeVisible();
  await expect(page.getByPlaceholder('What is wrong here?')).toBeHidden();
});

test('a stage hidden before the pins arrive is never drawn', async ({ page }) => {
  await openPlayground(page, 'config-before');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Planté puis masqué au chargement');
  const stage = await page.locator('[data-fruitback-pin]').first().getAttribute('data-fruitback-stage');

  await page.getByLabel('Open Fruitback settings').click();
  await page.locator(`[name="stage-${stage}"]`).uncheck();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);

  // The preference is read before the first render, not applied after it. Waiting on the status
  // rather than on `waitForPins` is the point of the test: the worker still returns the seed — the
  // status says so — and the widget draws nothing.
  await page.reload();
  await expect(status(page)).toHaveText(/^1 pin$/);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);

  await page.getByLabel('Open Fruitback settings').click();
  await page.locator(`[name="stage-${stage}"]`).check();
});

test('the checkboxes are actually drawn, and the gear does not sit on the launch button', async ({ page }) => {
  // Both of these were found by looking at a recording, and neither is visible to a DOM emulator.
  await openPlayground(page, 'config-visuals');
  await page.getByLabel('Open Fruitback settings').click();

  // `all: initial` resets `appearance` to its initial value, which is `none` — a native checkbox
  // then draws nothing while staying perfectly checkable.
  const box = page.locator('[name="stage-ripe"]');
  await expect(box).toBeVisible();
  expect(await box.evaluate((node) => getComputedStyle(node).appearance)).not.toBe('none');

  // The gear sits beside the launch button, whose width is the embedder's label. An offset computed
  // from the gear's own size cannot know that, and it covered the label.
  const gear = await page.getByLabel('Open Fruitback settings').boundingBox();
  const launch = await page.getByRole('button', { name: /Leave feedback/ }).boundingBox();

  expect(gear, 'the gear should be on screen').not.toBeNull();
  expect(launch).not.toBeNull();
  expect(gear!.x + gear!.width, 'the gear ends before the launch button starts').toBeLessThanOrEqual(launch!.x);
});

test('a slow read from an old endpoint never overwrites a newer one', async ({ page }) => {
  // The panel writes on every keystroke, so correcting a client id fires several reads. Nothing
  // makes them settle in the order they were sent — a wrong host can take longer to fail than a
  // right one takes to answer — and the late one would then have the last word.
  await openPlayground(page, 'config-race');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Le pin qui doit rester');

  // The stale read is made deliberately slow, which is what turns a race into a test.
  await page.route('**/feedback?*', async (route) => {
    if (route.request().url().includes('client=stale')) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.abort('failed');

      return;
    }
    await route.continue();
  });

  await page.getByLabel('Open Fruitback settings').click();
  const client = page.locator('[name="client"]');

  // Far enough apart to be two reads rather than one debounced read.
  await client.fill('stale');
  await page.waitForTimeout(600);
  await client.fill('playground');

  // The correct read lands first and says so.
  await expect(status(page)).toHaveText(/^1 pin$/);

  // And the stale one, failing a second later, is ignored rather than allowed to report an
  // unreachable worker over a page that is perfectly fine.
  await page.waitForTimeout(2000);
  await expect(status(page)).toHaveText(/^1 pin$/);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});
