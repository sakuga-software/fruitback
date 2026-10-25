import { type Page, expect } from '@playwright/test';
import { addRule, openBareSite, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Corner of the widget » of the preferences (FRU-443): the corner of the dock on every site. The
 * widget of a tab already open moves at once, with no new widget, so a note being written stays;
 * a page loaded after the change mounts in that corner.
 */

declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };

/** The gaps between the dock and the four sides of the window. */
async function dockGaps(site: Page): Promise<{ top: number; right: number; bottom: number; left: number }> {
  const box = await site.locator('[data-fruitback-dock]').boundingBox();
  if (box === null) throw new Error('no dock on the page');
  const { width, height } = site.viewportSize()!;

  return {
    top: Math.round(box.y),
    right: Math.round(width - box.x - box.width),
    bottom: Math.round(height - box.y - box.height),
    left: Math.round(box.x),
  };
}

test('the corner chosen in the preferences moves the widget of an open tab, keeps the note being written, and holds after a reload', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const site = await extension.context.newPage();
  await openBareSite(site, 'ext-dock-corner');
  await expect(site.locator('[data-fruitback-dock]')).toBeVisible();
  expect(await dockGaps(site)).toMatchObject({ bottom: 24, right: 24 });
  // A note being written, which the move must not lose.
  await site.locator('[data-fruitback-host-launch]').click();
  await site.locator('[data-testid="card-latte"] .add').click();
  await site.getByPlaceholder('What should change?').fill('Written before the move');

  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html#prefs`);
  const corner = options.locator('section#prefs').getByRole('combobox', { name: 'Corner of the widget' });
  await expect(corner).toHaveValue('bottom-right');
  // Reached by the keyboard: the control after « Show CSS selectors ».
  await options.locator('section#prefs').getByRole('switch', { name: 'Show CSS selectors' }).focus();
  await options.keyboard.press('Tab');
  await expect(corner).toBeFocused();
  await corner.selectOption('top-left');
  await expect
    .poll(() => extension.worker.evaluate(async () => (await chrome.storage.local.get('dockPosition')).dockPosition))
    .toBe('top-left');

  await expect.poll(() => dockGaps(site)).toMatchObject({ top: 24, left: 24 });
  await expect(site.getByPlaceholder('What should change?')).toHaveValue('Written before the move');

  await site.reload();
  await expect(site.locator('[data-fruitback-dock]')).toBeVisible();
  await expect.poll(() => dockGaps(site)).toMatchObject({ top: 24, left: 24 });

  // Back to the default: no key kept, and the dock back in its corner.
  await corner.selectOption('bottom-right');
  await expect
    .poll(() =>
      extension.worker.evaluate(async () => 'dockPosition' in (await chrome.storage.local.get('dockPosition'))),
    )
    .toBe(false);
  await expect.poll(() => dockGaps(site)).toMatchObject({ bottom: 24, right: 24 });
});
