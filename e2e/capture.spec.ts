import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, expectPinOn, openPlayground, pinFor, plantPin, storedSeeds, waitForPins } from './pin.ts';

/** Capture → worker → back again, in a browser that does its own layout and its own CSS parsing. */

test('a click plants a pin, and the worker gives it back on reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openPlayground(page, 'capture');
  const button = page.locator('[data-testid="card-latte"] .add');

  await plantPin(page, button, 'Le bouton Ajouter est trop discret');

  const pin = pinFor(page, 'Le bouton Ajouter');
  await expectPinOn(pin, button);
  // Resolved by the selector, not by falling back down the chain.
  await expect(pin).toHaveAttribute('data-fruitback-strategy', 'selector');

  // The reload is the read path: nothing is kept client-side, so a pin that survives it came back
  // from `GET /feedback`.
  await page.reload();
  await waitForPins(page, 1);
  await expectPinOn(pinFor(page, 'Le bouton Ajouter'), button);

  expect(errors).toEqual([]);
});

test('the selector it picked is unique in a real engine, and skips what a redeploy would change', async ({ page }) => {
  await openPlayground(page, 'selector');
  await plantPin(page, page.locator('#checkout-cta'), 'Le CTA devrait être plus large');
  await plantPin(page, page.locator('main header button'), 'Le menu n’est pas assez visible');

  const anchors = await page.evaluate(async (worker) => {
    const url = new URL(window.location.href);
    url.hash = '';
    const response = await fetch(`${worker}/feedback?url=${encodeURIComponent(url.toString())}&client=playground`);
    const { issues } = (await response.json()) as { issues: { seed: { anchor: { selector: string } } }[] };

    return issues.map((issue) => ({
      selector: issue.seed.anchor.selector,
      matches: document.querySelectorAll(issue.seed.anchor.selector).length,
    }));
  }, WORKER_ORIGIN);

  expect(anchors).toHaveLength(2);
  for (const anchor of anchors) expect(anchor.matches, `${anchor.selector} is not unique`).toBe(1);

  const selectors = anchors.map((anchor) => anchor.selector);
  expect(selectors).toContain('[data-testid="checkout-cta"]');
  // The burger carries `id=":r7:"` and an emotion class; both are refused, so the aria-label wins.
  expect(selectors).toContain('button[aria-label="Ouvrir le menu"]');
});

test('a pin below the fold is placed in the document, not in the viewport', async ({ page }) => {
  await openPlayground(page, 'scroll');
  const cta = page.locator('#checkout-cta');
  await cta.scrollIntoViewIfNeeded();

  await plantPin(page, cta, 'Trop bas dans la page');

  // Back to the top and down again: a pin stored in viewport coordinates would have moved.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.reload();
  await waitForPins(page, 1);
  await cta.scrollIntoViewIfNeeded();
  await expectPinOn(pinFor(page, 'Trop bas dans la page'), cta);
});

test('a note carries the component and the file it came from', async ({ page }) => {
  // The reason the playground is a React app at all: `source` is half of what makes a seed useful in
  // Linear, and a static page had no fiber for it to read. Both assertions below failed on the first
  // run against real components — see `engine.ts` and `source.ts`.
  await openPlayground(page, 'source');

  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Le bouton Ajouter est trop discret');
  await plantPin(page, page.getByRole('heading', { name: 'Nos formules' }), 'Ce titre pourrait être plus clair');

  const seeds = await storedSeeds(page);
  const button = seeds.find((seed) => seed.note.startsWith('Le bouton'));
  const heading = seeds.find((seed) => seed.note.startsWith('Ce titre'));

  // A HeroUI button: react-grab reports the react-aria internal that rendered the host node, so the
  // name has to come from the fiber walk while the location still comes from react-grab. `Button`,
  // not `AddToCartButton` — the walk stops at the first component a human named, and that is the one
  // that really rendered this node. Climbing further to reach the app's own component would report
  // `PlanCard` for anything nested, which is less true, not more useful; the file and line already
  // point at `AddToCartButton`'s JSX.
  expect(button?.source).toMatchObject({ component: 'Button', file: expect.stringContaining('site.tsx') });
  // And a plain element of the page's own, where react-grab is right on its own.
  expect(heading?.source).toMatchObject({ component: 'Pricing', file: expect.stringContaining('pricing.tsx') });
});

