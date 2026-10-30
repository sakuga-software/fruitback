import { type BrowserContext, type Page, expect } from '@playwright/test';
import { addRule, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/** The `chrome.*` calls of these specs, from the service worker and the pages of the extension. */
declare const chrome: {
  permissions?: Record<string, unknown>;
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: object): Promise<void>;
    };
  };
};

/**
 * What the popup and the options page do when a call of the browser throws (FRU-510).
 *
 * A call that throws is rare, and nothing in a real browser makes one throw on demand. So each spec
 * replaces one function of `chrome.permissions` in the pages of the extension before they load. The
 * service worker keeps the real one.
 */

/** `chrome.permissions[name]`, in every page of the extension, rejects. */
async function rejectInPages(context: BrowserContext, name: 'getAll' | 'request'): Promise<void> {
  await context.addInitScript((method) => {
    // A page of a site has no `chrome.permissions`: only the pages of the extension are changed.
    const permissions = typeof chrome === 'undefined' ? undefined : chrome.permissions;
    if (permissions === undefined) return;
    permissions[method] = () => Promise.reject(new Error(`FRU-510: ${method} failed`));
  }, name);
}

async function openOptions(page: Page, id: string): Promise<void> {
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.getByRole('heading', { level: 1, name: /^Sites$/ })).toBeVisible();
}

/** A team rule on the worker that keeps sessions: its card in the options page offers to pair. */
async function teamRuleOnTheSessionWorker(worker: { evaluate: Page['evaluate'] }): Promise<void> {
  await worker.evaluate(async (endpoint) => {
    await chrome.storage.local.set({
      sites: { 'https://team.elsewhere.example': { mode: 'team', endpoint, enabled: false } },
    });
  }, AUTHENTICATED_WORKER_ORIGIN);
}

test.describe('the access of a site', () => {
  // The click on the toolbar gives the popup the address of the tab (`activeTab`): `tabs` stands for it.
  test.use({ extraPermissions: ['tabs'] });

  test('a read of the granted sites that fails shows the card that asks for the access again (FRU-510)', async ({
    extension,
  }) => {
    // A rule that is on, for an origin the copy of the extension holds: with the real `getAll`, the
    // popup draws the site turned on.
    await extension.worker.evaluate(async (pattern) => {
      await chrome.storage.local.set({
        sites: { [pattern]: { endpoint: pattern, enabled: true, mode: 'private', clientId: 'playground' } },
      });
    }, WORKER_ORIGIN);
    const site = await extension.context.newPage();
    await site.goto(`${WORKER_ORIGIN}/health`);
    const allow = /^(Allow access again|Autoriser à nouveau)$/;

    // The control: the access is read, and it is held.
    const read = await openPopup(extension, site);
    await expect(read.getByText(/^(On|Activé) · playground$/)).toBeVisible();
    await expect(read.getByRole('button', { name: allow })).toHaveCount(0);
    await read.close();

    // The read fails: the popup does not know that the access is held, so it offers to ask for it.
    await rejectInPages(extension.context, 'getAll');
    const failed = await openPopup(extension, site);
    await expect(failed.getByRole('button', { name: allow })).toBeVisible();
  });
});

test('a pairing whose permission request throws gives « Pair » back, with the reason (FRU-510)', async ({
  extension,
}) => {
  await teamRuleOnTheSessionWorker(extension.worker);
  await rejectInPages(extension.context, 'request');
  const page = await extension.context.newPage();
  await openOptions(page, extension.id);
  const card = page.locator(`.worker-card[data-endpoint="${AUTHENTICATED_WORKER_ORIGIN}"]`);

  await card.getByLabel('Pairing code').fill('AAAA-BBBB-CCCC');
  await card.getByRole('button', { name: 'Pair' }).click();
  await expect(card.getByRole('status')).toContainText('Fruitback needs permission to reach that worker.');
  await expect(card.getByRole('button', { name: 'Pair' })).toBeEnabled();
});

test('a pairing from the popup whose permission request throws gives the button back, with the reason (FRU-510)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  await rejectInPages(extension.context, 'request');
  const site = await extension.context.newPage();
  await openBareSite(site, 'fru-510-popup-pairing');
  const popup = await openPopup(extension, site);

  await popup.getByRole('button', { name: 'I have a code' }).click();
  await popup.getByLabel('Pairing code').fill('AAAA-BBBB-CCCC');
  const submit = popup.getByRole('button', { name: 'Pair with this worker' });
  await submit.click();
  await expect(popup.getByText('Fruitback needs permission to reach that worker.')).toBeVisible();
  await expect(submit).toBeEnabled();
});

test('a log out from the options page asks again which language to keep (FRU-510)', async ({ extension }) => {
  await teamRuleOnTheSessionWorker(extension.worker);
  const page = await extension.context.newPage();
  await openOptions(page, extension.id);
  const card = page.locator(`.worker-card[data-endpoint="${AUTHENTICATED_WORKER_ORIGIN}"]`);
  const { code } = await mintPairing('Camille Durand');
  await card.getByLabel('Pairing code').fill(code);
  await card.getByRole('button', { name: 'Pair' }).click();
  await expect(card.locator('.worker-who')).toContainText('Camille Durand');

  // The language that the account of this session said, as the popup keeps it.
  await extension.worker.evaluate(() => chrome.storage.local.set({ language: 'fr' }));

  await card.getByRole('button', { name: /^(Log out|Se déconnecter)$/ }).click();
  await expect(card.getByLabel(/^(Pairing code|Code de connexion)$/)).toBeVisible();
  // No session is left, so no account speaks for the language: the language of the browser is read.
  await expect
    .poll(() => extension.worker.evaluate(async () => (await chrome.storage.local.get('language')).language))
    .toBeUndefined();
});
