import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, openPlayground, plantPin } from './pin.ts';

/**
 * The dock of the mock-up of 2026-10-20 (FRU-303): one capsule that holds the detached notes, the
 * list, the gear and the launch button, and that turns dark while a capture runs.
 *
 * Measured on the computed styles, with the animations off: a capsule mid-transition is not the one
 * the mock-up draws.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** The widget as `init` assembles it, from the built script: the playground has no button of the list. */
async function mount(page: Page, testCase: string, locale = 'en-US', messages?: Record<string, string>) {
  const attempt = test.info().retry;
  await page.goto(`/?widget=off&case=${attempt === 0 ? testCase : `${testCase}-retry${attempt}`}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, locale, messages }) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale,
        ...(messages === undefined ? {} : { messages: { [locale]: messages } }),
      }),
    { endpoint: WORKER_ORIGIN, locale, messages },
  );
  await page.mouse.move(0, 0);
}

type Painted = Record<string, string | number>;

function painted(locator: Locator, names: string[]): Promise<Painted> {
  return locator.evaluate((element, properties) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();

    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      ...Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)])),
    };
  }, names);
}

const dockOf = (page: Page) => page.locator('[data-fruitback-dock]');

test('the capsule has the measures of the mock-up, and every control in it is 44 px', async ({ page }) => {
  await mount(page, 'dock-capsule');
  const viewport = page.viewportSize()!;
  const list = page.getByRole('button', { name: 'Show every note in a sidebar' });
  const gear = page.getByRole('button', { name: 'Open Fruitback settings' });
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  await expect(launch).toBeVisible();

  const capsule = await painted(dockOf(page), [
    'background-color',
    'border-top-width',
    'border-top-color',
    'border-top-left-radius',
    'box-shadow',
  ]);
  // 24 px from the right and the bottom, 52 px tall: 5 px around a launch button of 40 px.
  expect(viewport.width - (Number(capsule.x) + Number(capsule.width))).toBe(24);
  expect(viewport.height - (Number(capsule.y) + Number(capsule.height))).toBe(24);
  expect(capsule).toMatchObject({
    height: 52,
    'background-color': 'rgb(255, 255, 255)',
    'border-top-width': '1px',
    'border-top-color': 'rgb(228, 228, 231)',
    'border-top-left-radius': '999px',
    'box-shadow': 'rgba(0, 0, 0, 0.25) 0px 4px 18px 0px',
  });

  // The list, then the gear, then the launch button, all inside the capsule.
  const [listBox, gearBox, launchBox] = await Promise.all([list, gear, launch].map((each) => each.boundingBox()));
  expect(listBox!.x).toBeLessThan(gearBox!.x);
  expect(gearBox!.x).toBeLessThan(launchBox!.x);
  for (const box of [listBox!, gearBox!, launchBox!]) {
    expect(Math.round(box.height)).toBe(44);
    expect(box.x).toBeGreaterThanOrEqual(Number(capsule.x));
    expect(box.x + box.width).toBeLessThanOrEqual(Number(capsule.x) + Number(capsule.width));
  }
  for (const round of [listBox!, gearBox!]) expect(Math.round(round.width)).toBe(44);

  // The launch button draws a pill of 40 px inside a border of 2 px that only widens its target.
  expect(
    await painted(launch, [
      'background-color',
      'background-clip',
      'border-top-width',
      'border-top-color',
      'color',
      'font-size',
      'font-weight',
      'padding-left',
      'padding-right',
      'column-gap',
    ]),
  ).toMatchObject({
    'background-color': 'rgb(221, 44, 39)',
    'background-clip': 'padding-box',
    'border-top-width': '2px',
    'border-top-color': 'rgba(0, 0, 0, 0)',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
    'padding-left': '14px',
    'padding-right': '18px',
    'column-gap': '8px',
  });
  const drop = await launch.locator('svg').boundingBox();
  expect([Math.round(drop!.width), Math.round(drop!.height)]).toEqual([11, 14]);
  // The pill ends 5 px from the end of the capsule, as in the mock-up.
  expect(Math.round(Number(capsule.x) + Number(capsule.width) - (launchBox!.x + launchBox!.width))).toBe(1 + 3);

  // The list and the gear: a drawing on the capsule, and no fill until the pointer is on them.
  for (const [round, size] of [
    [list, 18],
    [gear, 17],
  ] as const) {
    expect(await painted(round, ['background-color', 'color', 'border-top-width'])).toMatchObject({
      'background-color': 'rgba(0, 0, 0, 0)',
      color: 'rgb(82, 82, 91)',
      'border-top-width': '4px',
    });
    const icon = await round.locator('svg').boundingBox();
    expect(Math.round(icon!.width)).toBe(size);
  }
  await gear.hover();
  await expect
    .poll(async () => (await painted(gear, ['background-color']))['background-color'])
    .toBe('rgb(244, 244, 245)');
});

test('a capture plays end to end inside the capsule, with the mouse and then with the keyboard (FRU-303)', async ({
  page,
}) => {
  await mount(page, 'dock-capture-path');
  const host = page.locator('[data-fruitback-host]');
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  const dock = dockOf(page);
  const banner = page.locator('[data-fruitback-host-banner]');
  const frame = page.locator('[data-fruitback-host-highlight]');
  const dialog = page.getByRole('dialog', { name: 'New note' });
  const target = page.locator('[data-testid="card-latte"] .add');
  // The way out is named by its word alone: the key drawn beside it is not part of its name.
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });

  // With the mouse: the capsule turns dark and holds the banner, the frame names the element under
  // the pointer, and a click chooses it.
  await launch.click();
  await expect(host).toHaveAttribute('data-fruitback-capturing', '');
  await expect(dock.locator('[data-fruitback-host-banner]')).toHaveCount(1);
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(page.locator('.fruitback-banner-key')).toHaveText('Esc');
  await target.hover();
  await expect(frame).toBeVisible();
  await expect(page.locator('.fruitback-highlight-tag')).toHaveText(/^button\.add/);
  await target.click();
  await expect(dialog).toBeVisible();
  // The choice ends the capture: the capsule is light again, its banner empty, its button back.
  await expect(host).not.toHaveAttribute('data-fruitback-capturing', '');
  await expect(banner).toBeEmpty();
  await expect(launch).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // With the keyboard: Enter on the launch button, the arrows to an element, Enter to choose it.
  await launch.focus();
  await page.keyboard.press('Enter');
  await expect(host).toHaveAttribute('data-fruitback-capturing', '');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(frame).toBeVisible();
  await expect(page.locator('[data-fruitback-announcer]')).not.toBeEmpty();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toBeFocused();
  await expect(host).not.toHaveAttribute('data-fruitback-capturing', '');
  // Closed with no note, focus goes back to the launch button, which is drawn again.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(launch).toBeVisible();
  await expect(launch).toBeFocused();

  // And « Cancel » with the keyboard, from a third capture: no dialog, focus on the launch button.
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(host).not.toHaveAttribute('data-fruitback-capturing', '');
  await expect(dialog).toBeHidden();
  await expect(launch).toBeVisible();
  await expect(launch).toBeFocused();
});

test('a capture turns the capsule dark, and Escape gives it back with focus on the launch button', async ({ page }) => {
  await mount(page, 'dock-capturing');
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  const dock = dockOf(page);
  const viewport = page.viewportSize()!;

  await launch.click();
  await expect(page.locator('[data-fruitback-host][data-fruitback-capturing]')).toHaveCount(1);
  // The launch button, the list and the gear stand aside; focus moved to the way out.
  await expect(launch).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Fruitback settings' })).toBeHidden();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();

  const capsule = await painted(dock, ['background-color', 'border-top-color']);
  expect(capsule).toMatchObject({
    height: 46,
    'background-color': 'rgb(24, 24, 27)',
    'border-top-color': 'rgb(24, 24, 27)',
  });
  // Still in its corner.
  expect(viewport.width - (Number(capsule.x) + Number(capsule.width))).toBe(24);
  expect(viewport.height - (Number(capsule.y) + Number(capsule.height))).toBe(24);

  const ask = page.locator('.fruitback-banner-ask');
  await expect(ask).toHaveText('Point at an element, or use the arrow keys');
  // A click in the dark capsule, beside its button, is a click on the widget: it chooses nothing,
  // and the capture goes on.
  await ask.click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden();
  await expect(page.locator('[data-fruitback-host][data-fruitback-capturing]')).toHaveCount(1);
  expect(await painted(ask, ['color', 'font-size'])).toMatchObject({
    color: 'rgb(212, 212, 216)',
    'font-size': '12px',
  });
  expect(
    await painted(cancel, [
      'background-color',
      'background-clip',
      'border-top-width',
      'color',
      'font-size',
      'font-weight',
    ]),
  ).toMatchObject({
    height: 44,
    'background-color': 'rgb(63, 63, 70)',
    'background-clip': 'padding-box',
    // A pill of 36 px inside a target of 44 px.
    'border-top-width': '4px',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
  });
  const key = page.locator('.fruitback-banner-key');
  await expect(key).toHaveText('Esc');
  expect(
    await painted(key, [
      'font-size',
      'font-weight',
      'border-top-width',
      'border-bottom-width',
      'border-top-left-radius',
    ]),
  ).toMatchObject({
    'font-size': '11px',
    'font-weight': '700',
    'border-top-width': '1px',
    'border-bottom-width': '2px',
    'border-top-left-radius': '4px',
  });

  await page.keyboard.press('Escape');
  await expect(launch).toBeVisible();
  await expect(launch).toBeFocused();
  await expect(launch).toHaveAttribute('aria-pressed', 'false');
  expect(await painted(dock, ['background-color'])).toMatchObject({
    height: 52,
    'background-color': 'rgb(255, 255, 255)',
  });
});

test('in the dark scheme the capsule is on the dark surface, and the capture keeps its ink', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await mount(page, 'dock-dark');
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  expect(await painted(dockOf(page), ['background-color', 'border-top-color'])).toMatchObject({
    'background-color': 'rgb(24, 24, 27)',
    'border-top-color': 'rgb(63, 63, 70)',
  });
  expect(await painted(launch, ['background-color', 'color'])).toMatchObject({
    'background-color': 'rgb(236, 106, 101)',
    color: 'rgb(24, 24, 27)',
  });
  expect(await painted(page.getByRole('button', { name: 'Open Fruitback settings' }), ['color'])).toMatchObject({
    color: 'rgb(212, 212, 216)',
  });
  await launch.click();
  expect(await painted(dockOf(page), ['background-color'])).toMatchObject({ 'background-color': 'rgb(24, 24, 27)' });
  await expect(page.locator('.fruitback-banner-ask')).toHaveCSS('color', 'rgb(212, 212, 216)');
});

test('in French it says « Laisser une note », and « Annuler » with the key « Échap »', async ({ page }) => {
  await mount(page, 'dock-fr', 'fr-FR');
  const launch = page.getByRole('button', { name: 'Laisser une note' });
  await expect(launch).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voir toutes les notes dans un panneau' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ouvrir les réglages Fruitback' })).toBeVisible();
  await launch.click();
  await expect(page.locator('.fruitback-banner-ask')).toHaveText('Pointez un élément, ou utilisez les flèches');
  await expect(page.locator('.fruitback-banner-key')).toHaveText('Échap');
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeFocused();
  // The capsule still fits its corner with the longer words.
  const capsule = await painted(dockOf(page), []);
  expect(Number(capsule.x)).toBeGreaterThanOrEqual(0);
});

test('in a right-to-left language the capsule sits 24 px from the left', async ({ page }) => {
  await mount(page, 'dock-rtl', 'ar', { 'launch.label': 'اترك ملاحظة' });
  await expect(page.locator('[data-fruitback-host]')).toHaveAttribute('dir', 'rtl');
  const capsule = await painted(dockOf(page), []);
  expect(capsule.x).toBe(24);
  // The launch button is at the inline end, which is the left.
  const [launch, gear] = await Promise.all([
    page.getByRole('button', { name: 'اترك ملاحظة' }).boundingBox(),
    page.getByRole('button', { name: 'Open Fruitback settings' }).boundingBox(),
  ]);
  expect(launch!.x).toBeLessThan(gear!.x);
});

test('a narrow window keeps the capture capsule inside it, and every control at 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, 'dock-narrow');
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  const capsule = await painted(dockOf(page), []);
  expect(Number(capsule.x)).toBeGreaterThanOrEqual(0);
  expect(Number(capsule.x) + Number(capsule.width)).toBeLessThanOrEqual(390 - 24);
  const cancel = await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
  expect(Math.round(cancel!.height)).toBe(44);
});

/** The boxes of two elements overlap, by more than a rounding. */
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;

test('the detached notes are the first control of the capsule, and overlap nothing', async ({ page }) => {
  await openPlayground(page, 'dock-detached');
  await plantPin(page, page.locator('#email-field'), 'Sur un champ qui va disparaître du dock');
  await page.evaluate(() => document.querySelector('#email-field')?.remove());

  const drawer = page.locator('[data-fruitback-orphans]');
  const chip = drawer.locator('.fruitback-orphans-toggle');
  await expect(chip).toHaveText('1 detached');
  const dock = dockOf(page);
  // In the capsule, first.
  expect(await drawer.evaluate((node) => node.parentElement?.firstElementChild === node)).toBe(true);
  expect(await drawer.evaluate((node) => node.parentElement?.hasAttribute('data-fruitback-dock'))).toBe(true);

  expect(
    await painted(chip, [
      'background-color',
      'background-clip',
      'border-top-width',
      'color',
      'font-size',
      'font-weight',
    ]),
  ).toMatchObject({
    height: 44,
    // The grey of a note whose element is gone, in a pill of 36 px (FRU-334).
    'background-color': 'rgb(113, 113, 122)',
    'background-clip': 'padding-box',
    'border-top-width': '4px',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
  });
  const drop = await chip.locator('svg').boundingBox();
  expect(Math.round(drop!.width)).toBe(13);

  const boxes = async () => {
    const controls = await dock.evaluate((node) =>
      [...node.querySelectorAll('button')]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => {
          const box = button.getBoundingClientRect();

          return { name: button.textContent ?? '', x: box.x, y: box.y, width: box.width, height: box.height };
        }),
    );

    return controls;
  };
  const overlapping = (controls: Awaited<ReturnType<typeof boxes>>) =>
    controls.flatMap((a, index) =>
      controls
        .slice(index + 1)
        .filter((b) => overlap(a, b))
        .map((b) => `${a.name} × ${b.name}`),
    );

  const controls = await boxes();
  expect(controls.length).toBeGreaterThanOrEqual(2);
  expect(overlapping(controls)).toEqual([]);
  const capsule = (await dock.boundingBox())!;
  for (const control of controls) {
    expect(control.y).toBeGreaterThanOrEqual(capsule.y);
    expect(control.y + control.height).toBeLessThanOrEqual(capsule.y + capsule.height);
  }

  // Axe, on the capsule that holds the chip.
  const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  // The list opens above the capsule, and covers none of it.
  await chip.click();
  const list = (await drawer.locator('.fruitback-orphans-list').boundingBox())!;
  expect(list.y + list.height).toBeLessThanOrEqual(capsule.y);
  // In a low window it stays inside it: its height is the room above the capsule (160 − 104), and
  // never less than one row of 44 px.
  const tall = page.viewportSize()!;
  const listHeight = () =>
    drawer.locator('.fruitback-orphans-list').evaluate((node) => getComputedStyle(node).maxHeight);
  await page.setViewportSize({ width: tall.width, height: 160 });
  expect(await listHeight()).toBe('56px');
  const low = (await drawer.locator('.fruitback-orphans-list').boundingBox())!;
  expect(low.y).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: tall.width, height: 100 });
  expect(await listHeight()).toBe('44px');
  await page.setViewportSize(tall);
  await chip.click();

  // The control: the chip floated as it did before the capsule, 60 px from the bottom, overlaps
  // the launch button. A detector that finds nothing there proves nothing.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'planted';
    style.textContent =
      '.fruitback-orphans[data-fruitback-docked] { position: fixed; bottom: 60px; right: 16px; inset-inline-end: 16px; }';
    document.querySelector('[data-fruitback-host]')?.shadowRoot?.append(style);
  });
  const planted = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
    const chip = root?.querySelector('.fruitback-orphans-toggle')?.getBoundingClientRect();
    const dock = root?.querySelector('[data-fruitback-dock]')?.getBoundingClientRect();

    return chip === undefined || dock === undefined
      ? null
      : {
          chip: { x: chip.x, y: chip.y, width: chip.width, height: chip.height },
          dock: { x: dock.x, y: dock.y, width: dock.width, height: dock.height },
        };
  });
  expect(planted).not.toBeNull();
  expect(overlap(planted!.chip, planted!.dock), 'the planted chip should overlap the capsule').toBe(true);
});

test('in a forced palette every control of the capsule is drawn by the system colours', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await mount(page, 'dock-forced');
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  // The shape of the launch button is a line of the system: its fill is dropped.
  expect(await painted(launch, ['outline-style', 'outline-width', 'outline-offset'])).toMatchObject({
    'outline-style': 'solid',
    'outline-width': '1px',
    'outline-offset': '-3px',
  });
  await launch.click();
  expect(await painted(page.getByRole('button', { name: 'Cancel', exact: true }), ['outline-style'])).toMatchObject({
    'outline-style': 'solid',
  });
});
