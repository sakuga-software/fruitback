import { expect } from '@playwright/test';
import { addRule, openBareSite, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The key that starts a note (FRU-291): a command of the manifest, which the browser runs.
 *
 * **A key that Playwright presses never reaches a command.** Its keys go to the renderer of the page
 * through CDP, and a command is caught by the browser before that: measured, `Alt+Shift+F` from
 * `page.keyboard` left the widget as it was. So the spec reads what the browser installed, and sends
 * from the service worker the message `runShortcut` sends. That is the half that can break in
 * silence: the bridge takes commands from the pages of the extension only, and the service worker
 * is not a page. `shortcut.test.ts` holds the listener itself.
 */

declare const chrome: {
  commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
  tabs: {
    query(info: { url: string }): Promise<{ id?: number }[]>;
    sendMessage(id: number, message: unknown): Promise<unknown>;
  };
};

/** `Alt+Shift+F` on Linux and Windows; macOS writes it with its own symbols. */
const SUGGESTED = /^(Alt\+Shift\+F|⌥⇧F)$/;

test('the browser installs the command with Alt+Shift+F', async ({ extension }) => {
  const commands = await extension.worker.evaluate(() => chrome.commands.getAll());
  const shortcut = commands.find((command) => command.name === 'leave-feedback');

  expect(shortcut?.shortcut).toMatch(SUGGESTED);
});

test('what the shortcut sends starts a capture on the tab, and Esc stops it', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-shortcut');
  // By its attribute: the capsule hides it while a capture runs (FRU-303), and a role query skips it.
  const launch = page.locator('[data-fruitback-host-launch]');
  await expect(launch).toHaveText('Leave feedback');
  await expect(launch).toHaveAttribute('aria-pressed', 'false');

  // The message of `runShortcut`, sent from where the listener runs.
  const answer = await extension.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:5177/*' });
    if (tab?.id === undefined) throw new Error('no tab of the playground');

    return chrome.tabs.sendMessage(tab.id, { type: 'fruitback-tab-command', command: 'leave-feedback' });
  });

  expect(answer).toEqual({ done: true });
  await expect(launch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-fruitback-host-banner]')).toContainText('Esc');

  await page.keyboard.press('Escape');
  await expect(launch).toHaveAttribute('aria-pressed', 'false');
});

test('the options page shows the key, and the way to change it', async ({ extension }) => {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  // FRU-302: the line is a row of « Preferences », the keys in the `kbd` of the kit.
  const row = options.locator('section#prefs .pref-row').filter({ hasText: 'Leave feedback shortcut' });

  await expect(row.locator('kbd')).toHaveText([/^(Alt|⌥)$/, /^(Shift|⇧)$/, 'F']);

  const opened = extension.context.waitForEvent('page');
  await row.getByRole('button', { name: 'Change' }).click();
  await expect.poll(async () => (await opened).url()).toBe('chrome://extensions/shortcuts');
});
