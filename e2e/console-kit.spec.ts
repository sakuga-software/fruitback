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
/**
 * The development server of the console, for `/kit` alone: a build has no `/kit` (`kit-route.test.ts`),
 * and the specs serve the console built on 5178 (FRU-473, `playwright.config.ts`).
 */
const KIT = 'http://localhost:5179';
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
  // `design/boards/2-onboarding.png`, then screen 01 of the mockup of 2026-10-13: controls of one
  // shape, and the pill kept for the action of the step. The screen drew the wide buttons as pills
  // too, with a border of 1.26:1.
  await openSetup(page);
  const white = [255, 255, 255];

  for (const name of ['Continue with Google', 'Continue with GitHub']) {
    const button = await boxOf(page.getByRole('button', { name }));
    expect.soft(button.radius, name).toBe('6px');
    expect.soft(button.width, name).toBe('1px');
    // WCAG 1.4.11: the border is what says where the control is.
    expect.soft(contrast(button.border, white), name).toBeGreaterThanOrEqual(3);
  }

  const field = await boxOf(page.getByRole('textbox', { name: 'Work email' }));
  expect.soft(Number.parseFloat(field.radius)).toBeGreaterThanOrEqual(8);
  expect.soft(Number.parseFloat(field.radius)).toBeLessThanOrEqual(10);
  expect.soft(contrast(field.border, white)).toBeGreaterThanOrEqual(3);
  // Flat: no shadow, or one that paints nothing.
  expect.soft(field.shadow).toMatch(/^none$|^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/);

  // The action of the step keeps the pill: its shape is what tells it from the controls.
  const action = await boxOf(page.getByRole('button', { name: 'Email me a link' }));
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
/** The five statuses of the widget, chosen by Mathieu (FRU-334), and the edge of their drop. */
const STATUS_COLOURS = [
  'rgb(190, 194, 200)',
  'rgb(217, 219, 223)',
  'rgb(243, 187, 61)',
  'rgb(85, 96, 196)',
  'rgb(165, 42, 58)',
];
const STATUS_EDGE = 'rgb(138, 138, 147) 0px 0px 0px 1px';

