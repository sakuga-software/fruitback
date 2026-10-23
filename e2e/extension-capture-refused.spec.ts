import { type Page, expect } from '@playwright/test';
import { addRule, mintPairing, openBareSite, pairFromPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A capture refused by the browser, in the extension as it ships (FRU-423): no `<all_urls>`, and no
 * gesture on the toolbar button, so `captureVisibleTab` is refused for want of `activeTab`. That is
 * what a site of a workspace meets on the Cloud. The composer says to click the icon, not only that
 * the capture was not taken, and the note stays.
 *
 * An automated browser cannot click the toolbar button, so the grant that follows is not played
 * here: `extension-capture.spec.ts` holds a capture that the browser takes.
 */

const REVIEWER = 'E2E Capture Refused';
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

test('a capture refused for want of a gesture says to click the icon, and keeps the note', async ({ extension }) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-capture-refused');
  await mountTheSiteWidget(page);
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page);

  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const field = page.getByPlaceholder('What should change?');
  await field.fill('La capture est refusée');
  const files = page.getByRole('group', { name: 'Attachments' });
  await files.getByRole('button', { name: 'Attach' }).click();
  await files.getByRole('menuitem', { name: 'Capture the whole page' }).click();
  const refused = page.locator('.fruitback-composer-file');
  await expect(refused).toHaveAttribute('data-fruitback-file', 'refused');
  await expect(refused).toContainText('Click the Fruitback icon in the toolbar, then try again.');
  await expect(refused).not.toContainText('not taken');
  await expect(field).toHaveValue('La capture est refusée');
});
