import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * « All pages » of the widget the extension mounts (FRU-470): the list of the widget reads the notes
 * of every page of the site through the bridge and the background, with the session of the reviewer,
 * and a note of another page opens that page by its link (FRU-253).
 */

const NAME = 'Camille Durand';

async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: /^(Pair with this worker|Appairer avec ce worker)$/ }).click();
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

test('« All pages » lists the notes of the other pages of the site, and opens one on its page (FRU-470)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  // A word no other spec writes: the whole site holds the notes of every spec of the suite.
  const tag = `zp${Date.now().toString(36)}`;
  const page = await extension.context.newPage();
  await openBareSite(page, 'all-pages-a');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', `Here ${tag}`);

  const other = await extension.context.newPage();
  await openBareSite(other, 'all-pages-b');
  await expect(other.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(other, '[data-testid="card-latte"] .add', `Elsewhere ${tag}`);
  const otherUrl = other.url();
  await other.close();

  await page.bringToFront();
  await page.getByRole('button', { name: /Show every note in a sidebar/ }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await list.getByRole('button', { name: /^All pages/ }).click();
  await list.getByRole('searchbox', { name: 'Search notes' }).fill(tag);
  const rows = list.locator('[data-fruitback-site-note]');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(rows.filter({ hasText: `Here ${tag}` })).toContainText('this page');

  await rows.filter({ hasText: `Elsewhere ${tag}` }).click();
  await page.waitForURL((url) => url.href.startsWith(otherUrl.split('#')[0]!));
  // The link opened the thread of the note on its page, then left the address (FRU-253).
  await expect(page.locator('[data-fruitback-thread]')).toContainText(`Elsewhere ${tag}`, { timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});
