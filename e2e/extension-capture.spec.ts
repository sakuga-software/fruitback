import { type Page, expect } from '@playwright/test';
import { addRule, mintPairing, openBareSite, pairFromPopup, readSeeds, storedTokens, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A capture of the page and of an area, taken by the extension and sent to the ticket of the
 * tracker (FRU-332), end to end: the widget asks, the background takes the tab, the file goes
 * through the relay to `POST /attachments`, the note names it, and the Linear in memory of the
 * worker of the suite (the double of the tracker) holds it.
 *
 * `captureVisibleTab` needs the gesture on the toolbar button (`activeTab`), which an automated
 * browser cannot make. This copy of the extension holds `<all_urls>` instead, which Chromium 145
 * takes for the capture (measured in FRU-44): the shipped manifest asks for neither more nor less.
 */
test.use({ extraPermissions: ['<all_urls>'] });

const REVIEWER = 'E2E Capture';
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** The widget of a site of a workspace, with the transport and the capture of the extension. */
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
        captureVisible: scope.fruitbackExtension.captureVisible,
      });
    };
    window.addEventListener('fruitback:extension', follow);
    follow();
  }, WORKER_ORIGIN);
}

test('a capture of the page and one of an area go through the relay to the ticket of the tracker', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-capture-files');
  await mountTheSiteWidget(page);
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page);

  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const files = page.getByRole('group', { name: 'Attachments' });
  await files.getByRole('button', { name: 'Capture the page' }).click();
  await expect(page.locator('.fruitback-composer-file').first()).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name').first()).toHaveText('page.png');

  // The area, with the keyboard: the area is drawn in the middle, moved, sized, and taken.
  await files.getByRole('button', { name: 'Capture an area' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose an area of the page' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fruitback-composer-file')).toHaveCount(2);
  await expect(page.locator('.fruitback-composer-file').nth(1)).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name')).toHaveText(['page.png', 'area.png']);

  await page.getByPlaceholder('What should change?').fill('Deux captures');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.getByRole('button', { name: /^Note 1\b/ }).click();
  await expect(page.locator('[data-fruitback-files]')).toHaveText(/^2 attachments · in \S+$/);

  // The double of the tracker holds the two files of the note, by their names.
  const access = (await storedTokens(extension.worker)).find((token) => token.area === 'session')?.value;
  const read = await readSeeds(page, WORKER_ORIGIN, access);
  const { issues } = (await read.json()) as { issues: { seed: { note: string }; attachments?: { name: string }[] }[] };
  const note = issues.find((issue) => issue.seed.note === 'Deux captures');
  expect(note?.attachments?.map((file) => file.name)).toEqual(['page.png', 'area.png']);
});
