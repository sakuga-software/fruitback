import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import {
  ACME,
  LUMEN,
  box,
  contrast,
  expectBox,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * The frame of a workspace (FRU-234), measured in a browser against the mockup of 2026-10-13: the
 * dark rail, the workspace and its menu, the sections, and the room it gives a screen.
 *
 * The values are read in the code of the mockup (`09-console-sites.html`, `<aside class="rail">`),
 * and the boxes in its render at 1440 px and at 390 px. A box is compared where the font is the one
 * of the mockup, on macOS; the computed styles are read everywhere. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const RAIL = '#18181b';
const RAIL_ACTIVE = '#27272a';
const RAIL_TEXT = '#d4d4d8';
const RAIL_MUTED = '#a1a1aa';
const RAIL_ACCENT = '#ec5b57';
const WHITE = '#ffffff';
const INK = '#18181b';

const rail = (page: Page) => page.locator('aside.kit-rail');
const sections = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const switcher = (page: Page) => rail(page).getByRole('button', { name: /Acme/ });

async function open(page: Page, screen = 'sites', workspace = 'w1'): Promise<void> {
  await page.goto(`${CONSOLE}/w/${workspace}/${screen}`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** The rail with the five sections of the mockup, « Notes » on screen: a page of the development server. */
async function openProbe(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/kit/frame`);
  await expect(sections(page)).toBeVisible();
}

test('at 1440 px the rail has the values of the mockup', async ({ page }) => {
  await stubWorker(page);
  await open(page);

  expect
    .soft(await styles(rail(page), ['flex-grow', 'flex-shrink', 'flex-basis', 'padding', 'row-gap', 'flex-direction']))
    .toEqual({
      'flex-grow': '1',
      'flex-shrink': '1',
      'flex-basis': '248px',
      padding: '16px 12px',
      'row-gap': '20px',
      'flex-direction': 'column',
    });
  expect.soft(await painted(rail(page), 'backgroundColor')).toEqual(rgb(RAIL));
  expect.soft(await painted(rail(page), 'color')).toEqual(rgb(WHITE));

  // The workspace: a button that opens a menu.
  const name = switcher(page);
  // React Aria writes `true`, which ARIA reads as `menu`.
  await expect(name).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  expect.soft(await styles(name, ['padding', 'border-top-left-radius', 'column-gap', 'text-align'])).toEqual({
    padding: '8px',
    'border-top-left-radius': '10px',
    'column-gap': '10px',
    'text-align': 'left',
  });
  const initial = name.locator('span[aria-hidden="true"]').first();
  await expect(initial).toHaveText('A');
  expect
    .soft(await styles(initial, ['width', 'height', 'border-top-left-radius', 'font-size', 'font-weight']))
    .toEqual({
      width: '32px',
      height: '32px',
      'border-top-left-radius': '8px',
      'font-size': '14px',
      'font-weight': '700',
    });
  expect.soft(await painted(initial, 'backgroundColor')).toEqual(rgb(WHITE));
  expect.soft(await painted(initial, 'color')).toEqual(rgb(INK));
  expect.soft(await styles(name.getByText('Acme', { exact: true }), ['font-size', 'font-weight'])).toEqual({
    'font-size': '15px',
    'font-weight': '600',
  });
  const detail = name.getByText('Cloud workspace', { exact: true });
  expect.soft(await styles(detail, ['font-size'])).toEqual({ 'font-size': '12px' });
  expect.soft(await painted(detail, 'color')).toEqual(rgb(RAIL_MUTED));
  const chevrons = name.locator('svg');
  expect.soft(await styles(chevrons, ['width', 'height'])).toEqual({ width: '16px', height: '16px' });
  expect.soft(await painted(chevrons, 'color')).toEqual(rgb(RAIL_MUTED));

  // The sections: the one on screen, and the others.
  expect
    .soft(await styles(sections(page), ['flex-direction', 'row-gap']))
    .toEqual({ 'flex-direction': 'column', 'row-gap': '2px' });
  const entry = [
    'min-height',
    'border-top-left-radius',
    'font-size',
    'font-weight',
    'column-gap',
    'padding',
    'white-space',
  ];
  const active = sections(page).getByRole('link', { name: 'Sites' });
  expect.soft(await styles(active, entry)).toEqual({
    'min-height': '40px',
    'border-top-left-radius': '10px',
    'font-size': '15px',
    'font-weight': '600',
    'column-gap': '10px',
    padding: '0px 12px',
    'white-space': 'nowrap',
  });
  expect.soft(await painted(active, 'backgroundColor')).toEqual(rgb(RAIL_ACTIVE));
  expect.soft(await painted(active, 'color')).toEqual(rgb(WHITE));
  const drop = active.locator('span[aria-hidden="true"]');
  expect.soft(await styles(drop, ['width', 'height'])).toEqual({ width: '9px', height: '9px' });
  expect.soft(await painted(drop, 'backgroundColor')).toEqual(rgb(RAIL_ACCENT));

  const resting = sections(page).getByRole('link', { name: 'Members' });
  expect.soft(await styles(resting, entry)).toEqual({
    'min-height': '40px',
    'border-top-left-radius': '10px',
    'font-size': '15px',
    'font-weight': '400',
    'column-gap': '10px',
    padding: '0px 12px 0px 31px',
    'white-space': 'nowrap',
  });
  expect.soft(await painted(resting, 'color')).toEqual(rgb(RAIL_TEXT));
  await expect(resting.locator('span[aria-hidden="true"]')).toHaveCount(0);

  // The foot: the way to the documentation, and the logo.
  const help = rail(page).getByRole('link', { name: 'Help and docs' });
  await expect(help).toHaveAttribute('href', 'https://fruitback.com');
  expect.soft(await styles(help, ['font-size', 'text-decoration-line'])).toEqual({
    'font-size': '14px',
    'text-decoration-line': 'underline',
  });
  expect.soft(await painted(help, 'color')).toEqual(rgb(RAIL_TEXT));
  const foot = help.locator('..');
  expect
    .soft(await styles(foot, ['padding', 'row-gap', 'margin-top']))
    .toMatchObject({ padding: '8px', 'row-gap': '14px' });
  const logo = rail(page).getByRole('img', { name: 'Fruitback' });
  expectBox(await box(logo), { x: 20, y: 860, width: 82, height: 16 }, 2, 'the logo');
  expect.soft(await painted(logo.locator('path').first(), 'fill')).toEqual(rgb(WHITE));
  expect.soft(await painted(logo.locator('path').last(), 'fill')).toEqual(rgb(RAIL_ACCENT));

  // The boxes of the mockup, at 2 px.
  expectBox(await box(rail(page)), { x: 0, y: 0, width: 248.5, height: 900 }, 2, 'the rail');
  expectBox(await box(name), { x: 12, y: 16, width: 224.5, height: 49 }, 2, 'the workspace');
  expectBox(await box(chevrons), { x: 213, y: 33, width: 16, height: 16 }, 2, 'the chevrons');
  expectBox(await box(active), { x: 12, y: 85, width: 224.5, height: 40 }, 2, 'the section on screen');
  expectBox(await box(help), { x: 20, y: 829, height: 17 }, 2, 'the way to the documentation');
});

test('the room of a screen is the one of the mockup, and as wide as its screen is drawn', async ({ page }) => {
  await stubWorker(page);
  const widths = { sites: 1120, notes: 1240, connectors: 1180, members: 1120, account: 820 };
  for (const [screen, width] of Object.entries(widths)) {
    await open(page, screen);
    const main = page.locator('main');
    expect
      .soft(await styles(main, ['max-width', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right']), screen)
      .toEqual({
        'max-width': `${width}px`,
        'padding-top': '40px',
        'padding-bottom': '72px',
        // clamp(16px, 4vw, 48px) at 1440 px.
        'padding-left': '48px',
        'padding-right': '48px',
      });
    // The room is as wide as the screen is drawn, and no wider than what the rail leaves (1191.5 px).
    expectBox(await box(main), { x: 248.5, y: 0, width: Math.min(width, 1191.5) }, 2, `the room of ${screen}`);
    expectBox(await box(page.locator('main h1')), { x: 296.5, y: 40, height: 32.2 }, 2, `the title of ${screen}`);
  }
  const content = page.locator('main').locator('..');
  expect.soft(await styles(content, ['flex-grow', 'flex-shrink', 'flex-basis', 'min-width'])).toEqual({
    'flex-grow': '999',
    'flex-shrink': '1',
    'flex-basis': '640px',
    'min-width': '0px',
  });
});

test('one section, and one alone, is the section on screen', async ({ page }) => {
  await stubWorker(page);
  const names = { sites: 'Sites', notes: 'Notes', connectors: 'Connectors', members: 'Members', account: 'My account' };
  for (const [screen, name] of Object.entries(names)) {
    await open(page, screen);
    const current = sections(page).locator('[aria-current="page"]');
    await expect(current, screen).toHaveCount(1);
    await expect(current, screen).toHaveText(name);
  }
  // The five sections, in the order of the mockup (« Notes » has its screen since FRU-245).
  await expect(sections(page).getByRole('link')).toHaveText(Object.values(names));
});

test('the five sections of the mockup are in its order, and « Notes » can be the one on screen', async ({ page }) => {
  await openProbe(page);
  const links = sections(page).getByRole('link');
  await expect(links).toHaveText(['Sites', 'Notes', 'Connectors', 'Members', 'My account']);
  const current = sections(page).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText('Notes');
  expect.soft(await painted(current, 'backgroundColor')).toEqual(rgb(RAIL_ACTIVE));

  // The boxes of the five entries of the mockup, 42 px apart.
  for (const [index, name] of ['Sites', 'Notes', 'Connectors', 'Members', 'My account'].entries()) {
    expectBox(await box(links.nth(index)), { x: 12, y: 85 + 42 * index, width: 224.5, height: 40 }, 2, name);
  }
  expectBox(await box(sections(page)), { x: 12, y: 85, width: 224.5, height: 208 }, 2, 'the sections');
});

test('a section under the pointer, and a control with focus, read on the rail', async ({ page }) => {
  await stubWorker(page);
  await open(page);
  const resting = sections(page).getByRole('link', { name: 'Members' });
  await resting.hover();
  expect.soft(await painted(resting, 'backgroundColor')).toEqual(rgb(RAIL_ACTIVE));
  expect.soft(await painted(resting, 'color')).toEqual(rgb(WHITE));
  await page.mouse.move(700, 500);

  // The keyboard enters the rail by the workspace, then walks the sections in their order. Nothing
  // was pressed on the page, so the first Tab is the first control of the page.
  const order = [
    switcher(page),
    ...['Sites', 'Notes', 'Connectors', 'Members', 'My account'].map((name) =>
      sections(page).getByRole('link', { name, exact: true }),
    ),
    rail(page).getByRole('link', { name: 'Help and docs' }),
  ];
  for (const [index, control] of order.entries()) {
    await page.keyboard.press('Tab');
    await expect(control, `stop ${index + 1} of the keyboard`).toBeFocused();
    const ring = await styles(control, ['outline-style', 'outline-width', 'outline-offset']);
    expect
      .soft(ring, `the ring of stop ${index + 1}`)
      .toEqual({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-offset': '2px' });
    expect.soft(await painted(control, 'outlineColor'), `the ring of stop ${index + 1}`).toEqual(rgb(RAIL_ACCENT));
  }
  // WCAG 1.4.11: the ring against the rail, and against the section on screen it is around.
  expect(contrast(rgb(RAIL_ACCENT), rgb(RAIL))).toBeGreaterThanOrEqual(3);
  expect(contrast(rgb(RAIL_ACCENT), rgb(RAIL_ACTIVE))).toBeGreaterThanOrEqual(3);
});

test('every text of the rail is at 4.5:1 on what is behind it', async ({ page }) => {
  await stubWorker(page);
  await open(page);
  const pairs: [string, Locator, string][] = [
    ['the name of the workspace', switcher(page).getByText('Acme', { exact: true }), RAIL],
    ['« Cloud workspace »', switcher(page).getByText('Cloud workspace'), RAIL],
    ['the section on screen', sections(page).getByRole('link', { name: 'Sites' }), RAIL_ACTIVE],
    ['a section', sections(page).getByRole('link', { name: 'Members' }), RAIL],
    ['the way to the documentation', rail(page).getByRole('link', { name: 'Help and docs' }), RAIL],
  ];
  for (const [name, text, behind] of pairs) {
    expect.soft(contrast(await painted(text, 'color'), rgb(behind)), name).toBeGreaterThanOrEqual(4.5);
  }
  // Under the pointer a section is white on the tint of the section on screen.
  const hovered = sections(page).getByRole('link', { name: 'Members' });
  await hovered.hover();
  expect(contrast(await painted(hovered, 'color'), await painted(hovered, 'backgroundColor'))).toBeGreaterThanOrEqual(
    4.5,
  );
  const help = rail(page).getByRole('link', { name: 'Help and docs' });
  await help.hover();
  expect(contrast(await painted(help, 'color'), rgb(RAIL))).toBeGreaterThanOrEqual(4.5);
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

  // The menu is the surface of a page, on the rail too: its words are at 4.5:1 on it.
  const popover = page.locator('.kit-menu');
  expect.soft(await painted(popover, 'backgroundColor')).toEqual(rgb(WHITE));
  expect
    .soft(contrast(await painted(items.nth(1).getByText('Lumen Studio'), 'color'), rgb(WHITE)))
    .toBeGreaterThanOrEqual(4.5);
  expect
    .soft(contrast(await painted(items.nth(1).getByText('Member'), 'color'), rgb(WHITE)))
    .toBeGreaterThanOrEqual(4.5);
  // The menu fades in: axe reads a contrast on words that are half there as too low.
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
  await expect(rail(page).getByRole('button', { name: /Lumen Studio/ })).toBeVisible();
  await expect(sections(page).locator('[aria-current="page"]')).toHaveText('Sites');
});

test('a change of workspace shows nothing of the workspace of before while the new one is read', async ({ page }) => {
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

  // The address names the new workspace, and the worker has not answered: no screen, and no rail.
  await expect(page.getByText('Loading…')).toBeVisible();
  await expect(page.locator('main')).toHaveCount(0);
  await expect(rail(page)).toHaveCount(0);
  // Nothing was read in the workspace of before under the address of the new one.
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);

  release();
  await expect(rail(page).getByRole('button', { name: /Lumen Studio/ })).toBeVisible();
  await expect(page.locator('main h1')).toBeVisible();
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);
  // The control: the screen of the new workspace reads its own lists. Its title can come before the
  // request, so the request is waited for (FRU-268: one run of four workers was faster than it).
  await expect.poll(() => asked.some((pathname) => pathname.includes('/workspaces/w2/'))).toBe(true);
  expect(asked.filter((pathname) => pathname.includes('/workspaces/w1/'))).toEqual([]);
});

test('a person with one workspace has its name, and no menu', async ({ page }) => {
  await stubWorker(page, { workspaces: [ACME] });
  await open(page);
  await expect(rail(page).getByText('Acme', { exact: true })).toBeVisible();
  await expect(rail(page).getByText('Cloud workspace')).toBeVisible();
  // No button, so nothing that promises a menu: neither the attribute nor the chevrons.
  await expect(rail(page).getByRole('button')).toHaveCount(0);
  await expect(rail(page).locator('[aria-haspopup]')).toHaveCount(0);
  // The control: with two workspaces the same reading finds the button.
  await page.unrouteAll();
  await stubWorker(page, { workspaces: [ACME, LUMEN] });
  await open(page);
  await expect(rail(page).getByRole('button')).toHaveCount(1);
  await expect(rail(page).locator('[aria-haspopup]')).toHaveCount(1);
});

test('a workspace the person is not in opens their own', async ({ page }) => {
  await stubWorker(page);
  await page.goto(`${CONSOLE}/w/unknown/sites`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px the sections are one row that scrolls in the rail, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubWorker(page, { locale });
    await open(page);
    const nav = page.getByRole('navigation');
    const last = nav.getByRole('link').last();

    // The page does not scroll sideways: the mockup does, its document is 547 px wide.
    expect(await sideScroll(page)).toBe(0);
    expect(await styles(nav, ['flex-direction', 'overflow-x'])).toEqual({
      'flex-direction': 'row',
      'overflow-x': 'auto',
    });
    // The row is wider than the rail, so it is the row that scrolls. The control of « 0 » above.
    expect(await nav.evaluate((row) => row.scrollWidth - row.clientWidth)).toBeGreaterThan(0);
    // The foot is not shown, as in the mockup.
    await expect(rail(page).getByRole('img', { name: 'Fruitback' })).toBeHidden();

    // The end of the row that hides a section fades, and the start does not.
    await expect(nav).toHaveAttribute('data-more-end', 'true');
    await expect(nav).toHaveAttribute('data-more-start', 'false');
    expect((await styles(nav, ['mask-image']))['mask-image']).toContain('linear-gradient');

    // The keyboard reaches the last section, and the row scrolls to show it whole.
    await last.focus();
    const edge = async (link: Locator) => {
      const found = await box(link);

      return { start: found.x, end: found.x + found.width };
    };
    await expect.poll(async () => (await edge(last)).end).toBeLessThanOrEqual(390);
    await expect(nav).toHaveAttribute('data-more-start', 'true');
    await expect(nav).toHaveAttribute('data-more-end', 'false');
    expect(await sideScroll(page)).toBe(0);

    // A screen opened by its address shows its own section in the row.
    await open(page, 'account');
    const current = nav.locator('[aria-current="page"]');
    await expect.poll(async () => (await edge(current)).end).toBeLessThanOrEqual(390);
    expect((await edge(current)).start).toBeGreaterThanOrEqual(0);
    expect(await sideScroll(page)).toBe(0);
  });
}

test('at 390 px the row of sections is where the mockup draws it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubWorker(page);
  await open(page);
  // The render of the mockup at 390 px: the rail is 141 px high, and its row starts at 12, 85.
  expectBox(await box(rail(page)), { x: 0, y: 0, width: 390, height: 141 }, 4, 'the rail');
  expectBox(await box(switcher(page)), { x: 12, y: 16, height: 49 }, 4, 'the workspace');
  expectBox(
    await box(sections(page).getByRole('link', { name: 'Sites' })),
    { x: 12, y: 85, width: 78.9, height: 40 },
    4,
    '« Sites »',
  );
  expectBox(await box(page.locator('main')), { x: 0, y: 141, width: 390 }, 4, 'the room of the screen');
  expectBox(await box(page.locator('main h1')), { x: 16, y: 181, height: 32.2 }, 4, 'the title');

  // With the five sections of the mockup, each one is where it draws it.
  await openProbe(page);
  const mockup = [
    { x: 12, width: 78.9 },
    { x: 92.9, width: 83.6 },
    { x: 178.5, width: 122.5 },
    { x: 303, width: 107.3 },
    { x: 412.3, width: 123 },
  ];
  const links = sections(page).getByRole('link');
  for (const [index, entry] of mockup.entries()) {
    expectBox(await box(links.nth(index)), { ...entry, y: 85, height: 40 }, 4, `entry ${index + 1}`);
  }
  expect(await sideScroll(page)).toBe(0);
});

test('at 390 px a short screen leaves the rail at its own height', async ({ page }) => {
  // A window higher than the screen it shows, as a short screen is on a phone.
  await page.setViewportSize({ width: 390, height: 1800 });
  await stubWorker(page);
  await open(page);
  const main = await box(page.locator('main'));
  expect(main.y + main.height).toBeLessThan(1800);
  // The mockup gives the rest of the window to the rail: 286 px of rail at 390 px. Here the rail is
  // its own height, whatever the font, and the screen starts right under it.
  const above = await box(rail(page));
  expect(above.height).toBeLessThan(200);
  expect(main.y).toBe(above.y + above.height);
  expectBox(await box(rail(page)), { x: 0, y: 0, width: 390, height: 141 }, 4, 'the rail');
  expectBox(await box(page.locator('main h1')), { x: 16, y: 181 }, 4, 'the title');

  // At 1440 px the rail is beside the screen, and as high as the window.
  await page.setViewportSize({ width: 1440, height: 900 });
  expectBox(await box(rail(page)), { x: 0, y: 0, width: 248.5, height: 900 }, 2, 'the rail at 1440 px');
});

for (const width of [1440, 390]) {
  test(`axe finds nothing in the rail at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubWorker(page);
    await open(page);
    const results = await new AxeBuilder({ page }).include('aside.kit-rail').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );
    // The control: axe read the rail.
    expect(results.passes.length).toBeGreaterThan(5);
  });
}

test('what the root says above a screen stays above the rail, and reads', async ({ page }) => {
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
