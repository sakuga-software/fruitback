import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * `Confirm` (FRU-165), the gesture that asks twice, measured where the console uses it (FRU-191):
 * « Remove » a site, and « Disconnect » a source.
 *
 * The first press sends nothing and gives focus to « Keep it ». « Keep it » and Escape put the first
 * button back, with focus on it. Only the second button sends the `DELETE`.
 *
 * The worker is answered by stubs, which keep the `DELETE`s the console sent.
 */
const CONSOLE = 'http://localhost:5178';

const WORDS = {
  en: { keep: 'Keep it', remove: 'Remove', disconnect: 'Disconnect' },
  fr: { keep: 'Le garder', remove: 'Retirer', disconnect: 'Déconnecter' },
} as const;
type Locale = keyof typeof WORDS;

/** Answers the console, and returns the paths it sent a `DELETE` to. */
async function stubWorker(page: Page, locale: Locale): Promise<string[]> {
  const deleted: string[] = [];
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const site = { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' };
  const connector = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (request.method() === 'DELETE') {
      deleted.push(pathname);

      return route.fulfill({ status: 204 });
    }
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/sites') return json({ sites: [site] });
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [connector], available: true });
    if (pathname === '/console/workspaces/w1/connectors/c1/teams') return json({ teams: [] });

    return route.fulfill({ status: 204 });
  });

  return deleted;
}

/** What a screen needs to show its `Confirm`, and the `DELETE` its second button sends. */
const screens = [
  {
    name: 'a site',
    path: '/w/w1/sites',
    first: (locale: Locale) => WORDS[locale].remove,
    second: (locale: Locale) => (locale === 'en' ? 'Remove staging.acme.dev' : 'Retirer staging.acme.dev'),
    open: async (_page: Page) => {},
    deletes: '/console/workspaces/w1/sites/s1',
  },
  {
    name: 'a source',
    path: '/w/w1/connectors',
    first: (locale: Locale) => WORDS[locale].disconnect,
    second: (locale: Locale) => (locale === 'en' ? 'Disconnect Key of Ana' : 'Déconnecter Clé de Ana'),
    // The panel of the source opens from its row.
    open: (page: Page) => page.locator('button[aria-pressed]').first().click(),
    deletes: '/console/workspaces/w1/connectors/c1',
  },
] as const;

const sizes = [
  { width: 1440, height: 900, locale: 'en' },
  { width: 390, height: 844, locale: 'fr' },
] as const;

for (const screen of screens) {
  for (const { width, height, locale } of sizes) {
    test(`${screen.name} asks twice, and gives focus back, at ${width} px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const deleted = await stubWorker(page, locale);
      await page.goto(`${CONSOLE}${screen.path}`);
      await expect(page.locator('main h1')).toBeVisible();
      await screen.open(page);

      const first = page.getByRole('button', { name: screen.first(locale), exact: true });
      const keep = page.getByRole('button', { name: WORDS[locale].keep, exact: true });
      const second = page.getByRole('button', { name: screen.second(locale), exact: true });

      // The first press asks, sends nothing, and puts the keyboard on the way back.
      await first.click();
      await expect(second).toBeVisible();
      await expect(keep).toBeFocused();
      expect(deleted).toEqual([]);

      // « Keep it » puts the first button back, with focus on it.
      await keep.click();
      await expect(second).toHaveCount(0);
      await expect(first).toBeFocused();

      // Escape does the same, from the keyboard alone.
      await page.keyboard.press('Enter');
      await expect(keep).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(second).toHaveCount(0);
      await expect(first).toBeFocused();
      expect(deleted).toEqual([]);

      // Only the second button acts, once.
      await first.click();
      await second.click();
      await expect.poll(() => deleted).toEqual([screen.deletes]);
    });
  }
}
