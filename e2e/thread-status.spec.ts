import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test as plain } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN, caseOf, hydrated, pinFor } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The status of a note, changed from the head of its thread (FRU-718). A member, in a real Chrome with
 * the extension, which relays `POST /feedback/<id>/status` with the session; and a visitor of a public
 * page, whose chip stays read only and whose key changes nothing.
 */

const NAME = 'Camille Durand';
const STATUS = /^(Status: New\. Change the status|Statut : Nouveau\. Changer le statut)$/;
const PROGRESS = /^(In progress|En cours)$/;

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

test('a member changes the status of a note from its thread, the pin follows, and it stays after a reload (FRU-718)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'thread-status');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', 'The button is hard to read');

  await pinFor(page, 'The button is hard to read').locator('.fruitback-pin-badge').click();
  const thread = page.locator('.fruitback-thread');
  const status = thread.getByRole('button', { name: STATUS });
  await expect(status).toBeVisible();
  // The chip of the mock-up: 24 px drawn, its chevron after the word, 44 px to press.
  const box = await status.boundingBox();
  expect(box?.height).toBe(44);
  await expect(status.locator('.fruitback-thread-status-chevron')).toBeVisible();

  // The keyboard opens it on the stage of the note.
  await status.focus();
  await page.keyboard.press('ArrowDown');
  const menu = thread.getByRole('menu', { name: /^(Status of the note|Statut de la note)$/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
  // Under the chip, on its start side, each stage a row: its round, a gap, its word.
  const [chip, list] = [await status.boundingBox(), await menu.boundingBox()];
  expect(Math.abs((list?.x ?? 0) - (chip?.x ?? 0))).toBeLessThanOrEqual(8);
  await expect(menu.getByRole('menuitemradio').first()).toHaveCSS('display', 'flex');
  await expect(menu.getByRole('menuitemradio').first()).toHaveCSS('column-gap', '8px');
  await expect(menu.getByRole('menuitemradio', { checked: true })).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scanned = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(scanned.violations.map((violation) => violation.id)).toEqual([]);

  // Sent by the background of the extension, with the session: the page itself makes no call.
  await menu.getByRole('menuitemradio', { name: PROGRESS }).click();

  await expect(thread.locator('.fruitback-thread-status-said')).toHaveText(
    /^(Status changed: In progress\.|Statut changé : En cours\.)$/,
  );
  await expect(thread.locator('.fruitback-thread-state')).toHaveText(PROGRESS);
  await expect(pinFor(page, 'The button is hard to read')).toHaveAttribute('data-fruitback-stage', 'progress');
  await expect(status).toBeFocused();

  // The store says it too: after a read, the note is in progress.
  await page.reload();
  await expect(pinFor(page, 'The button is hard to read')).toHaveAttribute('data-fruitback-stage', 'progress', {
    timeout: 20_000,
  });
});

plain('a visitor reads the status of their own note, and their key changes nothing (FRU-718)', async ({ page }) => {
  const path = `/?widget=off&case=${caseOf('thread-status-visitor')}`;
  const mount = async () => {
    await page.goto(path);
    await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
    await hydrated(page);
    await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
    await page.evaluate(
      (endpoint) =>
        (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
          endpoint,
          clientId: 'playground',
        }),
      WORKER_ORIGIN,
    );
    await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  };
  await mount();
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Only a member moves this one');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount();
  const stage = await page.locator('[data-fruitback-pin]').getAttribute('data-fruitback-stage');
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();
  const thread = page.getByRole('dialog', { name: /Note 1/ });
  // Their own note, by the key of this browser: the chip of the status is no button.
  await expect(thread.getByText('You · this browser', { exact: true })).toBeVisible();
  await expect(thread.locator('span.fruitback-thread-stage')).toBeVisible();
  await expect(thread.locator('button.fruitback-thread-stage')).toHaveCount(0);
  await expect(thread.locator('.fruitback-thread-status-chevron')).toHaveCount(0);

  // The call the menu would make, from this page, with the key of this browser: refused, nothing moves.
  const answer = await page.evaluate(async (endpoint) => {
    const key = Object.entries(localStorage).find(([name]) => name.startsWith('fruitback:visitor:'))?.[1];
    const headers: Record<string, string> = key === undefined ? {} : { 'X-Fruitback-Visitor': key };
    const url = location.href.split('#')[0] as string;
    const read = await fetch(`${endpoint}/feedback?url=${encodeURIComponent(url)}&client=playground`, { headers });
    const [issue] = ((await read.json()) as { issues: { id: string; mine?: true }[] }).issues;
    const response = await fetch(`${endpoint}/feedback/${issue?.id}/status?client=playground`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, status: 'own:done' }),
    });

    return { status: response.status, key: key !== undefined, mine: issue?.mine === true };
  }, WORKER_ORIGIN);
  expect(answer).toEqual({ status: 401, key: true, mine: true });
  await mount();
  await expect(page.locator('[data-fruitback-pin]')).toHaveAttribute('data-fruitback-stage', stage as string);
});
