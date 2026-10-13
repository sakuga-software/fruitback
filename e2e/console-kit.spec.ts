import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The kit of the console, measured in a browser.
 *
 * First, two states that HeroUI drew with values the theme did not give it (FRU-163): the alert of a
 * problem, and the main button under the pointer. Then the shapes of the first boards (FRU-168).
 * Then every component against the mockup of 2026-10-13 (FRU-232), on `/kit`: the page of the
 * development server that mounts each one once.
 *
 * The worker is answered by stubs, like `console-narrow.spec.ts`: this measures colours and boxes.
 */
const CONSOLE = 'http://localhost:5178';
/** `--muted` in app.css: the colour of a hint, which a problem must not have. */
const MUTED = [107, 107, 116];

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
  await page.getByRole('button', { name: 'Add site' }).click();

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
  const button = page.getByRole('button', { name: 'Add site' });
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

/**
 * The values of the mockup of 2026-10-13, read in its code (FRU-232). A colour is written as the
 * browser answers it.
 */
const INK = 'rgb(24, 24, 27)';
const INK_SOFT = 'rgb(82, 82, 91)';
const MUTED_TONE = 'rgb(107, 107, 116)';
const WHITE = 'rgb(255, 255, 255)';
const SUBTLE = 'rgb(250, 250, 250)';
const CHIP = 'rgb(244, 244, 245)';
const LINE = 'rgb(228, 228, 231)';
const CONTROL = 'rgb(138, 138, 147)';
const ACCENT = 'rgb(221, 44, 39)';
const ACCENT_STRONG = 'rgb(185, 28, 28)';
const DONE = 'rgb(21, 128, 61)';
const STATUS_COLOURS = [ACCENT, 'rgb(37, 99, 235)', 'rgb(245, 158, 11)', DONE, 'rgb(100, 116, 139)'];

