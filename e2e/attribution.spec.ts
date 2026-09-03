import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, openPlayground, plantPin, storedSeeds } from './pin.ts';

/**
 * Attribution (SKG-498), through the popover a reporter actually uses.
 *
 * The unit tests own the token verification; what is checked here is the half a browser decides:
 * that anonymous stays one click away, and that what someone types about themselves survives the
 * round trip to storage as a **claim** rather than as an identity.
 */

test('a note is anonymous unless the reporter says otherwise', async ({ page }) => {
  await openPlayground(page, 'attribution-anon');

  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  // The fields are behind a disclosure: anonymous is what happens if you do nothing.
  await expect(page.locator('[data-fruitback-who]')).toBeHidden();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Personne ne saura qui je suis');
  await page.getByRole('button', { name: 'Planter' }).click();
  await expect(page.locator('[data-fruitback-dev="status"]')).toHaveText(/^planté ·/);

  const [seed] = await storedSeeds(page);
  expect(seed?.reporter).toBeUndefined();
});

test('a typed name reaches Linear, and is stored as the claim it is', async ({ page }) => {
  await openPlayground(page, 'attribution-named');

  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByRole('button', { name: /Ajouter mon nom/ }).click();
  await page.getByLabel('Votre nom (facultatif)').fill('Alice');
  await page.getByLabel('Votre e-mail (facultatif)').fill('alice@acme.test');
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Signé Alice');
  await page.getByRole('button', { name: 'Planter' }).click();
  await expect(page.locator('[data-fruitback-dev="status"]')).toHaveText(/^planté ·/);

  const [seed] = await storedSeeds(page);
  expect(seed?.reporter).toEqual({ name: 'Alice', email: 'alice@acme.test' });
  // No `verified`: the widget never claims it, whatever was typed.
  expect(seed?.reporter && 'verified' in seed.reporter).toBe(false);
});

test('a browser cannot promote itself to a verified identity', async ({ page }) => {
  // The security claim, tested against the worker rather than against the widget: a page that skips
  // the popover entirely and posts its own body still cannot get `(verified)` into the issue.
  await openPlayground(page, 'attribution-forged');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Un pin ordinaire');

  const [planted] = await storedSeeds(page);
  const forged = await page.evaluate(
    async ([origin, seed]) => {
      const body = {
        ...(seed as Record<string, unknown>),
        id: 'sd_forged00001',
        note: 'Je prétends être vérifié',
        reporter: { name: 'Le PDG', verified: true },
      };
      const response = await fetch(`${origin}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      return response.status;
    },
    [WORKER_ORIGIN, planted] as const,
  );

  expect(forged, 'the worker accepts the note itself').toBe(201);

  const stored = await storedSeeds(page);
  const impostor = stored.find((seed) => seed.note === 'Je prétends être vérifié');
  expect(impostor?.reporter).toEqual({ name: 'Le PDG' });
  expect(impostor?.reporter && 'verified' in impostor.reporter).toBe(false);
});
