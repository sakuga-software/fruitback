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
