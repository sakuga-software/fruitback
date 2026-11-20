import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * A widget with no worker (FRU-646): `notes: Fruitback.localNotes()` keeps the note in the browser,
 * and the pin comes back after a reload. No call goes to a worker, and no call goes to `.invalid`.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** Mounts the widget of the `<script>` bundle with `localNotes`; `read: false` keeps only `write`. */
async function mount(page: Page, testCase: string, read = true): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((withRead) => {
    type Notes = { write: unknown; read?: unknown };
    const scope = globalThis as unknown as {
      Fruitback: { init(options: unknown): unknown; localNotes(): Notes };
    };
    const notes = scope.Fruitback.localNotes();
    scope.Fruitback.init({ notes: withRead ? notes : { write: notes.write }, locale: 'en' });
  }, read);
}

/** Every request the page sends to a worker, or to the address of `notes`. */
function watchWorkers(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(WORKER_ORIGIN) || url.includes('.invalid')) sent.push(`${request.method()} ${url}`);
  });

  return sent;
}

async function sendNote(page: Page, text: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.locator('.fruitback-composer textarea').fill(text);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('.fruitback-composer')).toBeHidden({ timeout: 10_000 });
}

test('a note kept in the browser comes back as a pin after a reload, with no worker (FRU-646)', async ({ page }) => {
  const sent = watchWorkers(page);
  await mount(page, caseOf('offline-notes'));
  await sendNote(page, 'The espresso price is wrong.');

  await expect(page.locator('.fruitback-pin-badge')).toHaveCount(1);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fruitback:notes') ?? '[]') as unknown[]);
  expect(kept).toHaveLength(1);

  await mount(page, caseOf('offline-notes'));
  await expect(page.locator('.fruitback-pin-badge')).toHaveCount(1);
  await page.locator('.fruitback-pin-badge').first().click();
  await expect(page.locator('.fruitback-thread')).toContainText('The espresso price is wrong.');
  // No reply with `notes`: the thread has no field to write one.
  await expect(page.locator('.fruitback-thread textarea')).toHaveCount(0);

  expect(sent).toEqual([]);
});

test('without `read`, the note goes and no pin comes back (FRU-646)', async ({ page }) => {
  await mount(page, caseOf('offline-notes-write-only'), false);
  await sendNote(page, 'Written, never read.');

  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fruitback:notes') ?? '[]') as unknown[]);
  expect(kept).toHaveLength(1);
  await expect(page.locator('.fruitback-pin-badge')).toHaveCount(0);
});
