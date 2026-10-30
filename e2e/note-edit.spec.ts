import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { pinFor } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The author edits the text of a note from its thread (FRU-475), in a real Chrome with the extension:
 * the session of the account is what says whose note it is. The note is kept by the worker of the
 * suite's sessions (`FRUITBACK_STORE=postgres`), the one store that takes an edit.
 */

const NAME = 'Camille Durand';

/** A session of the workspace of the suite's second worker, through a pairing link. */
async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: /^(Connect to this server|Se connecter à ce serveur)$/ }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

async function plantOn(page: Page, selector: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-note]:visible').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

const EDIT = /^(Edit your note|Modifier votre note)$/;
const SAVE = /^(Save|Enregistrer)$/;

test('the author edits a note that is still new, the thread and the reload show the new text, and a note the team moved is not offered (FRU-475)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'note-edit');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  await plantOn(page, '[data-testid="card-espresso"] .add', 'The price is wrong');
  await plantOn(page, '[data-testid="card-latte"] .add', 'A note the team takes');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

  // The thread of the first note offers « Edit » to its author.
  await pinFor(page, 'The price is wrong').locator('.fruitback-pin-badge').click();
  const thread = page.locator('.fruitback-thread');
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('The price is wrong');
  await thread.getByRole('button', { name: /^(Edit your note|Modifier votre note)$/ }).click();
  const field = thread.locator('.fruitback-thread-edit-field');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('The price is wrong');
  await field.fill('The price of the Pro plan is wrong');
  // The field, « Save » and « Cancel » under axe-core, as every state of the widget (FRU-51).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scanned = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(scanned.violations.map((violation) => violation.id)).toEqual([]);
  await thread.getByRole('button', { name: SAVE }).click();

  // The thread shows the new text, and the reply that says it was edited, by the read after it.
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('The price of the Pro plan is wrong');
  await expect(thread.locator('.fruitback-thread-edit-status')).toHaveText(/^(Saved|Enregistrée)$/);
  await expect(thread.locator('.fruitback-thread-reply-body')).toContainText([/Edited the note|A modifié la note/], {
    timeout: 10_000,
  });

  // The other note: the team moves it, as it would in the console. It is no longer offered.
  const id = await pinFor(page, 'A note the team takes').getAttribute('data-fruitback-pin');
  const moved = await fetch(`${AUTHENTICATED_WORKER_ORIGIN}/__dev/stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: id, stage: 'todo' }),
  });
  expect(moved.status).toBe(200);
  // The stage of now, once the shared cache of the read (15 s, `CACHE_TTL_MS`) let go of the answer of before.
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

        return page.locator('[data-fruitback-pin][data-fruitback-stage="todo"]').count();
      },
      { timeout: 40_000, intervals: [3_000] },
    )
    .toBe(1);

  // After the reload, the edited note keeps its new text, and is still offered.
  await pinFor(page, 'The price of the Pro plan is wrong').locator('.fruitback-pin-badge').click();
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('The price of the Pro plan is wrong');
  await expect(thread.getByRole('button', { name: EDIT })).toBeVisible();
  await thread.locator('.fruitback-thread-close').click();

  // The note the team moved: its thread has no « Edit ».
  await pinFor(page, 'A note the team takes').locator('.fruitback-pin-badge').click();
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('A note the team takes');
  await expect(thread.getByRole('button', { name: EDIT })).toHaveCount(0);
});
