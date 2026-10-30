import { expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The button of the widget that shows every note opens the side panel of the extension (FRU-469),
 * and not the list of the page.
 */

declare const chrome: {
  runtime: { getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]> };
};

const NAME = 'Camille Durand';

async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: /^(Pair with this worker|Se connecter à ce serveur)$/ }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

test('the button of the widget that shows every note opens the side panel of the extension (FRU-469)', async ({
  extension,
}) => {
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'panel-button');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await popup.close();
  const panels = () =>
    extension.worker.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((context) => context.documentUrl),
    );
  expect(await panels()).toEqual([]);

  await page.getByRole('button', { name: /Show every note in a sidebar/ }).click();
  await expect.poll(panels).toEqual([`chrome-extension://${extension.id}/sidepanel.html`]);
  // The panel shows the notes: the list of the page stays closed.
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeHidden();
});
