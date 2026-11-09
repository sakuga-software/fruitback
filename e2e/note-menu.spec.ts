import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { pinFor } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The menu « ⋯ » of the author in the thread of an open note (FRU-605), in a real Chrome with the
 * extension: the session of the account says whose note it is, as for the edit (FRU-475).
 */

const NAME = 'Camille Durand';
const MORE = /^(More actions on your note|Autres actions sur votre note)$/;
const EDIT = /^(Edit the note|Modifier la note)$/;
const COPY = /^(Copy link to the note|Copier le lien de la note)$/;
const WITHDRAW = /^(Withdraw the note|Retirer la note)$/;

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

test('the author of an open note copies its link and opens the edit from « ⋯ », and a refused copy shows the link (FRU-605)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'note-menu');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', 'The price is wrong');

  await pinFor(page, 'The price is wrong').locator('.fruitback-pin-badge').click();
  const thread = page.locator('.fruitback-thread');
  const more = thread.getByRole('button', { name: MORE });
  await expect(more).toBeVisible();
  const id = await pinFor(page, 'The price is wrong').getAttribute('data-fruitback-pin');

  await more.click();
  await expect(thread.getByRole('menuitem')).toHaveText([EDIT, COPY, WITHDRAW]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scanned = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(scanned.violations.map((violation) => violation.id)).toEqual([]);

  // The copy is on the clipboard of the browser, and the thread says so.
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PLAYGROUND_ORIGIN });
  await thread.getByRole('menuitem', { name: COPY }).click();
  await expect(thread.locator('.fruitback-thread-more-said')).toHaveText(/^(Link copied\.|Lien copié\.)$/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(new RegExp(`^${PLAYGROUND_ORIGIN}/.*#fruitback-note=${id}$`));
  await expect(more).toBeFocused();

  // A clipboard that refuses, as a page with no secure context or a policy that forbids it: the link
  // shows in a field, to copy by hand.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    });
  });
  await more.click();
  await thread.getByRole('menuitem', { name: COPY }).click();
  const field = thread.getByRole('textbox', { name: /^(Link to the note|Lien de la note)$/ });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(copied);
  await expect(thread.locator('.fruitback-thread-more-said')).toHaveText(
    /^(The link could not be copied\. Select it, then copy it\.|Le lien n’a pas pu être copié\. Sélectionnez-le, puis copiez-le\.)$/,
  );

  // Escape closes the menu, not the thread.
  await more.click();
  await expect(thread.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(thread.getByRole('menu')).toBeHidden();
  await expect(thread).toBeVisible();

  // « Edit the note » opens the field of the edit, with the text.
  await more.click();
  await thread.getByRole('menuitem', { name: EDIT }).click();
  await expect(thread.locator('.fruitback-thread-edit-field')).toBeFocused();
  await expect(thread.locator('.fruitback-thread-edit-field')).toHaveValue('The price is wrong');

  // The link opens the note on its page.
  const other = await extension.context.newPage();
  await other.goto(copied);
  await expect(other.locator('.fruitback-thread .fruitback-thread-note')).toHaveText('The price is wrong', {
    timeout: 15_000,
  });
});

test('the author withdraws an open note from « ⋯ »: asked first, then closed, and it stays closed (FRU-605)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'note-withdraw');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', 'Please take this back');

  await pinFor(page, 'Please take this back').locator('.fruitback-pin-badge').click();
  const thread = page.locator('.fruitback-thread');
  await thread.getByRole('button', { name: MORE }).click();
  await thread.getByRole('menuitem', { name: WITHDRAW }).click();
  await expect(thread.getByText(/^(Withdraw this note\?|Retirer cette note)/)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scanned = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(scanned.violations.map((violation) => violation.id)).toEqual([]);
  await thread.getByRole('button', { name: /^(Withdraw|Retirer)$/ }).click();

  await expect(thread.locator('.fruitback-thread-withdraw-said')).toHaveText(
    /^(Withdrawn\. The note is closed\.|Retirée\. La note est fermée\.)$/,
  );
  await expect(pinFor(page, 'Please take this back')).toHaveAttribute('data-fruitback-stage', 'closed');
  await expect(thread.getByRole('button', { name: MORE })).toHaveCount(0);
  await expect(thread.locator('.fruitback-thread-reply-body')).toContainText([/Withdrew the note|A retiré la note/]);

  // The store says it too: the note is closed after a read, and nothing offers it again.
  await page.reload();
  await expect(pinFor(page, 'Please take this back')).toHaveAttribute('data-fruitback-stage', 'closed', {
    timeout: 20_000,
  });
});
