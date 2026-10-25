import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, openPlayground, plantPin, sendNote, storedNotes } from './pin.ts';

/**
 * Attribution (FRU-9), through the popover a reporter actually uses.
 *
 * The unit tests own the token verification; what is checked here is the half a browser decides:
 * that anonymous stays one click away, and that what someone types about themselves survives the
 * round trip to storage as a **claim** rather than as an identity.
 */

test('a note is anonymous unless the reporter says otherwise', async ({ page }) => {
  await openPlayground(page, 'attribution-anon');

  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  // The fields are behind a disclosure: anonymous is what happens if you do nothing.
  await expect(page.locator('[data-fruitback-who]')).toBeHidden();
  await page.getByPlaceholder('What should change?').fill('Personne ne saura qui je suis');
  await sendNote(page);

  const [note] = await storedNotes(page);
  expect(note?.reporter).toBeUndefined();
});

test('a typed name reaches Linear, and is stored as the claim it is', async ({ page }) => {
  await openPlayground(page, 'attribution-named');

  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByLabel('Name (optional)').fill('Alice');
  await page.getByPlaceholder('What should change?').fill('Signé Alice');
  await sendNote(page);

  const [note] = await storedNotes(page);
  expect(note?.reporter).toEqual({ name: 'Alice' });
  // No `verified`: the widget never claims it, whatever was typed.
  expect(note?.reporter && 'verified' in note.reporter).toBe(false);

  // The box was not ticked, so this browser keeps no name (FRU-91).
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Alice');
});

test('a reporter who asks to be remembered signs the next note too, until the box is unticked (FRU-91)', async ({
  page,
}) => {
  await openPlayground(page, 'attribution-remembered');
  const latte = page.locator('[data-testid="card-latte"] .add');
  const stored = () => page.evaluate(() => JSON.stringify({ ...localStorage }));

  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await latte.click();
  await page.getByLabel('Name (optional)').fill('Alice');
  await page.getByLabel('Remember me on this site').check();
  await page.getByPlaceholder('What should change?').fill('Signé, et retenu');
  await sendNote(page);
  expect(await stored()).toContain('Alice');

  // After a reload nothing of the first popover is left: the name comes from storage.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-mocha"] .add').click();
  await expect(page.getByLabel('Name (optional)')).toHaveValue('Alice');
  await expect(page.getByLabel('Remember me on this site')).toBeChecked();
  await page.getByPlaceholder('What should change?').fill('Signé sans rien retaper');
  await sendNote(page);

  const notes = await storedNotes(page);
  expect(notes.find((note) => note.text === 'Signé sans rien retaper')?.reporter).toEqual({ name: 'Alice' });

  // Unticked, the name leaves storage at once.
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await latte.click();
  await page.getByLabel('Remember me on this site').uncheck();
  expect(await stored()).not.toContain('Alice');
});

test('a browser cannot promote itself to a verified identity', async ({ page }) => {
  // The security claim, tested against the worker rather than against the widget: a page that skips
  // the popover entirely and posts its own body still cannot get `(verified)` into the issue.
  await openPlayground(page, 'attribution-forged');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Un pin ordinaire');

  const [planted] = await storedNotes(page);
  const forged = await page.evaluate(
    async ([origin, note]) => {
      const body = {
        ...(note as Record<string, unknown>),
        id: 'sd_forged00001',
        text: 'Je prétends être vérifié',
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

  const stored = await storedNotes(page);
  const impostor = stored.find((note) => note.text === 'Je prétends être vérifié');
  expect(impostor?.reporter).toEqual({ name: 'Le PDG' });
  expect(impostor?.reporter && 'verified' in impostor.reporter).toBe(false);
});
