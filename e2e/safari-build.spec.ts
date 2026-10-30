import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The Safari build (FRU-380), loaded in Chromium. No automation drives Safari with an extension, so
 * this reads what the build alone decides: its manifest, its words, and the list of the page where
 * a browser has no side panel. Chromium gives an extension no `chrome.sidePanel` without the
 * `sidePanel` permission, which the Safari build does not ask for: the same absence Safari has.
 * Safari itself is not run here; see `docs/decisions/extension.md`, « Safari ».
 */

const SAFARI = 'apps/extension/.output/safari-mv3';

declare const chrome: {
  runtime: { getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]> };
};

test.use({ build: SAFARI });

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

test('the Safari build asks for no side panel and tells Safari its minimum (FRU-380)', () => {
  const manifest = JSON.parse(readFileSync(`${SAFARI}/manifest.json`, 'utf8')) as Record<string, unknown>;

  expect(manifest.permissions).toEqual(['storage', 'scripting', 'activeTab', 'alarms', 'contextMenus']);
  expect(manifest.side_panel).toBeUndefined();
  expect(manifest.sidebar_action).toBeUndefined();
  expect(manifest.browser_specific_settings).toEqual({ safari: { strict_min_version: '16.4' } });
  expect(manifest.optional_host_permissions).toEqual(['*://*/*', '<all_urls>']);
});

test('the preferences of the Safari build name Safari, and offer no panel and no synced rules (FRU-380)', async ({
  extension,
}) => {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  const prefs = options.locator('section#prefs');
  // The control is `extension-page.spec.ts`: the Chrome build has « Open notes in the sidebar » first.
  await expect(prefs.locator('.pref-title')).toHaveText([
    'Name on my notes',
    'Show CSS selectors',
    'Corner of the widget',
    'Allow captures on every site',
    'Leave feedback shortcut',
  ]);
  await expect(prefs.getByText('Change it in Safari Settings, Extensions.')).toBeVisible();
  await expect(prefs.getByText(/^Your browser will ask you to allow Fruitback on every website\./)).toBeVisible();
  await expect(prefs.getByText(/Manage Extension Shortcuts/)).toHaveCount(0);
});

test('with no side panel, the button of the widget opens the list of the page (FRU-380)', async ({ extension }) => {
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'safari-panel-button');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await popup.close();

  await page.getByRole('button', { name: /Show every note in a sidebar/ }).click();
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();
  expect(
    await extension.worker.evaluate(
      async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
    ),
  ).toBe(0);
});
