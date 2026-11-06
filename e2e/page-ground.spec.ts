import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * A dark site and a red site (FRU-611, P7, `page-ground.ts`), on the widget as `init` mounts it, at
 * 1440 and 390 px, in both schemes of the system. The ground is read when the widget mounts and at
 * each start of a capture.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const INK = 'rgb(24, 24, 27)';

async function mountOn(page: Page, testCase: string, ground: string | undefined): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  if (ground !== undefined) await page.addStyleTag({ content: `html, body { background: ${ground} !important; }` });
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
  await page.locator('[data-fruitback-host-launch]').waitFor();
}

/** The computed styles of an element of the Shadow root. */
const styleOf = (page: Page, selector: string, names: string[]) =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (node, properties) =>
        Object.fromEntries(properties.map((name) => [name, getComputedStyle(node).getPropertyValue(name)])),
      names,
    );

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390] as const) {
    test(`on a dark site the widget keeps its surfaces apart from the page, at ${width} px, ${scheme} scheme (FRU-611)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await mountOn(page, `ground-dark-${scheme}-${width}`, '#111827');
      const host = page.locator('[data-fruitback-host]');

      await expect(host).toHaveAttribute('data-fruitback-ground', 'dark');
      await expect(host).not.toHaveAttribute('data-fruitback-faint', /.*/);
      // A white line at 16 % around the dock, under a denser shadow.
      expect((await styleOf(page, '.fruitback-dock', ['box-shadow']))['box-shadow']).toContain(
        'rgba(255, 255, 255, 0.16) 0px 0px 0px 1px',
      );

      // The frame of an element takes a light halo.
      await page.locator('[data-fruitback-host-launch]').click();
      await page.locator('[data-testid="card-latte"] .add').hover();
      await expect(page.locator('.fruitback-highlight')).toBeVisible();
      expect((await styleOf(page, '.fruitback-highlight', ['box-shadow']))['box-shadow']).toBe(
        'rgba(255, 255, 255, 0.55) 0px 0px 0px 3px',
      );

      // The composer, a popover or the sheet of a phone, has the line too.
      await page.locator('[data-testid="card-latte"] .add').click();
      await expect(page.locator('[data-fruitback-composer]')).toBeVisible();
      expect((await styleOf(page, '[data-fruitback-composer]', ['box-shadow']))['box-shadow']).toContain(
        'rgba(255, 255, 255, 0.16) 0px 0px 0px 1px',
      );
    });

    test(`on a red site the frame, its name and the pins take the ink, at ${width} px, ${scheme} scheme (FRU-611)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await mountOn(page, `ground-red-${scheme}-${width}`, '#dd2c27');
      await expect(page.locator('[data-fruitback-host]')).toHaveAttribute('data-fruitback-faint', '');

      await page.locator('[data-fruitback-host-launch]').click();
      await page.locator('[data-testid="card-latte"] .add').hover();
      await expect(page.locator('.fruitback-highlight')).toBeVisible();
      expect(await styleOf(page, '.fruitback-highlight', ['border-top-color', 'box-shadow'])).toEqual({
        'border-top-color': INK,
        'box-shadow': 'rgb(255, 255, 255) 0px 0px 0px 2px',
      });

      // A note planted there: its drop has the edge of ink and the white contour.
      await page.locator('[data-testid="card-latte"] .add').click();
      await page.locator('[data-fruitback-note]:visible').fill(`On a red site, ${scheme} ${width}`);
      await page.locator('[data-fruitback-send]').click();
      await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
      await expect(page.locator('.fruitback-pin-badge').first()).toBeVisible();
      expect(await styleOf(page, '.fruitback-pin-badge', ['border-top-color', 'box-shadow'])).toEqual({
        'border-top-color': INK,
        'box-shadow': 'rgb(255, 255, 255) 0px 0px 0px 2px',
      });
    });
  }
}

for (const [name, css, expected] of [
  // Tailwind 4 computes oklch: a slate 950, and a red 600.
  ['an oklch dark ground', 'body { background: oklch(0.129 0.042 264.695) !important; }', 'dark'],
  ['an oklch red ground', 'body { background: oklch(0.577 0.245 27.325) !important; }', 'faint'],
  ['a color(srgb) dark ground', 'body { background: color(srgb 0.07 0.09 0.15) !important; }', 'dark'],
  // A body at 90 % black over a transparent root, and over a white one.
  ['a dark ground with alpha', 'body { background: rgb(0 0 0 / 90%) !important; }', 'dark'],
] as const) {
  test(`reads ${name} (review of #859)`, async ({ page }) => {
    await page.goto(`/?widget=off&case=${caseOf(`ground-notation-${name.replaceAll(' ', '-')}`)}`);
    await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
    await page.addStyleTag({ content: `html { background: transparent !important; } ${css}` });
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
    const host = page.locator('[data-fruitback-host]');
    if (expected === 'dark') await expect(host).toHaveAttribute('data-fruitback-ground', 'dark');
    else await expect(host).toHaveAttribute('data-fruitback-faint', '');
  });
}

test('on a white site nothing changes: no ground, no ink (FRU-611, the control)', async ({ page }) => {
  await mountOn(page, 'ground-white', undefined);
  const host = page.locator('[data-fruitback-host]');
  await expect(host).not.toHaveAttribute('data-fruitback-ground', /.*/);
  await expect(host).not.toHaveAttribute('data-fruitback-faint', /.*/);
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-latte"] .add').hover();
  await expect(page.locator('.fruitback-highlight')).toBeVisible();
  expect((await styleOf(page, '.fruitback-highlight', ['border-top-color']))['border-top-color']).not.toBe(INK);
});

test('a site that turns dark after the widget mounted is read again at the next capture (FRU-611)', async ({
  page,
}) => {
  await mountOn(page, 'ground-later', undefined);
  const host = page.locator('[data-fruitback-host]');
  await expect(host).not.toHaveAttribute('data-fruitback-ground', /.*/);
  await page.addStyleTag({ content: 'html, body { background: #0b0b0f !important; }' });
  await page.locator('[data-fruitback-host-launch]').click();
  await expect(host).toHaveAttribute('data-fruitback-ground', 'dark');
});
