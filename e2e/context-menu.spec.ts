import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import {
  BUILT_EXTENSION,
  PLAYGROUND_ORIGIN,
  addRule,
  mintPairing,
  openBareSite,
  pairFromPopup,
  test,
} from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Capture with Fruitback », in the context menu of a page (FRU-423).
 *
 * A click on the item is a gesture that grants `activeTab`, which an automated browser cannot make:
 * nothing can click a menu of the browser. So the spec holds the three parts around the click: the
 * manifest asks for `contextMenus` and Chrome shows no new warning for it; the background places the
 * item; and the command the item sends starts the capture of an area in the open composer of the
 * widget the extension mounted. This copy holds `<all_urls>`, so the capture is taken without the
 * gesture (measured in FRU-44): what is checked is the path from the command to the file.
 */
test.use({ extraPermissions: ['<all_urls>'] });

/** The `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  management: { getPermissionWarningsByManifest(manifest: string): Promise<string[]> };
  contextMenus: { update(id: string, properties: Record<string, never>): Promise<void> };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(filter: { url: string }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const REVIEWER = 'E2E Context Menu';

test('the manifest asks for contextMenus, and Chrome shows no new warning for it', async ({ extension }) => {
  const built = JSON.parse(fs.readFileSync(path.join(BUILT_EXTENSION, 'manifest.json'), 'utf8')) as {
    permissions?: string[];
  };
  expect(built.permissions).toContain('contextMenus');
  const warnings = await extension.worker.evaluate(async (manifest) => {
    const before = { ...manifest, permissions: (manifest.permissions ?? []).filter((each) => each !== 'contextMenus') };

    return {
      now: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(manifest)),
      before: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(before)),
    };
  }, built);
  expect(warnings.now).toEqual(warnings.before);
});

test('the item is in the context menu, and its command captures an area in the open composer', async ({
  extension,
}) => {
  // The item is there: `update` of an id that is not there is refused.
  await expect(
    extension.worker.evaluate(() => chrome.contextMenus.update('fruitback-capture', {}).then(() => 'placed')),
  ).resolves.toBe('placed');

  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-context-menu');
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  // The site of the workspace, as the one click of FRU-101 stores it: the extension mounts the widget.
  await extension.worker.evaluate(async (origin) => {
    const { sites } = (await chrome.storage.local.get('sites')) as { sites: Record<string, Record<string, unknown>> };
    await chrome.storage.local.set({
      sites: { ...sites, [origin]: { ...sites[origin], mount: { clientId: 'playground' } } },
    });
  }, PLAYGROUND_ORIGIN);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();

  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const field = page.getByPlaceholder('What should change?');
  await field.fill('Capturé par le menu');

  // What the background does on a click of the item: the command to the tab.
  const sent = await extension.worker.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    if (tab?.id === undefined) return 'no tab';

    return chrome.tabs.sendMessage(tab.id, { type: 'fruitback-tab-command', command: 'capture-area' });
  }, PLAYGROUND_ORIGIN);
  expect(sent).toMatchObject({ done: true });
  await expect(page.getByRole('dialog', { name: 'Choose an area of the page' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.fruitback-composer-file')).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name')).toHaveText('area.png');
  await expect(field).toHaveValue('Capturé par le menu');
});
