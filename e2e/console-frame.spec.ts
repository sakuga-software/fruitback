import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import {
  ACME,
  type Box,
  LUMEN,
  box,
  contrast,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * The frame of a workspace (FRU-234) with the compact bar of FRU-684, measured in a browser against
 * option A of its mockup (« Barre latérale (3 options) », attached to the ticket): the workspace and
 * the search, the sections, the fixed foot, and the room it gives a screen. Under 1024 px the bar is
 * folded above the screen.
 *
 * The values are read in the code of the mockup. The heights of the bar are fixed (28 px an entry,
 * 40 px the head and the person), so its boxes are compared with every font. The worker is answered
 * by stubs.
 */
const CONSOLE = 'http://localhost:5178';
/**
 * The development server of the console, for `/kit` alone: a build has no `/kit` (`kit-route.test.ts`),
 * and the specs serve the console built on 5178 (FRU-473, `playwright.config.ts`).
 */
const KIT = 'http://localhost:5179';

/** The colours of the mockup of FRU-684. */
const BAR = '#f1f4f8';
const LINE = '#e3e8ef';
const ACTIVE = '#e2e8f0';
/** An entry under the pointer: `hover` of the slate theme (FRU-683), a step lighter than the one on screen. */
const HOVER = '#e8edf3';
const INK = '#0f172a';
const ENTRY_TEXT = '#334155';
const SECONDARY = '#5b6779';
/** `accent-strong`: the mockup draws #b42320, a step from the red of the console that the bar names by its token. */
const ALERT = '#b91c1c';
const WHITE = '#ffffff';

const SECTIONS = ['Notes', 'Sites', 'Connectors', 'Members', 'Settings'];

const rail = (page: Page) => page.locator('aside.kit-rail');
const sections = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const switcher = (page: Page) => rail(page).getByRole('button', { name: /^Acme/ });
const person = (page: Page) => rail(page).getByRole('button', { name: /@/ });
const toggle = (page: Page) => rail(page).getByRole('button', { name: 'Menu' });

async function open(page: Page, screen = 'sites', workspace = 'w1'): Promise<void> {
  await page.goto(`${CONSOLE}/w/${workspace}/${screen}`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** The bar with every section, « Notes » on screen, and the counts of the mockup: a page of the development server. */
async function openProbe(page: Page): Promise<void> {
  // The bar asks the worker which browsers of the extension are connected (FRU-441): with no worker,
  // the console says it cannot reach it, above the bar.
  await stubWorker(page);
  await page.goto(`${KIT}/kit/frame`);
  await expect(sections(page)).toBeVisible();
}

/** Each side of a box, within 1 px: the bar has fixed heights, so no font moves them. */
function expectAt(found: Box, expected: Partial<Box>, name: string): void {
  for (const [side, value] of Object.entries(expected) as [keyof Box, number][]) {
    expect
      .soft(Math.abs(found[side] - value), `${name}: ${side} is ${found[side]}, expected ${value}`)
      .toBeLessThanOrEqual(1);
  }
}

test('at 1440 px the bar has the values of the mockup', async ({ page }) => {
  await stubWorker(page);
  await open(page);

  // 232 px, the tint of the bar, a rule on its right. No dark rail.
  expect
    .soft(
      await styles(rail(page), ['width', 'padding-top', 'border-right-width', 'border-right-style', 'flex-direction']),
    )
    .toEqual({
      width: '232px',
      'padding-top': '4px',
      'border-right-width': '1px',
      'border-right-style': 'solid',
      'flex-direction': 'column',
    });
  expect.soft(await painted(rail(page), 'backgroundColor')).toEqual(rgb(BAR));
  expect.soft(await painted(rail(page), 'borderRightColor')).toEqual(rgb(LINE));

  // The workspace: a tile, the name, a chevron, and a button that opens a menu.
  const name = switcher(page);
  await expect(name).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  expect
    .soft(
      await styles(name, [
        'height',
        'padding-left',
        'border-top-left-radius',
        'column-gap',
        'font-size',
        'font-weight',
      ]),
    )
    .toEqual({
      height: '32px',
      'padding-left': '6px',
      'border-top-left-radius': '6px',
      'column-gap': '8px',
      'font-size': '13px',
      'font-weight': '600',
    });
  const tile = name.locator('span[aria-hidden="true"]').first();
  await expect(tile).toHaveText('A');
  expect.soft(await styles(tile, ['width', 'height', 'border-top-left-radius', 'font-size', 'font-weight'])).toEqual({
    width: '20px',
    height: '20px',
    'border-top-left-radius': '4px',
    'font-size': '11px',
    'font-weight': '700',
  });
  expect.soft(await painted(tile, 'backgroundColor')).toEqual(rgb(INK));
  expect.soft(await painted(tile, 'color')).toEqual(rgb(WHITE));
  const chevron = name.locator('svg[data-rail-icon="chevron"]');
  expect.soft(await styles(chevron, ['width', 'height'])).toEqual({ width: '14px', height: '14px' });
  expect.soft(await painted(chevron, 'color')).toEqual(rgb(SECONDARY));

  // The search, beside it: 28 px.
  const search = rail(page).getByRole('link', { name: 'Search notes' });
  expect.soft(await styles(search, ['width', 'height', 'border-top-left-radius'])).toEqual({
    width: '28px',
    height: '28px',
    'border-top-left-radius': '6px',
  });

  // The sections: 28 px, 8 px in, the icon 16 px, the one on screen tinted and in 600.
  const entry = ['height', 'padding-left', 'padding-right', 'border-top-left-radius', 'column-gap', 'font-size'];
  const active = sections(page).getByRole('link', { name: 'Sites' });
  expect.soft(await styles(active, [...entry, 'font-weight'])).toEqual({
    height: '28px',
    'padding-left': '8px',
    'padding-right': '8px',
    'border-top-left-radius': '6px',
    'column-gap': '8px',
    'font-size': '13px',
    'font-weight': '600',
  });
  expect.soft(await painted(active, 'backgroundColor')).toEqual(rgb(ACTIVE));
  expect.soft(await painted(active, 'color')).toEqual(rgb(INK));
  const resting = sections(page).getByRole('link', { name: 'Members' });
  expect.soft(await styles(resting, [...entry, 'font-weight'])).toMatchObject({ height: '28px', 'font-weight': '500' });
  expect.soft(await painted(resting, 'color')).toEqual(rgb(ENTRY_TEXT));
  // No drop on the entry on screen any more (FRU-413 is gone with the dark rail).
  await expect(active.locator('span[aria-hidden="true"]')).toHaveCount(0);
  await expect(sections(page).locator('a svg[data-rail-icon]')).toHaveCount(SECTIONS.length);
  const icon = resting.locator('svg');
  await expect(icon).toHaveAttribute('data-rail-icon', 'members');
  expect.soft(await styles(icon, ['width', 'height'])).toEqual({ width: '16px', height: '16px' });
  expect.soft(await painted(icon, 'color')).toEqual(rgb(SECONDARY));

  // The boxes of the mockup: the head is 40 px under 4 px, the entries start at 48 and are 29 px apart.
  const bar = await box(rail(page));
  expectAt(bar, { x: 0, y: 0, width: 232, height: 900 }, 'the bar');
  expectAt(await box(name), { x: 6, y: 8, height: 32 }, 'the workspace');
  expectAt(await box(search), { x: 198, y: 10, width: 28, height: 28 }, 'the search');
  for (const [index, label] of SECTIONS.entries()) {
    expectAt(
      await box(sections(page).getByRole('link', { name: label, exact: true })),
      { x: 6, y: 48 + 29 * index, width: 220, height: 28 },
      label,
    );
  }

  // The fixed foot, from the bottom of the bar: the person (40 px, 8 px above the bottom), a rule,
  // « Help and docs », the extension and « What's new », 29 px apart.
  expectAt(await box(person(page)), { x: 6, y: 900 - 8 - 40, width: 220, height: 40 }, 'the person');
  const help = rail(page).getByRole('link', { name: 'Help and docs' });
  expectAt(await box(help), { x: 6, y: 900 - 8 - 40 - 1 - 13 - 1 - 28, height: 28 }, 'the help');
  const extension = rail(page).getByRole('link', { name: 'Install the extension (beta)' });
  expectAt(await box(extension), { y: 900 - 8 - 40 - 1 - 13 - 1 - 28 - 29, height: 28 }, 'the extension');
  const news = rail(page).getByRole('link', { name: /^What's new/ });
  expectAt(await box(news), { y: 900 - 8 - 40 - 1 - 13 - 1 - 28 - 58, height: 28 }, 'What’s new');
  const rule = rail(page).locator('hr');
  expect.soft(await styles(rule, ['height', 'margin-top', 'margin-bottom'])).toEqual({
    height: '1px',
    'margin-top': '6px',
    'margin-bottom': '6px',
  });
  expect.soft(await painted(rule, 'backgroundColor')).toEqual(rgb(LINE));

  // The person: the initial on a disc of 24 px, the name in 600 and the address in the secondary text.
  const initial = person(page).locator('span[aria-hidden="true"]').first();
  expect.soft(await styles(initial, ['width', 'height'])).toEqual({ width: '24px', height: '24px' });
  // A disc: `rounded-full` computes to a radius far over half its side.
  expect
    .soft(Number.parseFloat((await styles(initial, ['border-top-left-radius']))['border-top-left-radius'] ?? '0'))
    .toBeGreaterThanOrEqual(12);
  await expect(person(page)).toContainText('Ana');
  expect.soft(await painted(person(page).getByText('ana@acme.dev'), 'color')).toEqual(rgb(SECONDARY));
});

test('the room of a screen is as wide as the column beside the bar, with the padding of the mockup (FRU-398)', async ({
  page,
}) => {
  await stubWorker(page);
  for (const screen of ['sites', 'notes', 'connectors', 'members', 'account']) {
    await open(page, screen);
    const main = page.locator('main');
    expect
      .soft(await styles(main, ['max-width', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right']), screen)
      .toEqual({
        'max-width': 'none',
        'padding-top': '40px',
        'padding-bottom': '72px',
        // clamp(16px, 4vw, 48px) at 1440 px.
        'padding-left': '48px',
        'padding-right': '48px',
      });
    // The room ends at the right edge of the window: all of what the bar leaves (1208 px).
    const room = await box(main);
    expect.soft(Math.abs(room.x + room.width - 1440), `the right edge of the room of ${screen}`).toBeLessThanOrEqual(1);
    expectAt(room, { x: 232, y: 0, width: 1208 }, `the room of ${screen}`);
    // FRU-686: the title of Notes is in its head of 48 px, from the edge of the room: 20 px in. So is
    // the title of Sites since FRU-688.
    // My account is a page of the shell of the settings (FRU-692): its title is under the bar of the
    // shell, after its navigation. `console-account.spec.ts` holds it.
    if (screen === 'notes' || screen === 'sites')
      expectAt(await box(page.locator('main h1')), { x: 252, y: 14 }, `the title of ${screen}`);
    else if (screen !== 'account')
      expectAt(await box(page.locator('main h1')), { x: 280, y: 40 }, `the title of ${screen}`);
  }
  const content = page.locator('main').locator('..');
  expect.soft(await styles(content, ['flex-grow', 'flex-shrink', 'flex-basis', 'min-width'])).toEqual({
    'flex-grow': '999',
    'flex-shrink': '1',
    'flex-basis': '640px',
    'min-width': '0px',
  });
});

/**
 * FRU-564: the room of a screen fills the height of the window, also when what it shows is short.
 * Under 1024 px it starts under the folded bar, which keeps its own height.
 */
test('the room of a screen fills the height of the window, under the folded bar on a phone (FRU-564)', async ({
  page,
}) => {
  await stubWorker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const screen of ['connectors', 'sites']) {
    await open(page, screen);
    // The control: the screen is shorter than the window, so a room sized by it would end higher.
    const content = await page
      .locator('main > *')
      .evaluateAll((children) => Math.max(...children.map((child) => child.getBoundingClientRect().bottom)));
    expect.soft(content, `what ${screen} shows`).toBeLessThan(900 - 72 - 40);
    const room = await box(page.locator('main'));
    expect.soft(room.y + room.height, `the bottom of the room of ${screen}`).toBeCloseTo(900, 0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'connectors');
  const top = await box(rail(page));
  const room = await box(page.locator('main'));
  expect.soft(room.y, 'the room starts under the bar').toBeCloseTo(top.y + top.height, 0);
  expect.soft(room.y + room.height, 'the bottom of the room at 390 px').toBeGreaterThanOrEqual(844 - 1);
  // The folded bar is its head alone: 4 px, 40 px, and its rule.
  expectAt(top, { x: 0, y: 0, width: 390, height: 45 }, 'the folded bar');
  expect.soft(await sideScroll(page)).toBe(0);
});

test('the bar is as high as the window and stays while the screen scrolls; under 1024 px it scrolls away (FRU-402)', async ({
  page,
}) => {
  await stubWorker(page);
  // A window lower than « My account »: the document scrolls. At 1100 px its cards are one column
  // (FRU-692), about 860 px high; at 1440 px they are two, and 537 px high with these stubs.
  await page.setViewportSize({ width: 1100, height: 400 });
  await open(page, 'account');
  expect.soft(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(400 + 200);

  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(200);
  expect.soft(await box(rail(page)), 'the bar after a scroll of 200 px').toMatchObject({ x: 0, y: 0, height: 400 });
  // The screen moved, and the person is still at the bottom of the window.
  expect.soft((await box(page.locator('main'))).y).toBe(-200);
  const foot = await box(person(page));
  expect.soft(foot.y + foot.height).toBeCloseTo(400 - 8, 0);
  expect.soft(await sideScroll(page)).toBe(0);

  // Above the screen, on a phone, the bar is part of the page: it scrolls away with it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.scrollTo(0, 150));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(150);
  expect.soft((await box(rail(page))).y).toBe(-150);
  expect.soft(await styles(rail(page), ['position'])).toEqual({ position: 'static' });
  expect.soft(await sideScroll(page)).toBe(0);
});

test('one section, and one alone, is the section on screen, and « My account » is none', async ({ page }) => {
  await stubWorker(page);
  for (const [index, screen] of ['notes', 'sites', 'connectors', 'members', 'settings'].entries()) {
    await open(page, screen);
    const current = sections(page).locator('[aria-current="page"]');
    await expect(current, screen).toHaveCount(1);
    await expect(current, screen).toHaveText(SECTIONS[index] as string);
  }
  await expect(sections(page).getByRole('link')).toHaveText(SECTIONS);
  // « My account » left the sections (FRU-684): the menu of the person leads to it.
  await open(page, 'account');
  await expect(sections(page).locator('[aria-current="page"]')).toHaveCount(0);
  await expect(rail(page).getByRole('link', { name: 'My account' })).toHaveCount(0);
});

test('the counts are at the right of the entries, and the failed sends of the connectors are red', async ({ page }) => {
  await openProbe(page);
  const links = sections(page).getByRole('link');
  // A screen reader hears the count with its entry.
  for (const [index, name] of ['Notes 12', 'Sites 4', 'Connectors failed sends: 2', 'Members', 'Settings'].entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(name);
  }
  await expect(links.nth(0)).toHaveAttribute('aria-current', 'page');

  const count = links.nth(1).locator('span').last();
  expect.soft(await styles(count, ['font-size', 'font-weight'])).toEqual({ 'font-size': '12px', 'font-weight': '500' });
  expect.soft(await painted(count, 'color')).toEqual(rgb(SECONDARY));
  // At the right edge of the entry, 8 px in.
  const entry = await box(links.nth(1));
  const right = await box(count);
  expect.soft(entry.x + entry.width - (right.x + right.width)).toBeCloseTo(8, 0);

  const failing = links.nth(2).locator('[data-failing]');
  expect
    .soft(await styles(failing, ['font-size', 'font-weight']))
    .toEqual({ 'font-size': '12px', 'font-weight': '600' });
  expect.soft(await painted(failing, 'color')).toEqual(rgb(ALERT));
  const dot = failing.locator('span[aria-hidden="true"]');
  expect.soft(await styles(dot, ['width', 'height'])).toEqual({ width: '6px', height: '6px' });
  expect.soft(await painted(dot, 'backgroundColor')).toEqual(rgb('#dd2c27'));
  // The control: an entry with no count has nothing at its right.
  await expect(links.nth(3).locator('[data-failing]')).toHaveCount(0);
  await expect(links.nth(3).locator('span')).toHaveCount(2);
});

test('a section under the pointer takes the hover, and the keyboard walks the bar with a visible ring', async ({
  page,
}) => {
  await stubWorker(page);
  await open(page);
  const resting = sections(page).getByRole('link', { name: 'Members' });
  await resting.hover();
  expect.soft(await painted(resting, 'backgroundColor')).toEqual(rgb(HOVER));
  await page.mouse.move(700, 500);

  // The keyboard enters the bar by the workspace and the search, walks the sections in their order,
  // then the foot. Nothing was pressed on the page, so the first Tab is the first control of the page.
  const order = [
    switcher(page),
    rail(page).getByRole('link', { name: 'Search notes' }),
    ...SECTIONS.map((name) => sections(page).getByRole('link', { name, exact: true })),
    rail(page).getByRole('link', { name: /^What's new/ }),
    rail(page).getByRole('link', { name: 'Install the extension (beta)' }),
    rail(page).getByRole('link', { name: 'Help and docs' }),
    person(page),
  ];
  const ring = rgb('#dd2c27');
  for (const [index, control] of order.entries()) {
    await page.keyboard.press('Tab');
    await expect(control, `stop ${index + 1} of the keyboard`).toBeFocused();
    expect
      .soft(
        await styles(control, ['outline-style', 'outline-width', 'outline-offset']),
        `the ring of stop ${index + 1}`,
      )
      .toEqual({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-offset': '2px' });
    expect.soft(await painted(control, 'outlineColor'), `the ring of stop ${index + 1}`).toEqual(ring);
  }
  // WCAG 1.4.11: the ring against the bar, and against the section on screen it can be around.
  expect(contrast(ring, rgb(BAR))).toBeGreaterThanOrEqual(3);
  expect(contrast(ring, rgb(ACTIVE))).toBeGreaterThanOrEqual(3);
});

test('every text of the bar is at 4.5:1 on what is behind it', async ({ page }) => {
  await openProbe(page);
  const pairs: [string, Locator, string][] = [
    ['the name of the workspace', switcher(page).getByText('Acme', { exact: true }), BAR],
    ['the section on screen', sections(page).getByRole('link', { name: /^Notes/ }), ACTIVE],
    [
      'its count',
      sections(page)
        .getByRole('link', { name: /^Notes/ })
        .locator('span')
        .last(),
      ACTIVE,
    ],
    ['a section', sections(page).getByRole('link', { name: 'Members' }), BAR],
    [
      'a count',
      sections(page)
        .getByRole('link', { name: /^Sites/ })
        .locator('span')
        .last(),
      BAR,
    ],
    ['the failed sends', sections(page).locator('[data-failing]'), BAR],
    ['the way to the documentation', rail(page).getByRole('link', { name: 'Help and docs' }), BAR],
    ['the address of the person', person(page).getByText('ana@acme.dev'), BAR],
  ];
  for (const [name, text, behind] of pairs) {
    expect.soft(contrast(await painted(text, 'color'), rgb(behind)), name).toBeGreaterThanOrEqual(4.5);
  }
  // Under the pointer a section is on the hover.
  const hovered = sections(page).getByRole('link', { name: 'Members' });
  await hovered.hover();
  expect(contrast(await painted(hovered, 'color'), await painted(hovered, 'backgroundColor'))).toBeGreaterThanOrEqual(
    4.5,
  );
});

test('the foot: « What’s new », the extension, the help, then the person, the links in another tab', async ({
  page,
}) => {
  await stubWorker(page, { locale: 'fr' });
  await open(page);
  const foot = rail(page).locator('nav ~ div').last();
  await expect(foot.getByRole('link')).toHaveText([
    /^Nouveautés/,
    'Installer l’extension (bêta)',
    'Aide et documentation',
  ]);
  for (const link of await foot.getByRole('link').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
  }
  // Chromium goes to the Chrome Web Store; Firefox keeps the guide (extension-store.test.ts).
  await expect(rail(page).getByRole('link', { name: 'Installer l’extension (bêta)' })).toHaveAttribute(
    'href',
    'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa',
  );
  await expect(rail(page).getByRole('link', { name: 'Aide et documentation' })).toHaveAttribute(
    'href',
    'https://fruitback.com',
  );
  await expect(person(page)).toBeVisible();

  // The administration has the same foot, with its guide in place of the help.
  await stubWorker(page, {
    locale: 'fr',
    answer: (pathname, route) =>
      pathname === '/console/me'
        ? route.fulfill({
            json: {
              account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'fr' },
              workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
              instanceAdmin: true,
            },
          })
        : undefined,
  });
  await page.goto(`${CONSOLE}/admin`);
  await expect(page.locator('main h1')).toBeVisible();
  await expect(rail(page).locator('nav ~ div').last().getByRole('link')).toHaveText([
    /^Nouveautés/,
    'Installer l’extension (bêta)',
    'Guide d’auto-hébergement',
  ]);
});

test('« What’s new » leads to the releases, with a dot until it is opened with this version', async ({
  page,
  context,
}) => {
  await stubWorker(page);
  // The releases are not opened for real: the new tab is answered here.
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'Releases' }));
  await open(page);
  const news = rail(page).getByRole('link', { name: /^What's new/ });
  await expect(news).toHaveAttribute('href', 'https://github.com/sakuga-software/fruitback/releases');
  await expect(news).toHaveAccessibleName("What's new (new release)");
  const dot = news.locator('[data-news]');
  expect.soft(await styles(dot, ['width', 'height'])).toEqual({ width: '6px', height: '6px' });
  expect.soft(await painted(dot, 'backgroundColor')).toEqual(rgb('#dd2c27'));

  const opened = context.waitForEvent('page');
  await news.click();
  await (await opened).close();
  await expect(dot).toHaveCount(0);
  await expect(news).toHaveAccessibleName("What's new");
  // The browser keeps it: the next page has no dot either.
  await open(page, 'members');
  await expect(rail(page).locator('[data-news]')).toHaveCount(0);
  // The control: another version seen has the dot again.
  await page.evaluate(() => localStorage.setItem('fruitback:whats-new-seen', '0.0.1'));
  await page.reload();
  await expect(rail(page).locator('[data-news]')).toHaveCount(1);
});

test('the menu of the person opens « My account » and signs out', async ({ page }) => {
  let signedOut = 0;
  await stubWorker(page, {
    answer: (pathname, route) => {
      if (pathname !== '/console/auth/sign-out') return undefined;
      signedOut += 1;

      return route.fulfill({ json: { ok: true } });
    },
  });
  await open(page);
  await person(page).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['My account', 'Sign out']);
  // Escape closes it, and focus is back on the person.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(person(page)).toBeFocused();

  await person(page).click();
  await menu.getByRole('menuitem', { name: 'My account' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/account`);
  // The page « Profile » of the shell of the settings (FRU-692).
  await expect(page.locator('main h1')).toHaveText('Profile');

  await person(page).click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  expect(signedOut).toBe(1);
});

test('the search of the bar opens the notes with their search field in focus', async ({ page }) => {
  // One note: the notes draw their filters, and the field is among them.
  const note = {
    id: 'n1',
    excerpt: 'The button is cut on a phone',
    page: { url: 'https://acme.dev/pricing', host: 'acme.dev', path: '/pricing' },
    site: { id: 's1' },
    stage: 'new',
    author: { kind: 'anonymous' },
    createdAt: '2026-10-13T12:00:00.000Z',
  };
  await stubWorker(page, {
    answer: (pathname, route) =>
      pathname === '/console/workspaces/w1/notes'
        ? route.fulfill({ json: { notes: [note], total: 1, counts: { all: 1 } } })
        : undefined,
  });
  await open(page);
  await rail(page).getByRole('link', { name: 'Search notes' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes`);
  const field = page.locator('main').getByRole('searchbox', { name: 'Search notes' });
  await expect(field).toBeFocused();
  // A second press, from the notes, focuses it again.
  await sections(page).getByRole('link', { name: 'Notes' }).focus();
  await rail(page).getByRole('link', { name: 'Search notes' }).click();
  await expect(field).toBeFocused();
  // The control: the entry « Notes » opens them with no focus in the field.
  await open(page, 'sites');
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('main').getByRole('searchbox', { name: 'Search notes' })).not.toBeFocused();
});

test('the name of the workspace opens the menu of the workspaces of the person', async ({ page }) => {
  await stubWorker(page);
  await open(page);
  await switcher(page).focus();
  await page.keyboard.press('Enter');

  // The menu is named after its button.
  const menu = page.getByRole('menu', { name: /Acme/ });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitemradio');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Acme');
  await expect(items.nth(0)).toContainText('Owner');
  await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(items.nth(1)).toContainText('Lumen Studio');
  await expect(items.nth(1)).toContainText('Member');
  await expect(items.nth(1)).toHaveAttribute('aria-checked', 'false');

  // The menu fades in: axe reads a contrast on words that are half there as too low.
  const popover = page.locator('.kit-menu');
  await expect(popover).not.toHaveAttribute('data-entering', 'true');
  await page.waitForTimeout(200);
  const results = await new AxeBuilder({ page }).include('.kit-menu').analyze();
  expect
    .soft(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);

  // Escape closes it, and focus is back on the name.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(switcher(page)).toBeFocused();

  // The current workspace chosen again goes nowhere. Another one opens its sites.
  await switcher(page).click();
  await menu.getByRole('menuitemradio', { name: /Acme/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await open(page, 'members');
  await switcher(page).click();
  await menu.getByRole('menuitemradio', { name: /Lumen Studio/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w2/sites`);
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(rail(page).getByRole('button', { name: /^Lumen Studio/ })).toBeVisible();
  await expect(sections(page).locator('[aria-current="page"]')).toHaveText('Sites');
});

test('a change of workspace draws the new one at once, and reads nothing of the one before', async ({ page }) => {
  // The worker answers who is signed in at once, until the test holds its answers.
  const asked: string[] = [];
  let holding = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const me = { account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' }, workspaces: [ACME, LUMEN] };
  await stubWorker(page, {
    answer: (pathname, route) => {
      asked.push(pathname);
      if (pathname !== '/console/me' || !holding) return undefined;

      return held.then(() => route.fulfill({ json: me }));
    },
  });
  await open(page);
  await expect(page.getByText('staging.acme.dev').first()).toBeVisible();

  await switcher(page).click();
  asked.length = 0;
  holding = true;
  await page.getByRole('menuitemradio', { name: /Lumen Studio/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w2/sites`);

  // The worker has not answered yet: the frame draws the new workspace from the last answer of the
  // tab (FRU-356), with its bar, and the screen is of the new workspace.
  await expect(rail(page).getByRole('button', { name: /^Lumen Studio/ })).toBeVisible();
  await expect(page.locator('main h1')).toBeVisible();
  // Nothing was read in the workspace of before under the address of the new one.
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);

  release();
  await expect(rail(page).getByRole('button', { name: /^Lumen Studio/ })).toBeVisible();
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);
  // The control: the screen of the new workspace reads its own lists. Its title can come before the
  // request, so the request is waited for (FRU-268: one run of four workers was faster than it).
  await expect.poll(() => asked.some((pathname) => pathname.includes('/workspaces/w2/'))).toBe(true);
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);
});

test('a person with one workspace has its name, and no menu of the workspaces', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME] });
  await open(page);
  const head = rail(page).locator('> div').first();
  await expect(head.getByText('Acme', { exact: true })).toBeVisible();
  // No button, so nothing that promises a menu: neither the attribute nor the chevron.
  await expect(head.getByRole('button')).toHaveCount(0);
  await expect(head.locator('[aria-haspopup]')).toHaveCount(0);
  await expect(head.locator('svg[data-rail-icon="chevron"]')).toHaveCount(0);
  // The control: with two workspaces the same reading finds the button.
  await page.unrouteAll();
  await stubWorker(page, { workspaces: [ACME, LUMEN] });
  await open(page);
  await expect(head.getByRole('button')).toHaveCount(1);
  await expect(head.locator('[aria-haspopup]')).toHaveCount(1);
});

test('a workspace the person is not in opens their own', async ({ page }) => {
  await stubWorker(page);
  await page.goto(`${CONSOLE}/w/unknown/sites`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
});

for (const width of [1023, 390]) {
  test(`under 1024 px the bar is folded above the screen, and unfolds by its button, at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await stubWorker(page);
    await open(page);
    // Folded: the head, the search and the button; the sections and the foot are hidden.
    await expect(switcher(page)).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Search notes' })).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(sections(page)).toBeHidden();
    await expect(person(page)).toBeHidden();
    expectAt(await box(rail(page)), { x: 0, y: 0, width, height: 45 }, 'the folded bar');
    expect(await sideScroll(page)).toBe(0);

    // The button unfolds them under the head, as wide as the window.
    await toggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    const panel = await toggle(page).getAttribute('aria-controls');
    expect(panel).not.toBeNull();
    await expect(page.locator(`[id="${panel}"]`)).toBeVisible();
    await expect(sections(page).getByRole('link')).toHaveText(SECTIONS);
    await expect(person(page)).toBeVisible();
    expectAt(
      await box(sections(page).getByRole('link', { name: 'Notes' })),
      { x: 6, width: width - 12, height: 28 },
      'Notes',
    );
    expect(await sideScroll(page)).toBe(0);
    const results = await new AxeBuilder({ page }).include('aside.kit-rail').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );

    // Tab goes on from the button into the sections; Escape folds the bar and gives focus back.
    await page.keyboard.press('Tab');
    await expect(sections(page).getByRole('link', { name: 'Notes' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toBeFocused();
    await expect(sections(page)).toBeHidden();

    // A section chosen opens its screen, and folds the bar over it.
    await toggle(page).click();
    await sections(page).getByRole('link', { name: 'Members' }).click();
    await expect(page).toHaveURL(`${CONSOLE}/w/w1/members`);
    await expect(sections(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });
}

test('at 1024 px the bar is beside the screen, with no button to unfold it', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await stubWorker(page);
  await open(page);
  await expect(toggle(page)).toBeHidden();
  await expect(sections(page)).toBeVisible();
  expectAt(await box(rail(page)), { x: 0, y: 0, width: 232, height: 768 }, 'the bar');
  expectAt(await box(page.locator('main')), { x: 232, width: 1024 - 232 }, 'the room');
  expect(await sideScroll(page)).toBe(0);
});

for (const width of [1440, 390]) {
  test(`axe finds nothing in the bar at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubWorker(page);
    await open(page);
    const results = await new AxeBuilder({ page }).include('aside.kit-rail').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );
    // The control: axe read the bar.
    expect(results.passes.length).toBeGreaterThan(5);
  });
}

test('what the root says above a screen stays above the bar, and reads', async ({ page }) => {
  // A worker that stops answering after the screen is drawn.
  let down = false;
  await stubWorker(page, {
    answer: (pathname, route) => (down && pathname !== '/console/me' ? route.abort() : undefined),
  });
  await open(page);
  // The list is read before the worker stops: a read that fails shows no way to add a site.
  const add = page.getByRole('button', { name: 'Add a site' });
  await expect(add).toBeVisible();
  down = true;
  await add.click();
  await page.getByRole('textbox', { name: 'Site address' }).fill('https://staging.acme.dev');
  await page.getByRole('button', { name: 'Add site' }).click();

  const banner = page.getByRole('alert').filter({ hasText: 'Fruitback cannot reach its server' });
  await expect(banner).toBeVisible();
  const above = await box(banner);
  const under = await box(rail(page));
  expect(above.y).toBe(0);
  expect(above.width).toBe(1440);
  expect(under.y).toBeGreaterThanOrEqual(above.y + above.height);
  expect(
    contrast(await painted(banner.locator('span'), 'color'), await painted(banner, 'backgroundColor')),
  ).toBeGreaterThanOrEqual(4.5);
});
