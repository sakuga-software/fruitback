import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * Two states of the console's kit that HeroUI drew with values the theme did not give it (FRU-163):
 * the alert of a problem, and the main button under the pointer.
 *
 * The worker is answered by stubs, like `console-narrow.spec.ts`: this measures colours.
 */
const CONSOLE = 'http://localhost:5178';
/** `--muted` in app.css: the colour of a hint, which a problem must not have. */
const MUTED = [115, 108, 103];

async function openSites(page: Page): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/domains') return json({ domains: [] });
    if (pathname === '/console/workspaces/w1/sites') {
      // Reading the sites works. Adding one fails, which is what shows the alert.
      return route.request().method() === 'GET' ? json({ sites: [] }) : json({ error: 'unknown' }, 500);
    }

    return route.fulfill({ status: 204 });
  });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** A computed colour as the browser paints it, whatever notation `getComputedStyle` answers in. */
function painted(locator: Locator, property: 'color' | 'backgroundColor'): Promise<number[]> {
  return locator.evaluate((element, name) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element)[name];
    context.fillRect(0, 0, 1, 1);

    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, property);
}

/** The contrast ratio of WCAG 2.2. */
function contrast(one: number[], other: number[]): number {
  const luminance = (colour: number[]) => {
    const [red = 0, green = 0, blue = 0] = colour.map((channel) => {
      const value = channel / 255;

      return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

test('the formula answers the two known ratios', () => {
  // The control of every ratio below: black on white, and the grey that is 4.54:1 on white.
  expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
  expect(contrast([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
});

test('the alert of a problem reads as a problem', async ({ page }) => {
  await openSites(page);
  await page.getByRole('textbox').first().fill('https://staging.acme.dev');
  await page.getByRole('button', { name: 'Add the site' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  const text = await painted(alert.locator('.alert__description'), 'color');
  const background = await painted(alert, 'backgroundColor');
  expect(text).not.toEqual(MUTED);
  // The red of the theme, not a grey: red leads the two other channels by far.
  expect(text[0]! - Math.max(text[1]!, text[2]!)).toBeGreaterThan(100);
  expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  expect(await alert.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px');
});

test('the main button keeps 4.5:1 under the pointer, when pressed and with focus', async ({ page }) => {
  await openSites(page);
  await page.getByRole('textbox').first().fill('https://staging.acme.dev');
  const button = page.getByRole('button', { name: 'Add the site' });
  const ratio = async () => contrast(await painted(button, 'color'), await painted(button, 'backgroundColor'));
  const resting = await painted(button, 'backgroundColor');

  await button.hover();
  // The colour moves in a transition: wait until the button is no longer at its resting colour.
  await expect.poll(() => painted(button, 'backgroundColor')).not.toEqual(resting);
  await page.waitForTimeout(400);
  expect(await ratio()).toBeGreaterThanOrEqual(4.5);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);

  await page.mouse.down();
  await page.waitForTimeout(400);
  expect(await ratio()).toBeGreaterThanOrEqual(4.5);
  await page.mouse.up();

  await page.mouse.move(0, 0);
  await button.focus();
  await page.waitForTimeout(400);
  expect(await ratio()).toBeGreaterThanOrEqual(4.5);
});

/** `/setup` as nobody signed in meets it, on a worker that signs people in with Google and GitHub. */
async function openSetup(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: true, google: true } });
    if (pathname === '/console/me') return json({}, 401);

    return route.fulfill({ status: 204 });
  });
  await page.goto(`${CONSOLE}/setup`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
}

/** The colour of the border as painted, and the corner, of the box that draws a control. */
async function boxOf(locator: Locator): Promise<{ radius: string; border: number[]; width: string; shadow: string }> {
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);

    return {
      radius: computed.borderTopLeftRadius,
      width: computed.borderTopWidth,
      shadow: computed.boxShadow,
    };
  });
  const border = await locator.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element).borderTopColor;
    context.fillRect(0, 0, 1, 1);

    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });

  return { ...style, border };
}

test('the wide buttons and the fields have the shape and the border of the board (FRU-168)', async ({ page }) => {
  // `design/boards/2-onboarding.png`: four controls of one shape in a column, and the pill kept for
  // the action of the step. The screen drew the wide buttons as pills too, with a border of 1.26:1.
  await openSetup(page);
  const white = [255, 255, 255];

  for (const name of ['Continue with Google', 'Continue with GitHub']) {
    const button = await boxOf(page.getByRole('button', { name }));
    expect.soft(button.radius, name).toBe('6px');
    expect.soft(button.width, name).toBe('1px');
    // WCAG 1.4.11: the border is what says where the control is.
    expect.soft(contrast(button.border, white), name).toBeGreaterThanOrEqual(3);
  }

  for (const name of ['Work email', 'Workspace name']) {
    const field = await boxOf(page.getByRole('textbox', { name }));
    expect.soft(Number.parseFloat(field.radius), name).toBeGreaterThanOrEqual(8);
    expect.soft(Number.parseFloat(field.radius), name).toBeLessThanOrEqual(10);
    expect.soft(contrast(field.border, white), name).toBeGreaterThanOrEqual(3);
    // Flat: no shadow, or one that paints nothing.
    expect.soft(field.shadow, name).toMatch(/^none$|^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/);
  }

  // The action of the step keeps the pill: its shape is what tells it from the four controls.
  const action = await boxOf(page.getByRole('button', { name: 'Continue', exact: true }));
  expect.soft(Number.parseFloat(action.radius)).toBeGreaterThanOrEqual(20);
});

test('a required field has no mark the board does not draw, and stays required (FRU-168)', async ({ page }) => {
  await openSetup(page);
  const email = page.getByRole('textbox', { name: 'Work email' });

  // Required for the browser and for a screen reader, with no asterisk after the label.
  await expect(email).toHaveAttribute('required', '');
  const label = page.locator('label', { hasText: 'Work email' });
  const marks = await label.evaluate((element) =>
    ['::before', '::after'].map((pseudo) => getComputedStyle(element, pseudo).content),
  );
  expect(marks).toEqual(['none', 'none']);
  await expect(label).toHaveText('Work email');
});
