import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

/**
 * The bubble of a note moves by its handle, with a dashed line to its pin (FRU-420): by the mouse, by
 * the keyboard, back to its place with a double click, and with its pin when the page scrolls. Only a
 * real browser has pointer capture and layout to measure.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } };
    scope.Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US' });
  }, WORKER_ORIGIN);
}

async function plantAndOpen(page: Page, note: string) {
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
  await page.getByRole('button', { name: new RegExp(`^Note 1, .*${note}`) }).click();
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();

  return thread;
}

/** The bubble and the point of its pin, in the coordinates of the window. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const bubble = root.querySelector('.fruitback-thread')!.getBoundingClientRect();
    const pin = root.querySelector('[data-fruitback-pin][data-fruitback-open]') as HTMLElement;
    const frame = pin.getBoundingClientRect();
    const tether = root.querySelector('.fruitback-thread-tether');

    return {
      left: bubble.left,
      top: bubble.top,
      right: bubble.right,
      tipX: frame.left + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x')),
      tipY: frame.top + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y')),
      tether:
        tether === null
          ? null
          : { style: getComputedStyle(tether).borderTopStyle, start: tether.getBoundingClientRect().toJSON() },
      width: document.documentElement.clientWidth,
    };
  });

const MOVE =
  'Move the note. The arrow keys move it by 16 px, Shift and an arrow by 48 px. Home or a double click puts it back.';

test('the bubble moves by its handle with the mouse and the keyboard, with a dashed line to its pin, and comes back on a double click (FRU-420)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount(page, 'thread-handle');
  const thread = await plantAndOpen(page, 'The bubble hides the card.');
  const handle = thread.getByRole('button', { name: MOVE });
  await expect(handle).toBeVisible();
  // A reply being typed is not lost while the bubble moves.
  const field = thread.getByRole('textbox', { name: 'Reply' });
  await field.fill('Text typed before the move');

  const home = await measure(page);
  expect(home.tether).toBeNull();

  // The mouse, by the handle.
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 120, grip.y + grip.height / 2 + 90, { steps: 8 });
  await page.mouse.up();
  const dragged = await measure(page);
  expect(dragged.left - home.left).toBeCloseTo(-120, 0);
  expect(dragged.top - home.top).toBeCloseTo(90, 0);
  expect(dragged.tether?.style).toBe('dashed');
  await expect(field).toHaveValue('Text typed before the move');
  await expect(thread).toBeVisible();

  // The page scrolls: the bubble follows its pin.
  await page.evaluate(() => window.scrollBy(0, 60));
  await expect.poll(async () => (await measure(page)).tipY).toBeCloseTo(dragged.tipY - 60, 0);
  const scrolled = await measure(page);
  expect(scrolled.top - scrolled.tipY).toBeCloseTo(dragged.top - dragged.tipY, 0);
  expect(scrolled.left - scrolled.tipX).toBeCloseTo(dragged.left - dragged.tipX, 0);

  // A double click on the handle: back to its place, no line.
  await handle.dblclick();
  const back = await measure(page);
  expect(back.left - back.tipX).toBeCloseTo(home.left - home.tipX, 0);
  expect(back.top - back.tipY).toBeCloseTo(home.top - home.tipY, 0);
  expect(back.tether).toBeNull();

  // The keyboard: 16 px with an arrow, 48 px with Shift.
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowDown');
  const keyed = await measure(page);
  expect(keyed.left - back.left).toBeCloseTo(-16, 0);
  expect(keyed.top - back.top).toBeCloseTo(48, 0);
  expect(keyed.tether).not.toBeNull();
  await expect(handle).toBeFocused();
  await page.keyboard.press('Home');
  expect((await measure(page)).tether).toBeNull();

  expect(
    await new AxeBuilder({ page })
      .include('[data-fruitback-host]')
      .analyze()
      .then((r) => r.violations),
  ).toEqual([]);

  // Closed, the move is forgotten.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Note 1, / }).click();
  const reopened = await measure(page);
  expect(reopened.tether).toBeNull();
  expect(reopened.left - reopened.tipX).toBeCloseTo(home.left - home.tipX, 0);
});

test('at 390 px, the bubble stays 8 px inside the window, and a finger on the handle does not scroll the page (FRU-420)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, 'thread-handle-390');
  const thread = await plantAndOpen(page, 'At the width of a phone.');
  const handle = thread.getByRole('button', { name: MOVE });
  expect(await handle.evaluate((element) => getComputedStyle(element).touchAction)).toBe('none');

  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 600, grip.y - 600, { steps: 6 });
  await page.mouse.up();
  const pushed = await measure(page);
  expect(pushed.width - pushed.right).toBeCloseTo(8, 0);
  expect(pushed.top).toBeCloseTo(8, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0,
  );
  expect(
    await new AxeBuilder({ page })
      .include('[data-fruitback-host]')
      .analyze()
      .then((r) => r.violations),
  ).toEqual([]);
});
