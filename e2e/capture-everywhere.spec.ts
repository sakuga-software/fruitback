import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { BUILT_EXTENSION, test } from './extension.ts';

/**
 * « Allow captures on every site », in the preferences (FRU-425): `<all_urls>` in
 * `optional_host_permissions`, asked for by the options page only.
 *
 * Automation cannot answer the prompt of the browser, so the grant itself is not played. The spec
 * holds what is around it: the built manifest asks for nothing new at install, Chrome's prompt says
 * the words the row quotes, and the switch shows whether the browser holds the permission. That a
 * capture passes with `<all_urls>` and no gesture is `extension-capture.spec.ts`; that it is refused
 * without, and says to click the icon, is `extension-capture-refused.spec.ts`.
 */

/** The `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  management: { getPermissionWarningsByManifest(manifest: string): Promise<string[]> };
};

/** Chrome's prompt for `<all_urls>`, in the language of the browser, as the row quotes it. */
const CHROME_PROMPT: Record<string, string> = {
  en: 'Read and change all your data on all websites',
  fr: 'Lire et modifier toutes vos données sur tous les sites Web',
};

type BuiltManifest = { permissions?: string[]; optional_host_permissions?: string[]; host_permissions?: string[] };
const built = (): BuiltManifest =>
  JSON.parse(fs.readFileSync(path.join(BUILT_EXTENSION, 'manifest.json'), 'utf8')) as BuiltManifest;

test('<all_urls> is optional: nothing new at install, and Chrome names it as the row says', async ({ extension }) => {
  const manifest = built();
  expect(manifest.optional_host_permissions).toEqual(['*://*/*', '<all_urls>']);
  expect(manifest.host_permissions).toBeUndefined();
  const warnings = await extension.worker.evaluate(async (read) => {
    const before = { ...read, optional_host_permissions: ['*://*/*'] };
    const granted = { ...read, host_permissions: ['<all_urls>'] };

    return {
      now: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(read)),
      before: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(before)),
      granted: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(granted)),
    };
  }, manifest);
  expect(warnings.now).toEqual(warnings.before);
  // The row quotes these words, in English and in French (`messages.fr.ts`). The language of the
  // warnings is the one of the browser, which the runner sets: either one, and nothing else.
  expect(warnings.granted.filter((warning) => Object.values(CHROME_PROMPT).includes(warning))).toHaveLength(1);
});

test('the switch is off while the browser does not hold <all_urls>, and quotes its prompt', async ({ extension }) => {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html#prefs`);
  const row = options.locator('.pref-row').filter({ hasText: 'Allow captures on every site' });
  await expect(row).toContainText(
    'Your browser will say that Fruitback can “Read and change all your data on all websites”.',
  );
  await expect(row.getByRole('switch', { name: 'Allow captures on every site' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test.describe('with <all_urls> held', () => {
  test.use({ extraPermissions: ['<all_urls>'] });

  test('the switch is on', async ({ extension }) => {
    const options = await extension.context.newPage();
    await options.goto(`chrome-extension://${extension.id}/options.html#prefs`);
    await expect(options.getByRole('switch', { name: 'Allow captures on every site' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