async function openKit(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/**`, (route) => route.fulfill({ status: 204 }));
  await page.goto(`${KIT}/kit`);
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

test('a read that failed has a title, a sentence and one « Try again », in the box of the mockup (FRU-508)', async ({
  page,
}) => {
  await openKit(page);
  const failed = page.locator('[data-kit="load-failed"]').getByRole('alert');
  await expect(failed.getByRole('heading', { level: 2, name: 'The notes did not load' })).toBeVisible();
  await expect(failed.locator('p')).toHaveText('Fruitback hit an error. Try again in a moment. Your notes are safe.');
  await expect(failed.getByRole('button')).toHaveText(['Try again']);
  await expectStyle(failed, 'box', {
    paddingTop: '28px',
    paddingLeft: '32px',
    borderTopWidth: '1px',
    borderTopColor: CONTROL,
    borderTopLeftRadius: '14px',
  });
  await expectStyle(failed.locator('p'), 'sentence', { color: MUTED_TONE });
});

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

  // A button over its column keeps 44 px with a short name, and grows with a long one: its words
  // wrap in it, and nothing goes out of the column.
  const long = page
    .locator('[data-kit="wide"]')
    .getByRole('button', { name: /^Join a workspace with a very long name/ });
  const grown = (await long.boundingBox())!;
  expect.soft(grown.width, 'a wide button with a long name stays in its column').toBe(400);
  expect.soft(grown.height, 'a wide button with a long name takes two lines').toBeGreaterThan(44);
  expect.soft(await long.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

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
  // The question is 8 px over the first card, the cards are 8 px apart, and a card is 90 px high
  // with a detail of two lines on the mockup: here one line, 70.5 px.
  const [question, first, second] = await Promise.all(
    ['.kit-pick > .label', '.kit-pick__card >> nth=0', '.kit-pick__card >> nth=1'].map(
      async (selector) => (await fields.locator(selector).boundingBox())!,
    ),
  );
  expect.soft(first!.y - (question!.y + question!.height), 'the question over the cards').toBe(8);
  expect.soft(second!.y - (first!.y + first!.height), 'between two cards').toBe(8);
  expect.soft(first!.height, 'a card with a detail of one line').toBe(70.5);
  // The words of a card start 30 px after its radio starts, the title and the detail alike.
  const starts = await fields
    .locator('.kit-pick__card')
    .first()
    .evaluate((card) =>
      ['.radio__control', '.radio__content .label', '.description'].map((selector) => {
        const element = card.querySelector(selector) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(element);

        return Math.round((selector === '.radio__control' ? element : range).getBoundingClientRect().left);
      }),
    );
  expect.soft([starts[1]! - starts[0]!, starts[2]! - starts[0]!], 'the words after the radio').toEqual([30, 30]);
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
  // A pointer turns it from its track too, and not only from its words.
  await track('Show Linear comments').click();
  await expect(on).not.toBeChecked();

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

test('a fold opens with a keyboard, is a 44 px line between two rules, and turns its chevron (FRU-538)', async ({
  page,
}) => {
  await openKit(page);
  const fold = page.locator('[data-kit="disclosure"] details');
  const summary = fold.locator('summary');
  const inside = fold.getByText('What the page keeps folded.');
  await expect(fold).not.toHaveAttribute('open');
  await expect(inside).toBeHidden();
  await expectStyle(fold, 'fold', {
    borderTopWidth: '1px',
    borderTopColor: LINE,
    borderBottomWidth: '1px',
    borderBottomColor: LINE,
  });
  await expectStyle(summary, 'line of a fold', { cursor: 'pointer', listStyleType: 'none' });
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectStyle(summary.getByText('Advanced', { exact: true }), 'title of a fold', {
    fontSize: '18px',
    fontWeight: '700',
    color: INK,
  });
  await expectStyle(summary.getByText('Statuses, starting an agent, preview deploys'), 'hint of a fold', {
    fontSize: '14px',
    color: MUTED_TONE,
  });
  const chevron = summary.locator('svg');
  await expectStyle(chevron, 'chevron, folded', { transform: 'none' });

  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(fold).toHaveAttribute('open');
  await expect(inside).toBeVisible();
  // Turned a quarter of a turn, read from its matrix once the move ends.
  const angle = () =>
    chevron.evaluate((element) => {
      const { a, b } = new DOMMatrix(getComputedStyle(element).transform);

      return Math.round((Math.atan2(b, a) * 180) / Math.PI);
    });
  await expect.poll(angle).toBe(90);
  await page.keyboard.press('Space');
  await expect(fold).not.toHaveAttribute('open');
});

test('the chevron of a fold does not turn slowly for somebody who asked for less motion (FRU-538)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openKit(page);
  await expectStyle(page.locator('[data-kit="disclosure"] summary svg'), 'chevron', { transitionDuration: '0s' });
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
      // The edge (FRU-334): the grey of « to do » is 1.39:1 on white, the edge 3.42:1.
      boxShadow: STATUS_EDGE,
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
      edge: getComputedStyle(span).boxShadow,
      width: span.getBoundingClientRect().width,
    })),
  );
  expect.soft(segments.map((segment) => segment.colour)).toEqual(STATUS_COLOURS);
  expect.soft(new Set(segments.map((segment) => segment.edge))).toEqual(new Set([`${STATUS_EDGE} inset`]));
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

  await page.goto(`${KIT}/kit/entry`);
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

test("the steps, a callout, the option cards and the drawn browser are the mockup's (FRU-232)", async ({ page }) => {
  await openKit(page);
  const steps = page.locator('[data-kit="steps"]');
  await expect(steps.locator('ol > li')).toHaveCount(3);
  const step = (name: string) => steps.locator('li', { hasText: name });
  const mark = { width: '26px', height: '26px', borderTopLeftRadius: '50%', borderBottomLeftRadius: '0px' };

  // Done: the green drop with a check. Current: ink, its number in white. To come: a white drop.
  await expectStyle(step('Your account').locator('.kit-step__mark'), 'mark, done', { ...mark, backgroundColor: DONE });
  await expectStyle(step('Your account').locator('.kit-step__mark svg'), 'check', { width: '13px', height: '13px' });
  await expectStyle(step('Your site').locator('.kit-step__mark'), 'mark, current', {
    ...mark,
    backgroundColor: INK,
    color: WHITE,
    fontSize: '12px',
    fontWeight: '700',
  });
  await expectStyle(step('Put it on the site').locator('.kit-step__mark'), 'mark, to come', {
    ...mark,
    backgroundColor: WHITE,
    // 1.5 px in the CSS, as on the mockup. Chromium draws a border on whole device pixels: 1 px here.
    borderTopWidth: '1px',
    borderTopColor: CONTROL,
    color: MUTED_TONE,
  });
  await expectStyle(step('Your account'), 'step', { columnGap: '16px', gridTemplateColumns: '32px 352px' });
  await expectStyle(step('Your account').locator('.kit-step__line'), 'line', { width: '2px', backgroundColor: LINE });
  await expectStyle(step('Your account').locator('.kit-step__body'), 'body', { paddingBottom: '32px' });
  await expectStyle(step('Your site').getByRole('heading'), 'title', {
    fontSize: '17px',
    lineHeight: '26px',
    fontWeight: '600',
    color: INK,
  });
  await expectStyle(step('Put it on the site').getByRole('heading'), 'title, to come', { color: MUTED_TONE });
  // The last step has no line under it, and no space for one.
  await expect(step('Put it on the site').locator('.kit-step__line')).toBeHidden();
  await expectStyle(step('Put it on the site').locator('.kit-step__body'), 'body, last', { paddingBottom: '0px' });
  // The current step is said as such, and the words that say so are not drawn.
  await expect(steps.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
  await expect(step('Your site')).toHaveAttribute('aria-current', 'step');
  await expect(steps.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  // « Rename » keeps the height of its line (22.5 px), and its target is 33 px high.
  const line = await step('Your account').locator('p').boundingBox();
  expect.soft(line!.height, 'the line of « Rename »').toBeCloseTo(22.5, 0);
  expect.soft((await steps.getByRole('button', { name: 'Rename' }).boundingBox())!.height).toBeGreaterThanOrEqual(24);

  await expectStyle(steps.getByRole('status'), 'callout', {
    paddingTop: '18px',
    paddingLeft: '20px',
    borderTopColor: LINE,
    borderTopLeftRadius: '10px',
    backgroundColor: SUBTLE,
    rowGap: '10px',
  });

  const options = page.locator('[data-kit="options"]');
  await expectStyle(options.locator('.kit-option').first(), 'option', {
    paddingTop: '18px',
    borderTopColor: LINE,
    borderTopLeftRadius: '10px',
    rowGap: '8px',
  });
  await expectStyle(options.getByRole('heading', { name: 'Browser extension' }), 'option, title', {
    fontSize: '15px',
    fontWeight: '600',
  });
  // Two cards of 230 px at the least in 520 px, 12 px apart; two buttons 10 px apart.
  expect.soft((await options.locator('.kit-option').first().boundingBox())!.width).toBe(254);
  await expectStyle(options.locator('.kit-auto-grid').last(), 'grid of buttons', { columnGap: '10px' });
  const snippet = options.getByRole('region', { name: 'The script tag of staging.acme.dev' });
  await expectStyle(snippet, 'snippet', {
    fontSize: '12px',
    // 1.55 of 12 px.
    lineHeight: '18.6px',
    backgroundColor: SUBTLE,
    borderTopColor: LINE,
    borderTopLeftRadius: '6px',
    paddingLeft: '12px',
    overflowX: 'auto',
  });
  await expect(snippet).toHaveAttribute('tabindex', '0');

  const browser = page.locator('[data-kit="browser"]');
  await expectStyle(browser.locator('.kit-browser'), 'browser', {
    borderTopColor: LINE,
    borderTopLeftRadius: '14px',
    boxShadow: 'rgba(24, 24, 27, 0.08) 0px 10px 30px 0px',
  });
  // 44 px and the rule under it.
  await expectStyle(browser.locator('.kit-browser__bar'), 'bar', { height: '45px', backgroundColor: SUBTLE });
  await expectStyle(browser.locator('.kit-browser__page'), 'page', { height: '620px' });
  await expectStyle(browser.locator('.kit-browser__empty svg'), 'drop', { width: '56px', height: '68px', fill: LINE });
  await expectStyle(browser.getByText('your site', { exact: true }), 'address', {
    fontSize: '13px',
    color: MUTED_TONE,
    borderTopLeftRadius: '999px',
  });
  await expectStyle(browser.locator('.kit-browser__caption'), 'caption', {
    fontSize: '13px',
    color: MUTED_TONE,
    marginTop: '12px',
  });
  // One step under the other at 390 px, and the cards too: nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
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

test('a list of a status, a button with a longer name and a named panel (FRU-232)', async ({ page }) => {
  await openKit(page);

  // The list of « Status of the pins »: 38 px, the drop 12 px in, the word 30 px in.
  const row = page.locator('[data-kit="status-choice"]');
  const list = row.getByRole('button', { name: /Status for In Review/ });
  await expectStyle(list, 'list of a status', {
    height: '38px',
    borderTopColor: CONTROL,
    borderTopLeftRadius: '8px',
    fontSize: '14px',
  });
  const drop = list.locator('.kit-drop');
  await expectStyle(drop, 'drop', { width: '9px', height: '9px', backgroundColor: STATUS_COLOURS[2] });
  await expect(drop).toHaveAttribute('aria-hidden', 'true');
  const edges = await list.evaluate((element) => {
    const left = element.getBoundingClientRect().left;
    const dropBox = element.querySelector('.kit-drop')!.getBoundingClientRect();
    const word = element.querySelector('.select__value')!.getBoundingClientRect();
    return { drop: dropBox.left - left, word: word.left - left };
  });
  // The border is inside the 12 px of the mockup, whose box is `border-box` too.
  expect.soft(Math.round(edges.drop), 'drop, from the left edge').toBe(12);
  expect.soft(Math.round(edges.word), 'word, from the left edge').toBe(30);

  // The drop follows what is chosen, and the keyboard still walks the list.
  await list.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'To do' }).click();
  await expect(list).toContainText('To do');
  await expectStyle(list.locator('.kit-drop'), 'drop, after', { backgroundColor: STATUS_COLOURS[1] });

  // A name longer than the word shown, which starts with that word.
  const connect = page.locator('[data-kit="fields"]').getByRole('button', { name: 'Connect Jira', exact: true });
  await expect(connect).toHaveText('Connect');

  // The panel takes an id of its own and a name that is not its title.
  const panel = page.getByRole('complementary', { name: 'Settings of Linear', exact: true });
  await expect(panel).toHaveAttribute('id', 'kit-panel');
  await expect(panel).not.toHaveAttribute('aria-labelledby');
  await expect(panel.getByRole('heading', { name: 'Linear' })).toHaveAttribute('id', 'kit-panel-title');

  // A link in a row takes the line of the table: 20.3 px and its 8 px each way, the 36.3 px of the mockup.
  const link = page.getByRole('region', { name: 'Members' }).getByRole('button', { name: 'Resend' });
  await expectStyle(link, 'link in a row', { lineHeight: '20.3px', paddingTop: '8px' });
  expect.soft((await link.boundingBox())?.height, 'link in a row, height').toBeCloseTo(36.3, 1);
});

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
