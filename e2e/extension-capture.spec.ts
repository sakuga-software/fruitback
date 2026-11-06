import { expect } from '@playwright/test';
import {
  addRule,
  mintPairing,
  mountTheSiteWidget,
  openBareSite,
  pairFromPopup,
  readNoteIssues,
  storedTokens,
  test,
} from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A capture of the page and of an area, taken by the extension and sent to the ticket of the
 * tracker (FRU-332), end to end: the widget asks, the background takes the tab, the file goes
 * through the relay to `POST /attachments`, the note names it, and the Linear in memory of the
 * worker of the suite (the double of the tracker) holds it.
 *
 * `captureVisibleTab` needs `activeTab` or `<all_urls>`. This copy of the extension holds
 * `<all_urls>`, which Chromium takes for the capture (measured in FRU-44 and FRU-426): the shipped
 * manifest asks for neither more nor less. `extension-bench.spec.ts` takes the capture with the
 * `activeTab` of a click on the icon, through `Extensions.triggerAction` (FRU-426).
 */
test.use({ extraPermissions: ['<all_urls>'] });

const REVIEWER = 'E2E Capture';
test('a capture of the page and one of an area go through the relay to the ticket of the tracker', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-capture-files');
  await mountTheSiteWidget(page, WORKER_ORIGIN);
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page, WORKER_ORIGIN);

  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const files = page.getByRole('dialog', { name: 'New note', exact: true });
  // FRU-609: the capture of the element joins the note at the open, framed, and waits for the note.
  const shot = page.locator('.fruitback-composer-file').first();
  await expect(shot).toHaveAttribute('data-fruitback-file', 'local');
  await expect(page.locator('.fruitback-composer-file-name').first()).toHaveText('element.png');
  await expect(shot.locator('[data-fruitback-file-thumb] img')).toHaveJSProperty('complete', true);
  expect(
    await shot.locator('[data-fruitback-file-thumb] img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  await files.getByRole('button', { name: 'Take a screenshot' }).click();
  await files.getByRole('menuitem', { name: 'Capture the whole page' }).click();
  await expect(page.locator('.fruitback-composer-file').nth(1)).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name').nth(1)).toHaveText('page.png');
  // Still waiting: nothing of it left the page before the note.
  await expect(shot).toHaveAttribute('data-fruitback-file', 'local');

  // The area, with the keyboard: the menu of the capture (FRU-351, FRU-607), then the area is drawn in the
  // middle, moved, sized, and taken.
  await files.getByRole('button', { name: 'Take a screenshot' }).focus();
  // The area is the first way of the menu since FRU-607: the file is an icon of its own.
  await page.keyboard.press('ArrowDown');
  await expect(files.getByRole('menuitem', { name: 'Capture an area' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose an area of the page' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fruitback-composer-file')).toHaveCount(3);
  await expect(page.locator('.fruitback-composer-file').nth(2)).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name')).toHaveText(['element.png', 'page.png', 'area.png']);

  await page.getByPlaceholder('What should change?').fill('Deux captures');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.getByRole('button', { name: /^Note 1\b/ }).click();
  await expect(page.locator('[data-fruitback-files]')).toHaveText(/^3 attachments · in \S+$/);

  // The double of the tracker holds the three files of the note, by their names: the capture of the
  // element went with the note, at the send.
  const access = (await storedTokens(extension.worker)).find((token) => token.area === 'session')?.value;
  const read = await readNoteIssues(page, WORKER_ORIGIN, access);
  const { issues } = (await read.json()) as { issues: { note: { text: string }; attachments?: { name: string }[] }[] };
  const note = issues.find((issue) => issue.note.text === 'Deux captures');
  expect(note?.attachments?.map((file) => file.name)).toEqual(['element.png', 'page.png', 'area.png']);
});