async function openKit(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/**`, (route) => route.fulfill({ status: 204 }));
  await page.goto(`${CONSOLE}/kit`);
  await expect(page.locator('[data-kit="notices"]')).toBeVisible();
}

type Style = Partial<Record<keyof CSSStyleDeclaration & string, string>>;

/** The computed values of a few properties, and the box. */
function styleOf(locator: Locator, properties: string[]): Promise<Record<string, string | number>> {
  return locator.first().evaluate((element, names) => {
    const computed = getComputedStyle(element) as unknown as Record<string, string>;
    const box = element.getBoundingClientRect();
    const read: Record<string, string | number> = { width: box.width, height: box.height };
    for (const name of names) read[name] = computed[name] as string;

    return read;
  }, properties);
}

/** Each property of `expected` is what the browser computed for the first element of `locator`. */
async function expectStyle(locator: Locator, name: string, expected: Style & { height?: string; width?: string }) {
  const { height, width, ...styles } = expected;
  const read = await styleOf(locator, Object.keys(styles));
  for (const [property, value] of Object.entries(styles))
    expect.soft(read[property], `${name}: ${property}`).toBe(value);
  if (height !== undefined) expect.soft(`${read.height}px`, `${name}: height`).toBe(height);
  if (width !== undefined) expect.soft(`${read.width}px`, `${name}: width`).toBe(width);
}

test('the buttons have the measures of the mockup (FRU-232)', async ({ page }) => {
  await openKit(page);
  const buttons = page.locator('[data-kit="buttons"]');
  const button = (name: string) => buttons.getByRole('button', { name, exact: true });

  // `.b-accent`: the pill of the action of a step.
  await expectStyle(button('Email me a link'), 'primary', {
    height: '44px',
    paddingLeft: '22px',
    paddingRight: '22px',
    borderTopWidth: '0px',
    borderTopLeftRadius: '999px',
    backgroundColor: ACCENT,
    color: WHITE,
    fontSize: '14px',
    fontWeight: '600',
    // -0.006em of 14 px.
    letterSpacing: '-0.084px',
  });
  await expectStyle(button('Primary disabled'), 'primary, disabled', { opacity: '0.5', cursor: 'not-allowed' });

  // `.b-wide`: the rectangle of a control, at its three heights.
  const outline = {
    borderTopWidth: '1px',
    borderTopColor: CONTROL,
    borderTopLeftRadius: '6px',
    backgroundColor: WHITE,
    color: INK,
    fontWeight: '600',
  };
  await expectStyle(button('Try again'), 'outline, page', {
    ...outline,
    height: '44px',
    paddingLeft: '18px',
    fontSize: '14px',
  });
  await expectStyle(button('Connect'), 'outline, panel', {
    ...outline,
    height: '40px',
    paddingLeft: '16px',
    fontSize: '14px',
  });
  await expectStyle(button('Send again'), 'outline, small', {
    ...outline,
    height: '32px',
    paddingLeft: '10px',
    fontSize: '13px',
  });
  await expectStyle(button('Outline disabled'), 'outline, disabled', { opacity: '0.5', cursor: 'not-allowed' });
  // The padding the mockup writes on one button: 16 px on « Send again », which is 157.5 px wide there.
  await expectStyle(button('Send again in 0:41'), 'outline, with its own padding', {
    height: '44px',
    paddingLeft: '16px',
    paddingRight: '16px',
  });
  // The width of a text is of its font. The mockup is measured in the system font of macOS, and the
  // CI draws the system font of Linux: there the padding is measured, and the width is not.
  if (process.platform === 'darwin') {
    expect
      .soft((await button('Send again in 0:41').boundingBox())!.width, 'the width of « Send again »')
      .toBeCloseTo(157.5, 0);
  }
  // A link drawn as a control has the same box.
  await expectStyle(buttons.getByRole('link', { name: 'Continue in this tab' }), 'outline, link', {
    ...outline,
    height: '44px',
    paddingLeft: '18px',
    textDecorationLine: 'none',
  });
  await expectStyle(page.locator('[data-kit="wide"]').getByRole('button', { name: 'Continue with Google' }), 'wide', {
    ...outline,
    height: '44px',
    width: '400px',
  });

  // `.b-link`: underlined words, and a target of 33 px at the least (A23 of the mockup's inventory).
  const link = {
    color: INK,
    fontSize: '14px',
    fontWeight: '600',
    textDecorationLine: 'underline',
    textUnderlineOffset: '3px',
    borderTopWidth: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  };
  await expectStyle(button('Use another address'), 'link', { ...link, paddingTop: '8px', paddingBottom: '8px' });
  await expectStyle(button('Loose link'), 'link, loose', { ...link, paddingTop: '12px' });
  await expectStyle(button('Link disabled'), 'link, disabled', { opacity: '0.5' });
  await expectStyle(buttons.getByRole('link', { name: 'Help and docs' }), 'link to an address', {
    ...link,
    paddingTop: '8px',
  });
  const target = await button('Use another address').boundingBox();
  expect.soft(target!.height, 'the target of a link').toBeGreaterThanOrEqual(24);

  // The tones of before the mockup stay as HeroUI draws them: a pill, in semibold.
  for (const name of ['Quiet', 'Danger']) {
    const before = await styleOf(button(name), ['borderTopLeftRadius', 'fontWeight']);
    expect.soft(Number.parseFloat(String(before.borderTopLeftRadius)), `${name}: a pill`).toBeGreaterThanOrEqual(18);
    expect.soft(before.fontWeight, `${name}: weight`).toBe('600');
  }

  // `.b-ghost`: a picture of 36 px.
  const icon = button('More for staging.acme.dev');
  await expectStyle(icon, 'icon', {
    width: '36px',
    height: '36px',
    borderTopLeftRadius: '8px',
    color: MUTED_TONE,
    backgroundColor: 'rgba(0, 0, 0, 0)',
  });
  await expect(icon).toHaveAttribute('aria-haspopup', 'menu');
});

test('a button changes under the pointer as on the mockup, and shows its focus (FRU-232)', async ({ page }) => {
  await openKit(page);
  const buttons = page.locator('[data-kit="buttons"]');
  const hovered = async (locator: Locator, name: string, expected: Style) => {
    await locator.hover();
    await expectStyle(locator, `${name}, under the pointer`, expected);
    await page.mouse.down();
    await expectStyle(locator, `${name}, pressed`, { ...expected, transform: 'none' });
    await page.mouse.up();
    await page.mouse.move(0, 0);
  };

  await hovered(buttons.getByRole('button', { name: 'Email me a link' }), 'primary', {
    backgroundColor: ACCENT_STRONG,
  });
  await hovered(buttons.getByRole('button', { name: 'Try again' }), 'outline', {
    backgroundColor: SUBTLE,
    borderTopColor: INK,
  });
  await hovered(buttons.getByRole('button', { name: 'Use another address' }), 'link', { color: ACCENT_STRONG });
  await hovered(buttons.getByRole('button', { name: 'More for staging.acme.dev' }), 'icon', { backgroundColor: CHIP });
  // A disabled control does not answer the pointer.
  await buttons.getByRole('button', { name: 'Primary disabled' }).hover({ force: true });
  await expectStyle(buttons.getByRole('button', { name: 'Primary disabled' }), 'primary, disabled, under the pointer', {
    backgroundColor: ACCENT,
  });

  // The ring of the mockup, on each kind of control, reached with the keyboard.
  const ring = { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: ACCENT, outlineOffset: '2px' };
  const controls: [string, Locator][] = [
    ['primary', buttons.getByRole('button', { name: 'Email me a link' })],
    ['outline', buttons.getByRole('button', { name: 'Try again' })],
    ['link', buttons.getByRole('button', { name: 'Use another address' })],
    ['icon', buttons.getByRole('button', { name: 'More for staging.acme.dev' })],
    // The two tones of before the mockup keep the ring too, and their round shape.
    ['quiet', buttons.getByRole('button', { name: 'Quiet', exact: true })],
    ['danger', buttons.getByRole('button', { name: 'Danger', exact: true })],
    ['field', page.getByRole('textbox', { name: 'Work email' })],
    ['chip', page.getByRole('button', { name: /^New/ })],
  ];
  for (const [name, control] of controls) {
    // A press of Tab from the control before it: `:focus-visible` is the keyboard's.
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(control, name).toBeFocused();
    await expectStyle(control, `${name}, with focus`, ring);
  }
});

test('the fields, the lists and the radio cards have the measures of the mockup (FRU-232)', async ({ page }) => {
  await openKit(page);
  const fields = page.locator('[data-kit="fields"]');
  const box = {
    borderTopWidth: '1px',
    borderTopColor: CONTROL,
    borderTopLeftRadius: '8px',
    backgroundColor: WHITE,
    color: INK,
    fontWeight: '400',
  };

  const email = fields.getByRole('textbox', { name: 'Work email' });
  await expectStyle(email, 'field', {
    ...box,
    height: '44px',
    paddingLeft: '14px',
    fontSize: '15px',
    caretColor: ACCENT,
    boxShadow: 'none',
  });
  expect
    .soft(await email.evaluate((element) => getComputedStyle(element, '::placeholder').color), 'placeholder')
    .toBe(MUTED_TONE);
  await expectStyle(fields.locator('label', { hasText: 'Work email' }), 'label', {
    color: INK,
    fontSize: '13px',
    fontWeight: '600',
  });
  await expectStyle(fields.getByText('Your workspace takes the name of your domain.'), 'hint', {
    color: MUTED_TONE,
    fontSize: '13px',
    lineHeight: '19.5px',
  });
  // The label, the control and the hint are 6 px apart.
  const gaps = await fields
    .locator('.kit-field')
    .first()
    .evaluate((field) => {
      const [label, input, hint] = [...field.children].map((child) => child.getBoundingClientRect());

      return [input!.top - label!.bottom, hint!.top - input!.bottom];
    });
  expect.soft(gaps, 'the gaps of a field').toEqual([6, 6]);
  // The field keeps its border under the pointer: the mockup draws no hover on a field.
  await email.hover();
  await expectStyle(email, 'field, under the pointer', { borderTopColor: CONTROL, backgroundColor: WHITE });
  await page.mouse.move(0, 0);

  await expectStyle(fields.getByRole('textbox', { name: 'Search' }), 'field, compact', {
    ...box,
    height: '40px',
    paddingLeft: '12px',
    fontSize: '14px',
  });
  const locked = fields.getByRole('textbox', { name: 'Instance address' });
  await expectStyle(locked, 'field, locked', {
    height: '44px',
    borderTopColor: LINE,
    backgroundColor: SUBTLE,
    color: INK_SOFT,
  });
  await expect(locked).toHaveAttribute('readonly', '');

  await expectStyle(fields.getByRole('button', { name: /^Guest, one site Role|^Role/ }), 'list', {
    ...box,
    height: '44px',
    paddingLeft: '12px',
    fontSize: '15px',
  });
  await expectStyle(fields.getByRole('button', { name: /Compact role/ }), 'list, compact', {
    ...box,
    height: '40px',
    fontSize: '14px',
  });

  const card = { paddingTop: '14px', paddingLeft: '16px', borderTopWidth: '1px', borderTopLeftRadius: '10px' };
  await expectStyle(fields.locator('.kit-pick__card', { hasText: 'Members of Acme' }), 'radio card, chosen', {
    ...card,
    borderTopColor: INK,
  });
  await expectStyle(fields.locator('.kit-pick__card', { hasText: 'Everyone who visits' }), 'radio card', {
    ...card,
    borderTopColor: LINE,
  });
  await expectStyle(fields.locator('.kit-pick__card .radio__control').first(), 'radio, chosen', {
    width: '16px',
    height: '16px',
    backgroundColor: INK,
  });
  await expect(fields.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
});

test('the switch is the one of the mockup, and a keyboard turns it (FRU-232)', async ({ page }) => {
  await openKit(page);
  const toggles = page.locator('[data-kit="toggles"]');
  const on = toggles.getByRole('switch', { name: 'Show Linear comments as replies' });
  const off = toggles.getByRole('switch', { name: 'Attach a picture of the element' });
  await expect(on).toBeChecked();
  await expect(off).not.toBeChecked();

  const track = (name: string) => toggles.locator('.kit-toggle', { hasText: name }).locator('.switch__control');
  const thumb = (name: string) => toggles.locator('.kit-toggle', { hasText: name }).locator('.switch__thumb');
  /** Where the thumb is in its track. */
  const place = async (name: string) => {
    const [outer, inner] = await Promise.all([track(name).boundingBox(), thumb(name).boundingBox()]);

    return { left: inner!.x - outer!.x, top: inner!.y - outer!.y, size: [inner!.width, inner!.height] };
  };

  const shape = { width: '40px', height: '24px', borderTopLeftRadius: '999px' };
  await expectStyle(track('Show Linear comments'), 'switch, on', { ...shape, backgroundColor: INK });
  await expectStyle(track('Attach a picture'), 'switch, off', { ...shape, backgroundColor: CONTROL });
  await expectStyle(thumb('Attach a picture'), 'thumb', {
    backgroundColor: WHITE,
    boxShadow: 'rgba(0, 0, 0, 0.25) 0px 1px 3px 0px',
    transitionDuration: '0.22s',
    transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    transitionProperty: 'transform',
  });
  // A21 of the inventory: the track changes colour in 200 ms on every switch.
  await expectStyle(track('Attach a picture'), 'track', { transitionDuration: '0.2s' });
  expect.soft(await place('Attach a picture'), 'thumb, off').toEqual({ left: 3, top: 3, size: [18, 18] });
  expect.soft(await place('Show Linear comments'), 'thumb, on').toEqual({ left: 19, top: 3, size: [18, 18] });

  await off.focus();
  await page.keyboard.press('Space');
  await expect(off).toBeChecked();
  await expect.poll(() => place('Attach a picture')).toEqual({ left: 19, top: 3, size: [18, 18] });
  await expectStyle(track('Attach a picture'), 'switch, turned on', { backgroundColor: INK });

  const disabled = toggles.getByRole('switch', { name: 'A setting that cannot change' });
  await expect(disabled).toBeDisabled();
  // The control is dimmed. The words are not: they say what the setting is, to everybody.
  await expectStyle(track('A setting that cannot change'), 'switch, disabled', { opacity: '0.5' });
  await expectStyle(toggles.getByText('A setting that cannot change'), 'label of a disabled switch', {
    opacity: '1',
    color: INK,
  });
});

test('the switch does not move for somebody who asked for less motion (FRU-232)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openKit(page);
  const toggle = page.locator('[data-kit="toggles"] .kit-toggle').first();

  await expectStyle(toggle.locator('.switch__thumb'), 'thumb', { transitionDuration: '0s' });
  await expectStyle(toggle.locator('.switch__control'), 'track', { transitionDuration: '0s' });
});

test('a status has its colour, its shape, and words beside it (FRU-232)', async ({ page }) => {
  await openKit(page);
  const statuses = page.locator('[data-kit="statuses"]');

  const dots = statuses.locator('ul .kit-drop');
  await expect(dots).toHaveCount(5);
  for (const [index, colour] of STATUS_COLOURS.entries()) {
    await expectStyle(dots.nth(index), `status ${index}`, {
      width: '9px',
      height: '9px',
      backgroundColor: colour,
      borderTopLeftRadius: '50%',
      borderBottomLeftRadius: '0px',
      // rotate(-90deg).
      transform: 'matrix(0, -1, 1, 0, 0, 0)',
    });
    // The drop says nothing to a screen reader, and its item has a word.
    await expect(dots.nth(index)).toHaveAttribute('aria-hidden', 'true');
    expect.soft((await statuses.locator('ul li').nth(index).innerText()).trim()).not.toBe('');
  }
  await expectStyle(statuses.locator('p .kit-drop').nth(0), 'status, 10 px', { width: '10px', height: '10px' });
  await expectStyle(statuses.locator('p .kit-drop').nth(1), 'status, 11 px', { width: '11px', height: '11px' });

  const bar = statuses.getByRole('img', { name: '3 new, 2 to do, 4 in progress, 2 done, 1 closed' }).first();
  await expectStyle(bar, 'bar', { width: '128px', height: '8px', borderTopLeftRadius: '999px', columnGap: '2px' });
  const segments = await bar.locator('span').evaluateAll((spans) =>
    spans.map((span) => ({
      colour: getComputedStyle(span).backgroundColor,
      width: span.getBoundingClientRect().width,
    })),
  );
  expect.soft(segments.map((segment) => segment.colour)).toEqual(STATUS_COLOURS);
  // 128 px less four gaps of 2 px, shared as 3, 2, 4, 2, 1 of 12.
  expect.soft(segments.map((segment) => segment.width)).toEqual([30, 20, 40, 20, 10]);
  // A status with no note takes no room, and the words still count it.
  const short = statuses.getByRole('img', { name: '1 new, 0 to do, 0 in progress, 2 done, 0 closed' });
  await expectStyle(short, 'bar, short', { width: '96px', backgroundColor: CHIP });
  await expect(short.locator('span')).toHaveCount(2);

  await expectStyle(statuses.locator('.kit-success'), 'success', {
    width: '40px',
    height: '40px',
    backgroundColor: DONE,
    boxShadow: 'rgba(24, 24, 27, 0.28) 0px 3px 10px 0px',
    transform: 'matrix(0, -1, 1, 0, 0, 0)',
  });
  await expectStyle(statuses.locator('.kit-success svg'), 'success, check', { width: '18px', height: '18px' });
});

test('a filter is a pressed button, with the three looks of the mockup (FRU-232)', async ({ page }) => {
  await openKit(page);
  const filters = page.getByRole('group', { name: 'Filters' });
  const chip = (name: RegExp) => filters.getByRole('button', { name });
  const shape = {
    height: '36px',
    paddingLeft: '14px',
    borderTopWidth: '1px',
    borderTopLeftRadius: '999px',
    fontSize: '13px',
    fontWeight: '600',
  };

  await expect(chip(/^All/)).toHaveAttribute('aria-pressed', 'true');
  await expectStyle(chip(/^All/), 'chip, pressed', {
    ...shape,
    backgroundColor: INK,
    borderTopColor: INK,
    color: WHITE,
  });
  await expectStyle(chip(/^All/).locator('.kit-chip__count'), 'count, pressed', {
    color: 'rgb(212, 212, 216)',
    fontWeight: '400',
  });
  await expect(chip(/^New/)).toHaveAttribute('aria-pressed', 'false');
  await expectStyle(chip(/^New/), 'chip', { ...shape, backgroundColor: WHITE, borderTopColor: CONTROL, color: INK });
  await expectStyle(chip(/^Not delivered/), 'chip, alert', { ...shape, backgroundColor: WHITE, color: ACCENT });

  await chip(/^New/).hover();
  await expectStyle(chip(/^New/), 'chip, under the pointer', { borderTopColor: INK, backgroundColor: WHITE });
  await chip(/^New/).press('Enter');
  await expect(chip(/^New/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(/^All/)).toHaveAttribute('aria-pressed', 'false');
});

test('a table, a panel and a list of values have the frame of the mockup (FRU-232)', async ({ page }) => {
  await openKit(page);

  const table = page.getByRole('region', { name: 'Members' });
  await expectStyle(table, 'table', {
    borderTopWidth: '1px',
    borderTopColor: LINE,
    borderTopLeftRadius: '14px',
    overflowX: 'auto',
  });
  await expectStyle(table.locator('th').first(), 'heading', {
    color: MUTED_TONE,
    fontSize: '13px',
    fontWeight: '600',
    paddingTop: '12px',
    paddingLeft: '20px',
    borderBottomColor: LINE,
    textAlign: 'left',
  });
  await expectStyle(table.locator('th').nth(1), 'heading, inside', { paddingLeft: '16px', paddingRight: '16px' });
  await expectStyle(table.locator('th').last(), 'heading, last', { paddingRight: '20px', textAlign: 'right' });
  await expectStyle(table.locator('td').first(), 'cell', {
    fontSize: '14px',
    // 1.45 of 14 px.
    lineHeight: '20.3px',
    paddingTop: '12px',
    paddingLeft: '20px',
    borderBottomWidth: '1px',
    borderBottomColor: LINE,
  });
  await table.locator('tbody tr').first().hover();
  await expectStyle(table.locator('tbody tr').first(), 'row, under the pointer', { backgroundColor: SUBTLE });
  await page.mouse.move(0, 0);
  // A table wider than its frame scrolls in it, and a keyboard reaches the frame.
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = await table.evaluate((frame) => ({ inner: frame.scrollWidth, outer: frame.clientWidth }));
  expect.soft(scroll.inner).toBeGreaterThan(scroll.outer);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(table).toHaveAttribute('tabindex', '0');
  await page.setViewportSize({ width: 1440, height: 900 });

  await expectStyle(table.locator('.kit-avatar').first(), 'avatar', {
    width: '32px',
    height: '32px',
    backgroundColor: 'rgb(63, 63, 70)',
    color: WHITE,
    fontSize: '13px',
    fontWeight: '700',
  });
  await expectStyle(table.locator('.kit-avatar[data-pending="true"]'), 'avatar, invited', {
    backgroundColor: WHITE,
    color: MUTED_TONE,
    borderTopColor: LINE,
  });

  const panel = page.getByRole('complementary', { name: 'Linear' });
  await expectStyle(panel, 'panel', {
    backgroundColor: SUBTLE,
    borderTopWidth: '1px',
    borderTopColor: LINE,
    borderTopLeftRadius: '14px',
  });
  await expectStyle(panel.locator('.kit-panel__head'), 'panel, head', {
    paddingTop: '20px',
    paddingLeft: '22px',
    borderBottomColor: LINE,
  });
  await expectStyle(panel.getByRole('heading', { name: 'Linear' }), 'panel, title', {
    fontSize: '18px',
    fontWeight: '700',
  });
  await expectStyle(panel.locator('.kit-panel__body'), 'panel, body', {
    paddingTop: '20px',
    paddingLeft: '22px',
    rowGap: '24px',
  });
  await expectStyle(panel.locator('.kit-panel__foot'), 'panel, foot', {
    paddingTop: '14px',
    paddingLeft: '22px',
    borderTopColor: LINE,
  });

  const values = page.locator('.kit-key-value');
  await expectStyle(values, 'values', { borderTopWidth: '1px', borderTopColor: LINE, fontSize: '15px' });
  await expectStyle(values.locator('div').first(), 'value, row', {
    paddingTop: '12px',
    paddingBottom: '12px',
    borderBottomColor: LINE,
  });
  await expectStyle(values.locator('dt').first(), 'name', { color: MUTED_TONE });
  await expectStyle(values.locator('dd').first(), 'value', { fontWeight: '600', textAlign: 'right' });
});

test('the head of a page has the type of the mockup (FRU-232)', async ({ page }) => {
  await openKit(page);
  const title = { fontWeight: '700', color: INK };

  await expectStyle(page.getByRole('heading', { name: 'Kit', exact: true }), 'title', {
    ...title,
    fontSize: '28px',
    // 1.15 of 28 px, and -0.02em.
    lineHeight: '32.2px',
    letterSpacing: '-0.56px',
    marginBottom: '6px',
  });
  await expectStyle(page.getByText('Every component of the console, once.'), 'lead', {
    color: MUTED_TONE,
    fontSize: '16px',
    lineHeight: '24px',
  });
  await expectStyle(page.getByRole('heading', { name: 'Set up Fruitback' }), 'title of the setup', {
    ...title,
    fontSize: '30px',
    lineHeight: '34.5px',
    letterSpacing: '-0.6px',
  });
  await expectStyle(page.locator('body'), 'page', { backgroundColor: WHITE, color: INK });
});

test("the logo and the frame of a page outside a workspace are the mockup's (FRU-232)", async ({ page }) => {
  await openKit(page);
  const logos = page.locator('[data-kit="logos"]');

  // 113 × 22 on a page, in ink and the accent; 82 × 16 on the rail, in white and the accent of the rail.
  const onPage = logos.getByRole('img', { name: 'Fruitback' }).first();
  await expectStyle(onPage, 'logo', { width: '113px', height: '22px' });
  await expectStyle(onPage.locator('path').nth(0), 'logo, name', { fill: INK });
  await expectStyle(onPage.locator('path').nth(1), 'logo, drop', { fill: ACCENT });
  const onRail = logos.getByRole('img', { name: 'Fruitback' }).nth(1);
  await expectStyle(onRail, 'logo of the rail', { width: '82px', height: '16px' });
  await expectStyle(onRail.locator('path').nth(0), 'logo of the rail, name', { fill: WHITE });
  await expectStyle(onRail.locator('path').nth(1), 'logo of the rail, drop', { fill: 'rgb(236, 91, 87)' });

  await page.goto(`${CONSOLE}/kit/entry`);
  const header = page.locator('header');
  await expectStyle(header, 'header', { borderBottomWidth: '1px', borderBottomColor: LINE, height: '65px' });
  // clamp(16px, 4vw, 32px) at 1440 px.
  await expectStyle(header.locator('> div'), 'header, inside', {
    paddingLeft: '32px',
    minHeight: '64px',
    maxWidth: '1280px',
  });
  const home = header.getByRole('link', { name: 'Fruitback' });
  await expect(home).toHaveAttribute('href', 'https://fruitback.com');
  // The logo of screen 02 of the mockup, at 1440 px: x 80, y 21 (`measures.json`).
  const logo = await home.getByRole('img').boundingBox();
  expect.soft(logo).toEqual({ x: 80, y: 21, width: 113, height: 22 });

  // clamp(48px, 10vh, 112px) of a screen of 900 px, and a column of 400 px in the middle.
  await expectStyle(page.locator('main'), 'main', { paddingTop: '90px', paddingLeft: '16px', paddingBottom: '64px' });
  const title = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect.soft({ x: title!.x, y: title!.y, width: title!.width }).toEqual({ x: 520, y: 155, width: 400 });
  // A screen places a component: a margin it writes on one is not lost under a rule of the kit.
  await expectStyle(page.locator('.kit-lead'), 'lead, placed by the screen', { marginBottom: '28px' });
  await expectStyle(page.locator('.kit-divider'), 'divider', {
    color: MUTED_TONE,
    fontSize: '13px',
    columnGap: '12px',
  });
  await expect(page.locator('.kit-divider')).toHaveAttribute('aria-hidden', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  // clamp(16px, 4vw, 32px) at 390 px is 16 px, and 10vh of 844 px is 84.4 px.
  await expectStyle(header.locator('> div'), 'header, narrow', { paddingLeft: '16px' });
  await expectStyle(page.locator('main'), 'main, narrow', { paddingTop: '84.4px' });
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
});

test('a menu opens from its button, a keyboard walks it, and Escape gives focus back (FRU-232)', async ({ page }) => {
  await openKit(page);
  const menus = page.locator('[data-kit="menus"]');
  const picked = menus.locator('[data-kit="menu-picked"]');

  // A button that is a picture: the box of the « … » of a row of the mockup, named for a screen reader.
  const more = menus.getByRole('button', { name: 'More for staging.acme.dev' });
  await expectStyle(more, 'the button of a menu', {
    height: '36px',
    width: '36px',
    borderTopLeftRadius: '8px',
    color: MUTED_TONE,
  });
  await expect(more).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await more.focus();
  await page.keyboard.press('Enter');
  // The menu is named after its button.
  const menu = page.getByRole('menu', { name: 'More for staging.acme.dev' });
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveText(['Install', 'Change who sees the notes', 'Not yet', 'Remove']);

  // The surface of a page with the frame of a card. The menu is not drawn in the mockup.
  const popover = page.locator('.kit-menu');
  await expectStyle(popover, 'menu', {
    backgroundColor: WHITE,
    borderTopWidth: '1px',
    borderTopColor: LINE,
    borderTopLeftRadius: '10px',
    color: INK,
  });
  const install = menu.getByRole('menuitem', { name: 'Install' });
  await expectStyle(install, 'item', { minHeight: '40px', borderTopLeftRadius: '6px', fontSize: '14px' });
  // An item that takes something away is the strong accent: 6.47:1 on white, 5.89:1 on the tint of an item.
  const remove = menu.getByRole('menuitem', { name: 'Remove' });
  await expectStyle(remove, 'item that removes', { color: ACCENT_STRONG });
  await expect(menu.getByRole('menuitem', { name: 'Not yet' })).toHaveAttribute('aria-disabled', 'true');

  // The keyboard is on the first item, which shows it; the arrows walk the items, past the disabled one.
  await expect(install).toBeFocused();
  await expectStyle(install, 'item with focus', {
    outlineStyle: 'solid',
    outlineWidth: '2px',
    outlineColor: ACCENT,
    backgroundColor: CHIP,
  });
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Change who sees the notes' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(remove).toBeFocused();
  expect
    .soft(contrast(await painted(remove, 'color'), await painted(remove, 'backgroundColor')))
    .toBeGreaterThanOrEqual(4.5);
  const open = await new AxeBuilder({ page }).include('.kit-menu').analyze();
  expect
    .soft(open.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);

  // Escape closes the menu with nothing done, and focus is back on the button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(picked).toHaveText('Picked: nothing, acme');

  // An item pressed says which one it is, and the menu closes.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(picked).toHaveText('Picked: audience, acme');
  await expect(more).toBeFocused();

  // A menu that is a choice: its items are radios, and the current one is checked.
  const choice = menus.getByRole('button', { name: 'Workspace' });
  await choice.click();
  const radios = page.getByRole('menu', { name: 'Workspace' }).getByRole('menuitemradio');
  await expect(radios).toHaveCount(2);
  await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'false');
  await expect(radios.nth(1)).toContainText('Lumen Studio');
  // The second line of an item is its description, in the muted tone: 5.28:1 on white.
  await expectStyle(radios.nth(1).getByText('Member'), 'detail of an item', { color: MUTED_TONE, fontSize: '13px' });
  // The menu of a button of the rail is a page all the same: its ring is the one of a page.
  await radios.nth(1).hover();
  await expectStyle(radios.nth(1), 'item under the pointer', { backgroundColor: CHIP });
  await radios.nth(1).click();
  await expect(picked).toHaveText('Picked: audience, lumen');
  await choice.click();
  await expect(page.getByRole('menuitemradio', { name: /Lumen Studio/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});

/** Each text of the page with the colour it is painted in and the colour that is behind it. */
function pairs(page: Page): Promise<{ text: string; ratio: number }[]> {
  return page.evaluate(() => {
    const channels = (colour: string): number[] => {
      const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);

      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (colour: number[]) => {
      const [red = 0, green = 0, blue = 0] = colour.map((channel) => {
        const value = channel / 255;

        return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });

      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    /** The colours behind an element, the nearest first, painted one over the other on white. */
    const behind = (element: Element): number[] => {
      const layers: number[][] = [];
      for (let each: Element | null = element; each !== null; each = each.parentElement) {
        const layer = channels(getComputedStyle(each).backgroundColor);
        if (layer[3] !== 0) layers.push(layer);
        if (layer[3] === 255) break;
      }
      let under = [255, 255, 255];
      for (const layer of layers.reverse()) {
        const alpha = (layer[3] ?? 255) / 255;
        under = under.map((channel, index) => (layer[index] ?? 0) * alpha + channel * (1 - alpha));
      }

      return under;
    };
    /** Disabled, which WCAG exempts, or hidden from everybody. */
    const exempt = (element: Element) =>
      element.closest('[disabled], [aria-disabled="true"], [data-disabled="true"], [aria-hidden="true"], .sr-only') !==
      null;

    const found: { text: string; ratio: number }[] = [];
    const walker = document.createTreeWalker(document.querySelector('main')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const element = node.parentElement;
      if (text === '' || element === null || exempt(element)) continue;
      const [front, back] = [luminance(channels(getComputedStyle(element).color)), luminance(behind(element))];
      const [light, dark] = front > back ? [front, back] : [back, front];
      found.push({ text, ratio: (light + 0.05) / (dark + 0.05) });
    }
    for (const input of document.querySelectorAll('main input[placeholder]:not([disabled])')) {
      const front = luminance(channels(getComputedStyle(input, '::placeholder').color));
      const back = luminance(behind(input));
      found.push({ text: `placeholder: ${input.getAttribute('placeholder')}`, ratio: (front + 0.05) / (back + 0.05) });
    }

    return found.map((pair) => ({ ...pair, ratio: pair.ratio < 1 ? 1 / pair.ratio : pair.ratio }));
  });
}

test('every text of the kit is 4.5:1 on what is behind it, and axe finds nothing (FRU-232)', async ({ page }) => {
  await openKit(page);

  const all = await pairs(page);
  // The control of the walk: it found the texts, the placeholder among them, and the lowest pair
  // of the kit is the one the mockup has, white on the accent (4.70:1).
  expect(all.length).toBeGreaterThan(60);
  expect(all.map((pair) => pair.text)).toContain('placeholder: you@studio.com');
  const low = all.filter((pair) => pair.ratio < 4.5).map((pair) => `${pair.text}: ${pair.ratio.toFixed(2)}`);
  expect(low).toEqual([]);
  const lowest = Math.min(...all.map((pair) => pair.ratio));
  expect(lowest).toBeGreaterThan(4.6);
  expect(lowest).toBeLessThan(4.8);

  // The alert that is a text alone: the accent on white, the strong accent on a tint (A22).
  await expectStyle(page.locator('[data-kit="alert-on-white"]'), 'alert on white', { color: ACCENT });
  await expectStyle(page.locator('[data-kit="alert-on-chip"]'), 'alert on a tint', {
    color: ACCENT_STRONG,
    backgroundColor: CHIP,
  });
  await expectStyle(page.locator('[data-kit="alert-on-subtle"]'), 'alert on a panel', { color: ACCENT_STRONG });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
});

/** The screens of before the mockup, which take the new palette as they are. */
const SCREENS_OF_BEFORE = [
  '/setup',
  '/sign-in',
  '/invitations',
  '/w/w1/sites',
  '/w/w1/connectors',
  '/w/w1/members',
  '/w/w1/account',
];

test('axe finds nothing on the screens of before, in the new palette (FRU-232)', async ({ page }) => {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const member = {
    id: 'm1',
    userId: 'a1',
    role: 'owner',
    createdAt: '2026-10-01T08:00:00.000Z',
    user: { id: 'a1', email: 'ana@acme.dev', name: 'Ana' },
  };
  const invitation = {
    id: 'i1',
    email: 'tom@client.fr',
    role: 'guest',
    organizationId: 'w1',
    organizationName: 'Acme',
    status: 'pending',
    expiresAt: '2026-12-01T08:00:00.000Z',
  };
  let signedIn = false;
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: true, google: true } });
    if (pathname === '/console/me') return signedIn ? json(me) : json({ error: 'unauthorized' }, 401);
    if (pathname === '/console/workspaces/w1/domains') return json({ domains: [] });
    if (pathname === '/console/workspaces/w1/sites') {
      return json({ sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }] });
    }
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [], available: true });
    if (pathname.endsWith('/list-user-invitations')) return json([invitation]);
    if (pathname.endsWith('/list-invitations')) return json([invitation]);
    if (pathname.endsWith('/list-members')) return json({ members: [member] });

    return route.fulfill({ status: 204 });
  });

  for (const screen of SCREENS_OF_BEFORE) {
    // The setup and the sign-in are of nobody signed in. The others are of an owner.
    signedIn = screen !== '/setup' && screen !== '/sign-in';
    await page.goto(`${CONSOLE}${screen}`);
    await expect(page.locator('h1').first(), screen).toBeVisible();
    // No screen is still painted in a colour of before.
    expect.soft(await painted(page.locator('body'), 'backgroundColor'), screen).toEqual([255, 255, 255]);
    const results = await new AxeBuilder({ page }).analyze();
    expect
      .soft(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
        screen,
      )
      .toEqual([]);
  }
});
