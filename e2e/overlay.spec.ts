import { expect, test } from '@playwright/test';
import { badgeFor, expectPinOn, openPlayground, pinFor, plantPin, planted, status, waitForPins } from './pin.ts';

/**
 * The overlay in a browser that actually lays out and scrolls (SKG-500). The unit tests state every
 * box by hand — happy-dom computes none — so the questions left for here are the ones only a real
 * engine answers: does the pin still sit on its element after the page moves, and does it stay out
 * of the way of the page underneath.
 */

test('the pin follows its element when the window is resized', async ({ page }) => {
  await openPlayground(page, 'resize');
  const cta = page.locator('#checkout-cta');

  await plantPin(page, cta, 'Le CTA bouge avec la fenêtre');
  await expectPinOn(pinFor(page, 'Le CTA bouge'), cta);

  // A narrower window reflows the page: the form moves, and the pin has to move with it.
  await page.setViewportSize({ width: 820, height: 900 });
  await expectPinOn(pinFor(page, 'Le CTA bouge'), cta);
});

test('the pin stays on its element through a scroll', async ({ page }) => {
  await openPlayground(page, 'scrolling');
  const cta = page.locator('#checkout-cta');
  await plantPin(page, cta, 'Tout en bas de la page');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await cta.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  await expectPinOn(pinFor(page, 'Tout en bas'), cta);
});

test('the page underneath stays clickable, and the badge opens the thread', async ({ page }) => {
  await openPlayground(page, 'thread');
  const cta = page.locator('#checkout-cta');
  await plantPin(page, cta, 'Le CTA devrait être plus large');

  // The pin covers the button exactly; a widget that swallowed this click would be unusable.
  await cta.click();
  await expect(page.locator('[data-fruitback-thread]')).toHaveCount(0);

  await badgeFor(page, 'Le CTA devrait').click();
  const thread = page.locator('[data-fruitback-thread]');
  await expect(thread).toBeVisible();
  await expect(thread).toContainText('Le CTA devrait être plus large');
  // Whatever state the in-memory Linear gave it, the thread names it and links to the issue.
  await expect(thread.getByRole('link')).toHaveAttribute('href', /dev-issue\/DEV-/);

  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
});

test('a pin that was placed rather than recognised warns whoever opens it', async ({ page }) => {
  await openPlayground(page, 'orphan-thread');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Sur une carte condamnée');

  await page.getByRole('button', { name: 'Supprimer la carte Latte' }).click();
  await waitForPins(page, 1);

  await expect(pinFor(page, 'Sur une carte')).toHaveAttribute('data-fruitback-confident', 'false');
  await badgeFor(page, 'Sur une carte').click();
  // Not "here is your feedback": "the page moved, check this one".
  await expect(page.locator('[data-fruitback-thread]')).toContainText(/position|not found/i);
});

test('the colour of a pin is the Linear state, and nothing the widget decided', async ({ page }) => {
  // The in-memory Linear walks the workflow states as issues are created, so three pins on one page
  // come back at three different stages — which is the only way to see the mapping work.
  await openPlayground(page, 'stages');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Premier');
  await plantPin(page, page.locator('#checkout-cta'), 'Deuxième');
  await plantPin(page, page.locator('main header button'), 'Troisième');

  const stages = await page
    .locator('[data-fruitback-pin]')
    .evaluateAll((pins) => pins.map((pin) => (pin as HTMLElement).dataset.fruitbackStage));

  assertDistinct(stages);
});

function assertDistinct(stages: (string | undefined)[]): void {
  expect(stages).toHaveLength(3);
  expect(new Set(stages).size, `expected three different stages, got ${stages.join(', ')}`).toBe(3);
}

