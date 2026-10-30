import { expect, test } from '@playwright/test';
import { openPlayground, plantPin, status } from './pin.ts';

/**
 * The config panel (FRU-14), in a browser that has a real Shadow root and a real localStorage.
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

  const closed = page.locator('[name="stage-closed"]');
  await expect(closed).toBeChecked();
  await closed.uncheck();

  await page.reload();
  await page.getByLabel('Open Fruitback settings').click();

  await expect(page.locator('[name="stage-closed"]')).not.toBeChecked();
});

test('the panel holds no field to type in (FRU-89)', async ({ page }) => {
  // Where the notes go is the word of the site, not of whoever opens the panel on it.
  await openPlayground(page, 'config-no-field');
  await page.getByLabel('Open Fruitback settings').click();

  const controls = page.locator(`${panel} input`);
  // The count first, or a panel with no control at all passes the check below.
  await expect(controls).not.toHaveCount(0);
  expect(
    await controls.evaluateAll((nodes) => [...new Set(nodes.map((node) => (node as HTMLInputElement).type))]),
  ).toEqual(['checkbox']);
  await expect(page.locator(`${panel}`).getByRole('textbox')).toHaveCount(0);
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
  await page.addStyleTag({ content: 'input { outline: 8px solid blue !important; margin: 40px !important; }' });

  await page.getByLabel('Open Fruitback settings').click();
  const styles = (node: Element) => {
    const computed = getComputedStyle(node);

    return { outline: computed.outlineWidth, margin: computed.marginTop };
  };

  // The rule is live: an input of the page takes it. Without this, the check below proves nothing.
  const ofThePage = await page.evaluate(() => {
    const input = document.createElement('input');
    document.body.append(input);
    const computed = getComputedStyle(input);
    const seen = { outline: computed.outlineWidth, margin: computed.marginTop };
    input.remove();

    return seen;
  });
  expect(ofThePage).toEqual({ outline: '8px', margin: '40px' });

  const ofThePanel = await page.locator('[name="stage-done"]').evaluate(styles);
  expect(ofThePanel.outline).not.toBe('8px');
  expect(ofThePanel.margin).not.toBe('40px');
});

test('pointing at the settings button never captures it', async ({ page }) => {
  // The widget already excludes itself from hit testing. Since FRU-303 the gear stands aside while a
  // capture runs, in the dark capsule: it cannot be pointed at, and it opens the settings after it.
  await openPlayground(page, 'config-ignore');
  const gear = page.getByLabel('Open Fruitback settings');

  await page.getByRole('button', { name: /Leave a note/ }).click();
  await expect(gear).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await gear.click();

  await expect(page.locator(panel)).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toBeHidden();
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
  // rather than on `waitForPins` is the point of the test: the worker still returns the note — the
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

  // The box of a status is drawn as a chip since FRU-305: the chip is what must be drawn, with the
  // drop of its colour, while its box stays checkable over it.
  const chip = page.locator('.fruitback-config-chip').filter({ has: page.locator('[name="stage-done"]') });
  await expect(chip).toBeVisible();
  expect(await chip.locator('.fruitback-config-chip-drop').evaluate((node) => (node as HTMLElement).offsetWidth)).toBe(
    9,
  );
  await expect(page.locator('[name="stage-done"]')).toBeChecked();

  // The gear sits beside the launch button, whose width is the embedder's label. An offset computed
  // from the gear's own size cannot know that, and it covered the label.
  const gear = await page.getByLabel('Open Fruitback settings').boundingBox();
  const launch = await page.getByRole('button', { name: /Leave a note/ }).boundingBox();

  expect(gear, 'the gear should be on screen').not.toBeNull();
  expect(launch).not.toBeNull();
  expect(gear!.x + gear!.width, 'the gear ends before the launch button starts').toBeLessThanOrEqual(launch!.x);
});

test('the settings have the chips and the switches of the mock-up of 2026-10-20 (FRU-305)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'config-chips');
  await page.getByLabel('Open Fruitback settings').click();
  const root = page.locator(panel);
  await expect(root).toBeVisible();
  const read = (selector: string, properties: string[]) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, names) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();

        return {
          width: box.width,
          height: box.height,
          ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
        } as Record<string, string | number>;
      }, properties);

  expect(await read(panel, ['border-top-left-radius', 'border-top-width', 'box-shadow'])).toMatchObject({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
    'box-shadow': 'rgba(0, 0, 0, 0.18) 0px 10px 30px 0px',
  });
  // The head: the drop of the mark in the accent, « Settings », the cross « Close settings ».
  await expect(root.locator('.fruitback-config-title')).toHaveText('Settings');
  expect(await read('.fruitback-config-head', ['padding', 'border-bottom-width'])).toMatchObject({
    padding: '14px 12px 12px 16px',
    'border-bottom-width': '1px',
  });
  expect(await read('.fruitback-config-close', [])).toMatchObject({ width: 44, height: 44 });

  // « Pins shown »: a chip of 30 px for each status, in a target of 44 px. Shown: the sunken fill.
  const chip = '.fruitback-config-chip';
  expect(await read(chip, ['background-color', 'font-size', 'font-weight', 'border-top-width'])).toMatchObject({
    height: 44,
    'border-top-width': '7px',
    'background-color': 'rgb(244, 244, 245)',
    'font-size': '12px',
    'font-weight': '600',
  });
  // The drop is turned: its own box is 9 px.
  expect(
    await page
      .locator('.fruitback-config-chip-drop')
      .first()
      .evaluate((node) => (node as HTMLElement).offsetWidth),
  ).toBe(9);
  // A click on the chip is a click on its box: the status is hidden, and the chip turns white.
  const closed = root.locator(chip).filter({ hasText: 'Closed' });
  await closed.click();
  await expect(page.locator('[name="stage-closed"]')).not.toBeChecked();
  expect(await closed.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  await closed.click();
  await expect(page.locator('[name="stage-closed"]')).toBeChecked();

  // The switches: 36 × 20, a role that says on and off, the whole row of 44 px toggles them.
  const hide = page.getByRole('switch', { name: 'Hide resolved notes' });
  await expect(hide).toBeVisible();
  expect(
    await hide.evaluate((node) => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]),
  ).toEqual([36, 20]);
  expect(await read('.fruitback-config-check', [])).toMatchObject({ height: 44 });
  await root.locator('.fruitback-config-check').filter({ hasText: 'Hide resolved notes' }).click();
  await expect(hide).toBeChecked();
  expect(await hide.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(24, 24, 27)');
  await hide.click();
  await expect(hide).not.toBeChecked();
});
