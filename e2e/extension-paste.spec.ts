import { type Page, expect } from '@playwright/test';
import { mintPairing, openBareSite, pairFromPopup, readNoteIssues, storedTokens, test, addRule } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A screenshot pasted in the composer joins the note (FRU-424), end to end: the image of the
 * clipboard goes through the relay of the extension to `POST /attachments`, the note names it, and
 * the Linear in memory of the worker of the suite holds it. It is the way to join a capture that
 * works everywhere: a screenshot of the system, then ⌘V or Ctrl+V.
 *
 * Automation cannot put an image on the clipboard of the system, so the paste is the event the
 * browser fires, with a `DataTransfer` that holds a PNG, as Chromium builds it for a screenshot.
 */

const REVIEWER = 'E2E Paste';
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** The widget of a site of a workspace, with the transport of the extension. */
async function mountTheSiteWidget(page: Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as {
      Fruitback: { init(options: Record<string, unknown>): { destroy(): void } };
      fruitbackExtension?: { transport: unknown; captureVisible?: unknown };
    };
    let widget: { destroy(): void } | undefined;
    const follow = (): void => {
      widget?.destroy();
      widget = undefined;
      if (scope.fruitbackExtension === undefined) return;
      widget = scope.Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: 'Team feedback',
        transport: scope.fruitbackExtension.transport,
      });
    };
    window.addEventListener('fruitback:extension', follow);
    follow();
  }, WORKER_ORIGIN);
}

/** Pastes in the field of the note: a PNG of one pixel, or text. */
async function paste(page: Page, what: 'image' | 'text'): Promise<boolean> {
  return page.getByPlaceholder('What should change?').evaluate(async (field, kind) => {
    const data = new DataTransfer();
    if (kind === 'text') data.setData('text/plain', 'du texte');
    else {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    }
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true });
    field.dispatchEvent(event);

    return event.defaultPrevented;
  }, what);
}

test('a screenshot pasted in the note goes through the relay to the ticket of the tracker', async ({ extension }) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-paste-files');
  await mountTheSiteWidget(page);
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page);

  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const field = page.getByPlaceholder('What should change?');
  await field.fill('Une capture collée');
  // Text pasted stays a paste of text: the browser does it, and no file joins.
  expect(await paste(page, 'text')).toBe(false);
  await expect(page.locator('.fruitback-composer-file')).toHaveCount(0);

  expect(await paste(page, 'image')).toBe(true);
  await expect(page.locator('.fruitback-composer-file')).toHaveCount(1);
  await expect(page.locator('.fruitback-composer-file')).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name')).toHaveText('image.png');
  await expect(field).toHaveValue('Une capture collée');

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The double of the tracker holds the pasted file of the note.
  const access = (await storedTokens(extension.worker)).find((token) => token.area === 'session')?.value;
  const read = await readNoteIssues(page, WORKER_ORIGIN, access);
  const { issues } = (await read.json()) as { issues: { seed: { note: string }; attachments?: { name: string }[] }[] };
  const note = issues.find((issue) => issue.seed.note === 'Une capture collée');
  expect(note?.attachments?.map((file) => file.name)).toEqual(['image.png']);
});