test('the planted identifier survives the widget announcing its own re-resolution', async ({ page }) => {
  // The CI failure this closes: `status` has two writers — this harness, and the widget reporting a
  // re-resolution it decided on by itself (SKG-513). The confirmation was overwritten by a pin count
  // arriving a moment later, so `plantPin` timed out waiting for a message that had already been and
  // gone. Locally the count won the race; on CI it lost.
  await openPlayground(page, 'planted-signal');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Le pin dont on garde l’identifiant');

  const identifier = await planted(page).textContent();
  expect(identifier).toMatch(/^DEV-/);

  // A re-render the widget notices on its own, which is what writes over the status line.
  await page.getByRole('button', { name: 'Redéployer' }).click();
  await expect(status(page)).toHaveText(/^1 pin$/);

  // The status moved on; the identifier did not.
  await expect(planted(page)).toHaveText(identifier ?? '');
});

test('the team’s replies show up inside the pin', async ({ page }) => {
  // The loop this closes: someone leaves a note, the team answers in Linear, and the answer appears
  // where the note was left. The fake Linear replies on every third issue, so this plants until it
  // gets one rather than assuming which.
  await openPlayground(page, 'replies');
  const button = page.locator('[data-testid="card-latte"] .add');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await plantPin(page, button, `Note ${attempt} en attente de réponse`);
    await badgeFor(page, `Note ${attempt} en attente de réponse`).click();

    const replies = page.locator('.fruitback-thread-reply-body');
    if ((await replies.count()) > 0) {
      // Oldest first, so it reads as a conversation rather than as an inbox.
      await expect(replies.first()).toHaveText(/Bien vu/);
      await expect(replies.last()).toHaveText(/préprod/);
      await expect(page.locator('.fruitback-thread-reply-who').first()).toContainText('Alice');

      return;
    }

    // The pin that got no reply says so, which is a different thing from saying nothing.
    await expect(page.locator('.fruitback-thread-empty')).toHaveText(/No reply yet/);
    await page.keyboard.press('Escape');
  }

  throw new Error('no issue came back with replies in three attempts');
});

test('a reply is not drawn as a bullet point', async ({ page }) => {
  // `all: initial` in the host reset gives each item its own `list-style-type: disc`, which beats
  // what it would have inherited from the list. Asserted on the computed style rather than on the
  // rule, because the rule is not the promise — and no unit test can see a marker.
  await openPlayground(page, 'reply-markers');
  const button = page.locator('[data-testid="card-latte"] .add');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await plantPin(page, button, `Puces ${attempt} à vérifier`);
    await badgeFor(page, `Puces ${attempt} à vérifier`).click();

    const reply = page.locator('.fruitback-thread-reply').first();
    if ((await reply.count()) > 0) {
      expect(await reply.evaluate((node) => getComputedStyle(node).listStyleType)).toBe('none');

      return;
    }
    await page.keyboard.press('Escape');
  }

  throw new Error('no issue came back with replies in three attempts');
});

test('the popover and the thread open inside the window on a page scrolled sideways (SKG-607)', async ({ page }) => {
  // The popover scales in from 96%, which moves its edges by a few pixels mid-animation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'scrolled-sideways');
  // A page wider than the window, with the element far to the right of the first screen.
  await page.addStyleTag({ content: '#checkout-cta { position: relative; left: 2200px; }' });
  const target = page.locator('#checkout-cta');
  await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollX), 'the page did not scroll sideways').toBeGreaterThan(0);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const insideWindow = async (locator: import('@playwright/test').Locator) => {
    const box = await locator.boundingBox();

    return box !== null && box.x >= 0 && box.x + box.width <= viewport!.width;
  };

  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await target.click();
  const composer = page.locator('[data-fruitback-composer]');
  await expect(page.getByPlaceholder('What is wrong here?')).toBeVisible();
  await expect.poll(() => insideWindow(composer), { message: 'the popover opened outside the window' }).toBe(true);

  await page.getByPlaceholder('What is wrong here?').fill('Sur une page qui défile de côté');
  await page.getByRole('button', { name: 'Plant', exact: true }).click();
  await expect(composer).toBeHidden({ timeout: 5_000 });

  await badgeFor(page, 'Sur une page qui défile de côté').click();
  const thread = page.locator('[data-fruitback-thread]');
  await expect(thread).toBeVisible();
  await expect.poll(() => insideWindow(thread), { message: 'the thread opened outside the window' }).toBe(true);
});
