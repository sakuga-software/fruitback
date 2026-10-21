import { type Page, expect, test } from '@playwright/test';
import { stubWorker } from './console-workspace.ts';
import { LANGUAGES, LONG_NOTE, LONG_WORD, WIDTHS, overflows } from './overflow.ts';

/**
 * No text of the console of the Cloud runs past its box or past the screen (FRU-350): the screens of
 * a workspace and the sign-in, at 320, 390 and 1280 px, in English and in French, with long data — a
 * long host, a long workspace name, a long account, a note with an address and a word with no space.
 */
const CONSOLE = 'http://localhost:5178';
const SHOTS = process.env.FRUITBACK_WRAP_SHOTS;
const LONG_HOST = 'preview-branch-feature-very-long-name-1234.staging.acme-international-holdings.dev';
const SCREENS = ['sites', 'notes', 'connectors', 'members', 'account'] as const;

async function longData(page: Page, locale: 'en' | 'fr'): Promise<void> {
  await stubWorker(page, {
    locale,
    workspaces: [{ id: 'w1', name: `Acme ${LONG_WORD} Holdings International`, role: 'owner' }],
    sites: [{ id: 's1', origin: `https://${LONG_HOST}`, visibility: 'members' }],
    answer: (pathname, route) => {
      if (pathname === '/console/me') {
        return route.fulfill({
          json: {
            account: {
              id: 'a1',
              email: `marie-antoinette.de-la-rochefoucauld-montmorency@${LONG_HOST}`,
              name: 'Marie-Antoinette de La Rochefoucauld-Montmorency',
              locale,
            },
            workspaces: [{ id: 'w1', name: `Acme ${LONG_WORD} Holdings International`, role: 'owner' }],
          },
        });
      }
      if (pathname === '/console/workspaces/w1/notes') {
        const note = {
          id: 'n1',
          excerpt: LONG_NOTE,
          page: {
            url: `https://${LONG_HOST}/checkout/payment-method/confirmation`,
            host: LONG_HOST,
            path: '/checkout/payment-method/confirmation',
          },
          site: { id: 's1' },
          stage: 'ripening',
          author: { kind: 'anonymous' },
          place: { kind: 'fruitback' },
          createdAt: '2026-10-13T08:00:00.000Z',
        };

        return route.fulfill({ json: { notes: [note], total: 1, counts: { all: 1, byPlace: { fruitback: 1 } } } });
      }

      return undefined;
    },
  });
}

async function expectNothingRunsPast(page: Page, where: string, shot: string): Promise<void> {
  await page.waitForTimeout(300);
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/console-${shot}.png`, fullPage: true });
  expect.soft(await overflows(page), where).toEqual([]);
}

for (const width of WIDTHS) {
  for (const language of LANGUAGES) {
    test(`the console at ${width} px in ${language}: nothing runs past its box (FRU-350)`, async ({ page }) => {
      const at = `${width}-${language}`;
      await page.setViewportSize({ width, height: 900 });
      await longData(page, language);
      for (const screen of SCREENS) {
        await page.goto(`${CONSOLE}/w/w1/${screen}`);
        await expect(page.locator('main h1')).toBeVisible();
        await expectNothingRunsPast(page, `${at}: ${screen}`, `${at}-${screen}`);
      }
    });
  }
}
