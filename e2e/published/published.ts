import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { hydrated, caseOf } from '../pin.ts';

/**
 * What `fetch.ts` wrote, and the moves that the published specs share (FRU-460).
 *
 * These specs drive the published code with the words of its own interface. They do not use the
 * helpers of `extension.ts` that click through the popup or the options page: those follow `main`,
 * and the copy that people have is older. A release that changes these words changes these specs.
 */

export const PUBLISHED = '.published';
export const PUBLISHED_EXTENSION = `${PUBLISHED}/extension`;
export const PUBLISHED_NPM = `${PUBLISHED}/npm/node_modules`;
/** The IIFE of the snippet of the README, as `@fruitback/widget` publishes it. */
export const PUBLISHED_IIFE = `${PUBLISHED_NPM}/@fruitback/widget/dist/fruitback.iife.js`;
export const PUBLISHED_ELEMENT = `${PUBLISHED_NPM}/@fruitback/element/dist/fruitback-element.iife.js`;
/** `import { init } from 'fruitback'`, bundled by `fetch.ts`. It sets `FruitbackFromNpm`. */
export const PUBLISHED_IMPORT = `${PUBLISHED}/fruitback-import.js`;

/**
 * Every name that the browser looks up resolves to nothing, except `localhost`. The published
 * extension holds the address of the real Cloud, and a run of CI must never reach it.
 */
export const NO_NETWORK_BUT_LOCALHOST = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost';

export function publishedVersions(): { npm: string; extension: string } {
  const file = `${PUBLISHED}/versions.json`;
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. Run node e2e/published/fetch.ts first.`);

  return JSON.parse(fs.readFileSync(file, 'utf8')) as { npm: string; extension: string };
}

/** The playground with no widget of its own, on a page of this spec. */
export async function openBareSite(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?case=${caseOf(testCase)}&widget=off`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await hydrated(page);
}

/** A note on the latte card, with the composer of the published widget. */
export async function plantOnTheLatteCard(page: Page, launch: string | RegExp, note: string): Promise<void> {
  await page.getByRole('button', { name: launch }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
}