test('the banner, the frame and the name of the component have the measures of the mock-up (FRU-258)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPlayground(page, 'capture-measures');
  const launch = page.locator('[data-fruitback-host-launch]');
  const banner = page.locator('[data-fruitback-host-banner]');
  const read = (selector: string, properties: string[]) =>
    page.locator(selector).evaluate((element, names) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();

      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
      } as Record<string, string | number>;
    }, properties);

  // At rest the banner is in the tree, for a screen reader, and draws nothing.
  await expect(banner).toHaveAttribute('role', 'status');
  expect(await read('[data-fruitback-host-banner]', [])).toMatchObject({ width: 0, height: 0 });

  await launch.click();
  await expect(banner).toContainText('Click the part of the page your note is about');
  await expect(banner).toContainText('Esc to stop');
  const pill = await read('[data-fruitback-host-banner]', [
    'padding',
    'gap',
    'border-radius',
    'background-color',
    'color',
    'font-size',
    'white-space',
  ]);
  expect(pill).toMatchObject({
    // 16 px from the top of the window: the mock-up puts it under the header of its example site.
    y: 16,
    // 6 px around a button of 32 px.
    height: 44,
    padding: '6px 6px 6px 18px',
    gap: '14px',
    'border-radius': '999px',
    'background-color': 'rgb(28, 25, 23)',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'white-space': 'nowrap',
  });
  // In the middle of the window.
  expect(Math.abs(Number(pill.x) + Number(pill.width) / 2 - 720)).toBeLessThanOrEqual(1);
  expect(await page.locator('[data-fruitback-host-banner]').evaluate((node) => getComputedStyle(node).boxShadow)).toBe(
    'rgba(0, 0, 0, 0.18) 0px 10px 30px 0px',
  );
  expect(await read('.fruitback-banner-key', ['color'])).toMatchObject({ color: 'rgb(214, 211, 209)' });
  // How a keyboard moves is read, and not drawn.
  expect(await read('.fruitback-banner-keys', [])).toMatchObject({ width: 1, height: 1 });
  expect(
    await read('.fruitback-banner-stop', [
      'padding',
      'border-radius',
      'background-color',
      'color',
      'font-size',
      'font-weight',
    ]),
  ).toMatchObject({
    height: 32,
    padding: '0px 14px',
    'border-radius': '999px',
    'background-color': 'rgb(68, 64, 60)',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
  });

  // The frame stands 6 px off the element, and the name of its component sits 30 px above it.
  const button = page.locator('[data-testid="card-latte"] .add');
  await button.hover();
  const tag = page.locator('.fruitback-highlight-tag');
  await expect(tag).toHaveText('Button');
  const target = (await button.boundingBox())!;
  const frame = await read('[data-fruitback-host-highlight]', [
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-radius',
    'background-color',
  ]);
  expect(frame).toMatchObject({
    'border-top-width': '2px',
    'border-top-style': 'solid',
    'border-top-color': 'rgb(221, 44, 39)',
    'border-radius': '6px',
  });
  expect(String(frame['background-color'])).toMatch(/^color\(srgb 0\.86\d* 0\.17\d* 0\.15\d* \/ 0\.06\)$/);
  expect(Number(frame.x)).toBeCloseTo(target.x - 6, 0);
  expect(Number(frame.y)).toBeCloseTo(target.y - 6, 0);
  expect(Number(frame.width)).toBeCloseTo(target.width + 12, 0);
  expect(Number(frame.height)).toBeCloseTo(target.height + 12, 0);
  const label = await read('.fruitback-highlight-tag', [
    'padding',
    'border-radius',
    'background-color',
    'color',
    'font-size',
    'font-weight',
    'line-height',
  ]);
  expect(label).toMatchObject({
    padding: '3px 8px',
    'border-radius': '6px 6px 6px 0px',
    'background-color': 'rgb(221, 44, 39)',
    color: 'rgb(255, 255, 255)',
    'font-size': '11px',
    'font-weight': '600',
    'line-height': '16.5px',
  });
  expect(Number(label.x)).toBeCloseTo(target.x - 6, 0);
  expect(Number(label.y)).toBeCloseTo(target.y - 30, 0);

  // « Stop » leaves the capture, and focus goes back to the button of the dock.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(launch).toHaveAttribute('aria-pressed', 'false');
  await expect(launch).toBeFocused();
  await expect(banner).toBeEmpty();
  await expect(page.locator('[data-fruitback-host-highlight]')).toBeHidden();
  // The click on « Stop » chose nothing.
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden();

  // Escape does the same from the page.
  await launch.click();
  await page.locator('body').click({ position: { x: 5, y: 5 }, trial: true });
  await page.keyboard.press('Escape');
  await expect(launch).toHaveAttribute('aria-pressed', 'false');
  await expect(launch).toBeFocused();
});
