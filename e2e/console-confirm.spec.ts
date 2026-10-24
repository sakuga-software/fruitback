import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * `Confirm` (FRU-165), the gesture that asks twice, measured where the console uses it (FRU-191):
 * « Remove » a site, and « Disconnect » a source.
 *
 * The first press sends nothing and gives focus to « Keep it ». « Keep it » and Escape put the row
 * back as it was, with focus on what asked. Only the second button sends the `DELETE`.
 *
 * The worker is answered by stubs, which keep the `DELETE`s the console sent.
 */
const CONSOLE = 'http://localhost:5178';

const WORDS = {
  en: { keep: 'Keep it', remove: 'Remove', disconnect: 'Disconnect Linear' },
  fr: { keep: 'Le garder', remove: 'Retirer', disconnect: 'Déconnecter Linear' },
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
    if (pathname === '/console/workspaces/w1/domains') return json({ domains: [] });
    if (pathname === '/console/workspaces/w1/sites') return json({ sites: [site] });
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [connector], available: true });
    if (pathname === '/console/workspaces/w1/connectors/c1/teams') return json({ teams: [] });

    return route.fulfill({ status: 204 });
  });

  return deleted;
}

/**
 * What a screen needs to ask the first time, and the `DELETE` its second button sends.
 *
 * A source asks with a button of its panel, and a site with a button of its page (FRU-433): that
 * button is what has focus before, and what takes it back.
 */
const screens = [
  {
    name: 'a site',
    // The page of the site asks (FRU-433): its button « Remove » is what has focus before, and takes it back.
    path: '/w/w1/sites/s1',
    back: (page: Page, locale: Locale) => page.getByRole('button', { name: WORDS[locale].remove, exact: true }),
    ask: (page: Page, locale: Locale) => page.getByRole('button', { name: WORDS[locale].remove, exact: true }).click(),
    askWithKeys: (page: Page) => page.keyboard.press('Enter'),
    second: (locale: Locale) => (locale === 'en' ? 'Remove staging.acme.dev' : 'Retirer staging.acme.dev'),
    open: async (_page: Page) => {},
    deletes: '/console/workspaces/w1/sites/s1',
  },
  {
    name: 'a source',
    path: '/w/w1/connectors',
    back: (page: Page, locale: Locale) => page.getByRole('button', { name: WORDS[locale].disconnect, exact: true }),
    ask: (page: Page, locale: Locale) =>
      page.getByRole('button', { name: WORDS[locale].disconnect, exact: true }).click(),
    askWithKeys: (page: Page) => page.keyboard.press('Enter'),
    second: (locale: Locale) => (locale === 'en' ? 'Disconnect Key of Ana' : 'Déconnecter Clé de Ana'),
    // The panel of the source opens from its row.
    open: (page: Page) => page.locator('button[id^="source-row-"]').first().click(),
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

      const back = screen.back(page, locale);
      const keep = page.getByRole('button', { name: WORDS[locale].keep, exact: true });
      const second = page.getByRole('button', { name: screen.second(locale), exact: true });

      // The first press asks, sends nothing, and puts the keyboard on the way back.
      await screen.ask(page, locale);
      await expect(second).toBeVisible();
      await expect(keep).toBeFocused();
      expect(deleted).toEqual([]);

      // « Keep it » puts the row back as it was, with focus on what asked.
      await keep.click();
      await expect(second).toHaveCount(0);
      await expect(back).toBeFocused();

      // Escape does the same, from the keyboard alone.
      await screen.askWithKeys(page);
      await expect(keep).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(second).toHaveCount(0);
      await expect(back).toBeFocused();
      expect(deleted).toEqual([]);

      // Only the second button acts, once.
      await screen.ask(page, locale);
      await second.click();
      await expect.poll(() => deleted).toEqual([screen.deletes]);
    });
  }
}
