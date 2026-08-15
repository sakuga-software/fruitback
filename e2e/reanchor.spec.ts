import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, expectPinOn, openPlayground, pinFor, plantPin, waitForPins } from './pin.ts';

/**
 * What happens to a pin when the site is deployed again — the question the whole anchor exists to
 * answer, and the one no unit test can settle, because it takes a real reflow.
 */

test('pins survive a redeploy that rewrites classes, ids and the order of the page', async ({ page }) => {
  await openPlayground(page, 'reanchor');
  const latteButton = page.locator('[data-testid="card-latte"] .add');
  const burger = page.locator('main header button');

  await plantPin(page, latteButton, 'Le bouton Ajouter est trop discret');
  await plantPin(page, burger, 'Le menu n’est pas assez visible');

  // Hashed classes change, the `useId` id changes, a card is inserted in front of the grid, and
  // everything below shifts one position to the right.
  await page.getByRole('button', { name: 'Redéployer' }).click();
  await waitForPins(page, 2);

  await expectPinOn(pinFor(page, 'Le bouton Ajouter'), latteButton);
  await expectPinOn(pinFor(page, 'Le menu'), burger);
  await expect(pinFor(page, 'Le bouton Ajouter')).toHaveAttribute('data-fb-strategy', 'selector');
});

test('the structural path alone would have landed on the neighbouring card', async ({ page }) => {
  // The finding from the SKG-494 browser test, kept as a standing expectation: after a card is
  // inserted, `li:nth-child(2)` still resolves — to the wrong button. Both say "Ajouter", so a text
  // check would not catch it either. This is why `domPath` ranks below the selector, and why a
  // domPath match is worth doubting rather than trusting.
  await openPlayground(page, 'dompath');
  const latteButton = page.locator('[data-testid="card-latte"] .add');

  await plantPin(page, latteButton, 'Ancre à surveiller');
  await page.getByRole('button', { name: 'Redéployer' }).click();
  await waitForPins(page, 1);

  const verdict = await page.evaluate(async (worker) => {
    const url = new URL(window.location.href);
    const response = await fetch(
      `${worker}/feedback?url=${encodeURIComponent(url.toString())}&client=playground`,
    );
    const { issues } = (await response.json()) as {
      issues: { seed: { anchor: { selector: string; domPath?: string } } }[];
    };
    const anchor = issues[0]?.seed.anchor;
    const bySelector = document.querySelectorAll(anchor?.selector ?? '');
    const byPath = document.querySelectorAll(anchor?.domPath ?? '');
    const truth = document.querySelector('[data-testid="card-latte"] .add');

    return {
      selectorIsRight: bySelector.length === 1 && bySelector[0] === truth,
      domPathResolves: byPath.length === 1,
      domPathIsRight: byPath.length === 1 && byPath[0] === truth,
    };
  }, WORKER_ORIGIN);

  expect(verdict.selectorIsRight, 'the selector should still find the right button').toBe(true);
  expect(verdict.domPathResolves, 'the path still matches exactly one element').toBe(true);
  expect(verdict.domPathIsRight, 'and that element is the wrong one — this is the trap').toBe(false);
});

test('an element that is gone never leaves a pin that claims to be sure', async ({ page }) => {
  // Deleting the Latte card slides Mocha into the slot it left: same tag, same "Ajouter", same box.
  // Nothing a seed stores separates them, so the pin does land on Mocha — and says it is a guess.
  // That is the whole point of `confident`: the degradation is visible instead of silent.
  await openPlayground(page, 'orphan');
  const latteButton = page.locator('[data-testid="card-latte"] .add');

  await plantPin(page, latteButton, 'Sur une carte qui va disparaître');
  await page.getByRole('button', { name: 'Supprimer la carte Latte' }).click();
  await waitForPins(page, 1);

  const pin = pinFor(page, 'Sur une carte qui');
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('data-fb-confident', 'false');
  await expect(pin.getByRole('button')).toContainText('≈');
});

