import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ACME, painted, rgb, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * Settings › Appearance (FRU-694): the theme, the mode, the tint of the sidebar, the accent, the
 * density, the radius and the size of the text. Each choice shows at once, as the tokens of
 * `theme.css` written on <html>, and stays at the next visit of this browser, written before the
 * first paint by `public/appearance.js`. `app/appearance.test.ts` computes the contrasts of every
 * theme; this spec reads what the browser paints. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';
const APPEARANCE = `${CONSOLE}/w/w1/account/appearance`;

/** A variable as the browser computes it on <html>. */
const token = (page: Page, name: string) =>
  page.evaluate((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

const rail = (page: Page) => page.locator('aside');

/** Presses a choice of a group as a person does: on its label, which holds the hidden radio. */
const choose = (page: Page, group: string, name: string) =>
  page
    .getByRole('radiogroup', { name: group })
    .locator('label')
    .filter({ has: page.getByRole('radio', { name, exact: true }) })
    .click();

test('a theme, a tint and an accent show at once, and stay at the next visit with no flash', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/account`);
  await page
    .getByRole('main')
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Appearance' })
    .click();
  await expect(page).toHaveURL(/\/w\/w1\/account\/appearance$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
  const themes = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(themes.getByRole('radio')).toHaveCount(5);
  // Slate is the default, and nothing is written on <html>.
  await expect(themes.getByRole('radio', { name: 'Slate (default)' })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeNull();
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#ffffff'));

  // Midnight: a dark page, at once, and the mode follows it.
  await choose(page, 'Theme', 'Midnight');
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#111a2e'));
  await expect(page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

  // An accent: the main button and the ring follow, the red of a deletion does not.
  await choose(page, 'Accent', 'Blue');
  expect(await token(page, '--accent')).toBe('#60a5fa');
  expect(await token(page, '--color-accent-strong')).toBe('#fca5a5');

  // The darkest sidebar.
  await choose(page, 'Sidebar', 'Ink');
  expect(await painted(rail(page), 'backgroundColor')).toEqual(rgb('#04070e'));

  // Density, radius and size of the text are tokens too.
  await choose(page, 'Density', 'Compact');
  await expect(page.getByText('32 px rows')).toBeVisible();
  expect(await token(page, '--spacing-row')).toBe('32px');
  await choose(page, 'Corner radius', '0');
  expect(await token(page, '--radius-control')).toBe('0px');
  await choose(page, 'Font size', '14');
  expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('14px');

  await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  // The next visit: the page is dark before the bundle runs, so it never shows Slate first.
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return;
      (window as unknown as { early: string }).early = getComputedStyle(document.body).backgroundColor;
    });
  });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  expect(await page.evaluate(() => (window as unknown as { early: string }).early)).toBe('rgb(17, 26, 46)');
  expect(await painted(rail(page), 'backgroundColor')).toEqual(rgb('#04070e'));
  const sites = await new AxeBuilder({ page }).analyze();
  expect(sites.violations.map((violation) => violation.id)).toEqual([]);

  // « Reset »: Slate again, nothing kept and nothing written.
  await page.goto(APPEARANCE);
  await page.getByRole('button', { name: 'Reset the appearance' }).click();
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#ffffff'));
  expect(await page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).toBe('');
  expect(await page.evaluate(() => localStorage.getItem('fruitback.appearance'))).toBeNull();
  await expect(
    page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Slate (default)' }),
  ).toBeChecked();
});

test('the page shows the kept choice from its first render, so a press builds on it (raised in review)', async ({
  page,
}) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('planted') !== null) return;
    sessionStorage.setItem('planted', '1');
    localStorage.setItem(
      'fruitback.appearance',
      JSON.stringify({ appearance: { mode: 'dark', dark: 'graphite', accent: 'teal' }, light: {}, dark: {} }),
    );
  });
  // Every theme drawn as chosen, from the first render on.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => {
      for (const label of document.querySelectorAll('.kit-pictures label[data-selected="true"]'))
        if (!seen.includes(label.textContent ?? '')) seen.push(label.textContent ?? '');
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-selected'] });
  });
  // By the navigation of the shell, as a person comes: a move between screens renders in a transition.
  await page.goto(`${CONSOLE}/w/w1/account`);
  await page
    .getByRole('main')
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Appearance' })
    .click();
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Graphite' })).toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual(['Graphite']);
  // A press keeps the rest of the choice.
  await choose(page, 'Density', 'Compact');
  const kept = await page.evaluate(
    () => JSON.parse(localStorage.getItem('fruitback.appearance') ?? 'null') as { appearance: Record<string, unknown> },
  );
  expect(kept.appearance).toMatchObject({ mode: 'dark', dark: 'graphite', accent: 'teal', density: 'compact' });
});

test('a choice made in another tab shows here, and the next press builds on it (raised in review)', async ({
  page,
  context,
}) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.goto(APPEARANCE);
  const other = await context.newPage();
  await stubWorker(other, { workspaces: [ACME] });
  await other.goto(APPEARANCE);
  await choose(other, 'Theme', 'Midnight');
  // This tab follows: the page, and the choice it draws.
  await expect.poll(() => painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#111a2e'));
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Midnight' })).toBeChecked();
  // A press here keeps the theme chosen there.
  await choose(page, 'Accent', 'Teal');
  const kept = await page.evaluate(
    () => JSON.parse(localStorage.getItem('fruitback.appearance') ?? 'null') as { appearance: Record<string, unknown> },
  );
  expect(kept.appearance).toMatchObject({ mode: 'dark', dark: 'midnight', accent: 'teal' });
  await other.close();
});

test('a browser that refuses to keep the choice shows it in this tab, and says so (raised in review)', async ({
  page,
}) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.goto(APPEARANCE);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await choose(page, 'Theme', 'Midnight');
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#111a2e'));
  await expect(page.getByRole('alert')).toHaveText(
    'This browser does not keep your choice: it shows in this tab only, until you close it.',
  );
});

test('an ink sidebar on a light theme writes its words light, and keeps its ring', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.goto(APPEARANCE);
  await choose(page, 'Sidebar', 'Ink');
  expect(await painted(rail(page), 'backgroundColor')).toEqual(rgb('#1e293b'));
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#ffffff'));
  const sites = rail(page).getByRole('link', { name: 'Sites', exact: true });
  expect(await painted(sites, 'color')).not.toEqual(rgb('#334155'));
  await sites.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  // The ring of the sidebar is the accent of a dark ground there.
  expect(await painted(sites, 'outlineColor')).toEqual(rgb('#dc2626'));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('« System » follows the system of the browser', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME] });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(APPEARANCE);
  await choose(page, 'Mode', 'System');
  expect(await painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#ffffff'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#111a2e'));
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => painted(page.locator('body'), 'backgroundColor')).toEqual(rgb('#ffffff'));
});

test('at 390 px in French nothing scrolls sideways', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME], locale: 'fr' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(APPEARANCE);
  await expect(page.getByRole('heading', { level: 1, name: 'Apparence' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
