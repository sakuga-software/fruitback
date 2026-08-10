import { expect, test } from '@playwright/test';
import { expectPinOn, openPlayground, pinFor, plantPin, waitForPins } from './pin.ts';

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
  await expect(pin).toHaveAttribute('data-fb-strategy', 'selector');

  // The reload is the read path: nothing is kept client-side, so a pin that survives it came back
  // from `GET /feedback`.
  await page.reload();
  await waitForPins(page, 1);
  await expectPinOn(pinFor(page, 'Le bouton Ajouter'), button);

  expect(errors).toEqual([]);
});

test('the selector it picked is unique in a real engine, and skips what a redeploy would change', async ({
  page,
}) => {
  await openPlayground(page, 'selector');
  await plantPin(page, page.locator('#checkout-cta'), 'Le CTA devrait être plus large');
  await plantPin(page, page.locator('header button'), 'Le menu n’est pas assez visible');

  const anchors = await page.evaluate(async () => {
    const url = new URL(window.location.href);
    url.hash = '';
    const response = await fetch(
      `${window.__FRUITBACK_PLAYGROUND__?.workerOrigin}/feedback?url=${encodeURIComponent(url.toString())}&client=playground`,
    );
    const { issues } = (await response.json()) as { issues: { seed: { anchor: { selector: string } } }[] };

    return issues.map((issue) => ({
      selector: issue.seed.anchor.selector,
      matches: document.querySelectorAll(issue.seed.anchor.selector).length,
    }));
  });

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

declare global {
  interface Window {
    __FRUITBACK_PLAYGROUND__?: { workerOrigin: string };
  }
}
