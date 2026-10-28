import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * The corner of the dock (FRU-443): the `position` option of `init`, and `moveDock` of the handle.
 * The settings open from the corner of the dock, and a move builds no new widget: a note being
 * written stays.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;

async function mount(page: Page, testCase: string, position?: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, position }) => {
      const scope = globalThis as unknown as {
        Fruitback: { init(options: Record<string, unknown>): unknown };
        widget: unknown;
      };
      scope.widget = scope.Fruitback.init({
        endpoint,
        clientId: 'playground',
        ...(position === undefined ? {} : { position }),
      });
    },
    { endpoint: WORKER_ORIGIN, position },
  );
  await page.mouse.move(0, 0);
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not on the screen`);

  return box;
}

/** The gaps between a box and the four sides of the window. */
function gaps(page: Page, box: Box): { top: number; right: number; bottom: number; left: number } {
  const { width, height } = page.viewportSize()!;

  return {
    top: Math.round(box.y),
    right: Math.round(width - box.x - box.width),
    bottom: Math.round(height - box.y - box.height),
    left: Math.round(box.x),
  };
}

for (const corner of CORNERS) {
  test(`the dock stands in the ${corner} corner, and the settings open from it`, async ({ page }) => {
    await mount(page, `dock-${corner}`, corner);
    const [vertical, horizontal] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];

    const dock = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
    expect(dock[vertical]).toBe(24);
    expect(dock[horizontal]).toBe(24);

    await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
    const settings = gaps(page, await boxOf(page, '.fruitback-panel-config'));
    expect(settings[vertical]).toBe(84);
    expect(settings[horizontal]).toBe(16);
  });
}

test('with no position the dock stays at the bottom right, and a corner it does not know changes nothing', async ({
  page,
}) => {
  await mount(page, 'dock-default');
  const resting = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
  expect([resting.bottom, resting.right]).toEqual([24, 24]);

  await mount(page, 'dock-unknown', 'middle');
  const unknown = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
  expect([unknown.bottom, unknown.right]).toEqual([24, 24]);
});

test('moveDock moves the dock with no new widget: the note being written stays', async ({ page }) => {
  await mount(page, 'dock-move');
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Written before the move');

  await page.evaluate(() =>
    (globalThis as unknown as { widget: { moveDock(position: string): void } }).widget.moveDock('top-left'),
  );
  const moved = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
  expect([moved.top, moved.left]).toEqual([24, 24]);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Written before the move');
});

test('the reporter moves the dock from the settings, and the corner is kept on this site (FRU-472)', async ({
  page,
}) => {
  await mount(page, 'dock-settings', 'bottom-right');
  await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
  const group = page.getByRole('radiogroup', { name: 'Position' });
  await expect(group.getByRole('radio', { name: 'Bottom right' })).toBeChecked();

  await group.getByRole('radio', { name: 'Top left' }).check();
  const moved = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
  expect([moved.top, moved.left]).toEqual([24, 24]);
  // The settings follow the dock to its corner, and stay open on the choice.
  const settings = gaps(page, await boxOf(page, '.fruitback-panel-config'));
  expect([settings.top, settings.left]).toEqual([84, 16]);
  await expect(group.getByRole('radio', { name: 'Top left' })).toBeFocused();

  // The page asks for the bottom right again: the reporter's choice wins.
  await mount(page, 'dock-settings', 'bottom-right');
  const kept = gaps(page, await boxOf(page, '[data-fruitback-dock]'));
  expect([kept.top, kept.left]).toEqual([24, 24]);
});

test('axe finds nothing on the widget in the top left corner, with its settings open', async ({ page }) => {
  await mount(page, 'dock-axe', 'top-left');
  await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
  const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
