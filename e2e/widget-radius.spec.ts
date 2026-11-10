import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * A button or a tag with a word in it is not a pill: its corners take a quarter to a third of the
 * height it draws, so a control of 34 px and a tag of 28 px keep their sides (2026-11-10). A round
 * element as wide as it is tall (a count, an avatar, the pin of a note) is a circle, not a pill.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/**
 * The pill by design: the capsule of the dock and « Leave a note » in it. The frame of the element
 * takes the corners of the element of the site, and the drop of a pin is a shape.
 */
const ROUND = ['fruitback-dock', 'fruitback-launch', 'fruitback-highlight', 'fruitback-pin-badge'];

async function mount(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/?widget=off&case=${caseOf('widget-radius')}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  await page.getByRole('button', { name: 'Leave a note' }).waitFor();
}

/** The buttons and the tags with a word in them whose corners take half of the height they draw. */
function pills(page: Page): Promise<string[]> {
  return page.evaluate((round) => {
    const found: string[] = [];
    const walk = (root: ShadowRoot) => {
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if (element.shadowRoot) walk(element.shadowRoot);
        const name = element.classList[0] ?? '';
        if (round.includes(name) || element.getClientRects().length === 0) continue;
        if ((element.textContent ?? '').trim() === '') continue;
        const style = getComputedStyle(element);
        if (style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopColor === 'rgba(0, 0, 0, 0)') continue;
        // A transparent border is room to press, not drawing: the corner is what is left inside it.
        const room = style.borderTopColor === 'rgba(0, 0, 0, 0)' ? parseFloat(style.borderTopWidth) : 0;
        const box = element.getBoundingClientRect();
        const drawn = box.height - 2 * room;
        if (box.width <= drawn * 1.3) continue;
        const vertical = style.borderTopLeftRadius.split(' ').at(-1) ?? '0';
        const corner = parseFloat(vertical) - room;
        if (drawn > 0 && Math.min(corner, drawn / 2) >= drawn * 0.45) found.push(`${name} (${Math.round(drawn)} px)`);
      }
    };
    for (const host of document.querySelectorAll<HTMLElement>('[data-fruitback-host]'))
      if (host.shadowRoot) walk(host.shadowRoot);
    return [...new Set(found)];
  }, ROUND);
}

test('no button and no tag of the widget is a pill, in the composer, the thread, the list and the settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mount(page);
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('The price of the latte is wrong');
  expect(await pills(page)).toEqual([]);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
  await page
    .getByRole('button', { name: /The price of the latte/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeVisible();
  expect(await pills(page)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  await page.getByRole('button', { name: 'Search and options' }).click();
  await expect(page.getByRole('button', { name: /^All/ })).toBeVisible();
  expect(await pills(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
  await expect(page.getByRole('button', { name: 'Copy the notes as text' })).toBeVisible();
  expect(await pills(page)).toEqual([]);
});
