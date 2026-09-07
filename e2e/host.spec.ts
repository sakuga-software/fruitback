import { expect, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * The Shadow DOM host (SKG-492), in a browser that has a real selector engine, a real cascade and
 * real hit testing — the three things the unit tests replace with a fake because happy-dom has none
 * of them.
 */

/** What a client's stylesheet looks like when nobody wrote it with a widget in mind. */
const HOSTILE_CSS = `
  button { width: 100% !important; background: lime !important; font-size: 40px !important;
           border: 6px dotted blue !important; }
  div { outline: 4px solid magenta !important; }
  * { font-family: Papyrus !important; }
`;

test('the page cannot restyle the widget, however hard it tries', async ({ page }) => {
  await openPlayground(page, 'isolation');
  await page.addStyleTag({ content: HOSTILE_CSS });

  const launch = page.getByRole('button', { name: /Laisser un feedback/ });
  const styles = await launch.evaluate((node) => {
    const computed = getComputedStyle(node);

    return {
      background: computed.backgroundColor,
      fontSize: computed.fontSize,
      borderStyle: computed.borderStyle,
      fontFamily: computed.fontFamily,
    };
  });

  // A `!important` in the page's own sheet cannot select through a Shadow boundary…
  expect(styles.background).not.toBe('rgb(0, 255, 0)');
  expect(styles.fontSize).toBe('13px');
  expect(styles.borderStyle).toBe('none');
  // …and `font-family` is the one that would have got through by inheritance, which is what
  // `all: initial` on the host is for.
  expect(styles.fontFamily).not.toContain('Papyrus');
});

test('the icons are actually drawn, not empty boxes (SKG-529)', async ({ page }) => {
  // The one failure this ticket could ship silently. The host reset is `all: initial`, and since
  // SVG2 a path's own geometry is a CSS property — so a bare star selector computes `d: none` and
  // `stroke: none`, every icon renders as nothing, and neither the console nor a unit test says a
  // word. happy-dom draws nothing at all, so this is the only place the pixels can be checked.
  //
  // Measured before the fix: `d` came back as the string "none" under `* { all: initial }`.
  await openPlayground(page, 'icons');

  const drawn = await page.getByRole('button', { name: /Laisser un feedback/ }).evaluate((node) => {
    const path = node.querySelector('svg path');
    if (path === null) return null;

    const box = path.getBoundingClientRect();

    return {
      d: getComputedStyle(path).d,
      fill: getComputedStyle(path).fill,
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });

  expect(drawn).not.toBeNull();
  expect(drawn?.d).not.toBe('none');
  // Filled with the button's own colour rather than the browser's default black.
  expect(drawn?.fill).not.toBe('rgb(0, 0, 0)');
  // Roughly the 13px text beside it, which is what sizing in `em` buys.
  expect(drawn?.width).toBeGreaterThan(6);
  expect(drawn?.height).toBeGreaterThan(6);
});

test('no emoji survives anywhere in the widget chrome (SKG-529)', async ({ page }) => {
  // The unit guard reads this package's sources. This one reads what a visitor actually sees — and
  // it therefore has to *reach* each state, which is the whole reason it drives the widget rather
  // than opening one panel. The first version only opened the settings panel and claimed to cover
  // the composer, whose strings are written on `setState` and are the empty string while idle: a
  // planted emoji in `MESSAGES` would have gone straight past it. Raised in review.
  await openPlayground(page, 'no-emoji');

  // Read after each state rather than once at the end: a popover that has closed again leaves
  // nothing behind to read.
  const chrome = () =>
    page.evaluate(() => document.querySelector('[data-fruitback-host]')?.shadowRoot?.textContent ?? '');
  const seen = [await chrome()];

  await page.locator('[data-fruitback-host-configure]').click();
  await expect(page.getByRole('dialog', { name: 'Réglages Fruitback' })).toBeVisible();
  seen.push(await chrome());
  await page.locator('.fruitback-config-close').click();

  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('#email-field').click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Une note sur un champ qui disparaît');
  seen.push(await chrome());

  await page.getByRole('button', { name: 'Planter' }).click();
  // Polled, and the polled value is the value kept. The confirmation clears itself 1.1s after it
  // appears, so waiting for it and *then* reading the root again is two round trips with a deadline
  // between them: on a loaded machine the second one finds a closed popover, and the presence marker
  // below fails on a widget that behaved perfectly. Same rule as the computed-colour poll further
  // down this file — assert on what you measured, not on a second measurement. Raised in review,
  // twice: the first version of this comment sent the reader to `overlay.spec.ts`, which has no
  // poll in it at all.
  let harvested = '';
  await expect.poll(async () => (harvested = await chrome())).toMatch(/récolté/);
  seen.push(harvested);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The detached drawer, which needs an element to have gone.
  await page.evaluate(() => document.querySelector('#email-field')?.remove());
  const drawer = page.locator('[data-fruitback-orphans]');
  await expect(drawer).toBeVisible();
  await drawer.locator('.fruitback-orphans-toggle').click();
  seen.push(await chrome());

  const text = seen.join('\n');
  // Proof that the emoji check below is checking something. `textContent` on a Shadow root includes
  // the CSS of every <style> in it, so asserting the text is non-empty passes before a single piece
  // of chrome has rendered — which is what the first version of this test did. Raised in review.
  for (const rendered of ['Laisser un feedback', 'Réglages', 'récolté', 'note détachée']) {
    expect(text, `never reached the state that renders ${rendered}`).toContain(rendered);
  }

  expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u);
});

test('the widget does not print its own stylesheets onto the page', async ({ page }) => {
  // `all: initial` in the Shadow root undoes the browser's `display: none` on <style>, and the CSS
  // text lands in the corner of the client's page. It looked exactly as bad as it sounds.
  await openPlayground(page, 'no-visible-css');

  const leaked = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
    if (!root) return 'no shadow root';

    return [...root.querySelectorAll('style')]
      .map((node) => getComputedStyle(node).display)
      .filter((display) => display !== 'none');
  });

  expect(leaked).toEqual([]);
});

test('the widget cannot restyle the page either', async ({ page }) => {
  await openPlayground(page, 'no-leak');
  const cta = page.locator('#checkout-cta');
  const before = await cta.evaluate((node) => getComputedStyle(node).backgroundColor);

  // Plant a pin, so every stylesheet the widget owns is mounted and the overlay is live.
  await plantPin(page, cta, 'Le CTA devrait être plus large');

  // Both readings have to be taken in the same interaction state, and planting left the pointer on
  // the button. Moving off starts HeroUI's colour transition back to rest, and a computed style read
  // mid-transition is the interpolated value — serialized as `oklab(…)` where the resting
  // declaration serializes as `oklch(…)`. So this polls for the return instead of reading once: the
  // claim is that the colour comes back to exactly what it was, not that it never moved while the
  // design system was animating its own button.
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => cta.evaluate((node) => getComputedStyle(node).backgroundColor))
    .toBe(before);
  // Nothing the widget draws is in the page's own tree — the dev toolbar is the playground's, and
  // deliberately outside the Shadow root, so it is excluded from the count rather than from the rule.
  const strays = await page.evaluate(() => {
    const OURS =
      '.fruitback-launch, .fruitback-highlight, .fruitback-pin, .fruitback-thread, [data-fruitback-pin]';

    return [...document.querySelectorAll(OURS)]
      .filter((node) => node.closest('[data-fruitback-dev]') === null)
      .map((node) => node.className);
  });
  expect(strays).toEqual([]);
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
});

test('hovering highlights the element the pointer is really over', async ({ page }) => {
  // react-grab's hit testing, for real: it has to see past our own highlight box and the overlay.
  await openPlayground(page, 'hover');
  const button = page.locator('[data-testid="card-latte"] .add');
  const highlight = page.locator('[data-fruitback-host-highlight]');

  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await button.hover();

  await expect
    .poll(async () => {
      const [box, target] = await Promise.all([highlight.boundingBox(), button.boundingBox()]);
      if (box === null || target === null) return null;

      return Math.max(Math.abs(box.x - target.x), Math.abs(box.y - target.y));
    })
    .toBeLessThanOrEqual(1);

  // Escape leaves the mode without capturing anything.
  await page.keyboard.press('Escape');
  await expect(highlight).toBeHidden();
});

test('a click while capturing goes to the widget, not to the site', async ({ page }) => {
  await openPlayground(page, 'intercept');
  // The page's own handler would fire on a normal click; while capturing it must not.
  await page.evaluate(() => {
    (window as unknown as { clicked: boolean }).clicked = false;
    document
      .querySelector('#checkout-cta')
      ?.addEventListener('click', () => ((window as unknown as { clicked: boolean }).clicked = true));
  });

  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('#checkout-cta').click();

  expect(await page.evaluate(() => (window as unknown as { clicked: boolean }).clicked)).toBe(false);
  // And the composer opened on that target instead.
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toBeVisible();
});

test('the dev chrome keeps working while capturing, and is never itself captured', async ({ page }) => {
  // `ignore` is the host's answer to a page that mounts its own chrome around the widget. Note what
  // it does *not* promise: react-grab walks past a rejected candidate, so hovering the toolbar
  // highlights whatever sits behind it. Harmless. Capturing the toolbar would not be.
  await openPlayground(page, 'ignore-chrome');
  await page.getByRole('button', { name: /Laisser un feedback/ }).click();

  await page.locator('[data-fruitback-dev="redeploy"]').click();

  // The button did its job — the redeploy ran — and no composer opened on it.
  await expect(page.locator('[data-fruitback-inserted]')).toHaveCount(1);
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toBeHidden();
});

test('the pins live in the Shadow root now, and still land on their elements', async ({ page }) => {
  await openPlayground(page, 'pins-in-shadow');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Toujours au bon endroit');

  // Not reachable from the page's own DOM — only through the Shadow root.
  expect(await page.evaluate(() => document.querySelectorAll('[data-fruitback-pin]').length)).toBe(0);
  expect(
    await page.evaluate(
      () => {
        const host = document.querySelector('[data-fruitback-host]');

        return host?.shadowRoot?.querySelectorAll('[data-fruitback-pin]').length;
      },
    ),
  ).toBe(1);
});

test('a note, its byline and its warning are three lines, not one paragraph', async ({ page }) => {
  // `all: initial` resets `display` too, so every block element in the Shadow root is inline until
  // the stylesheet says otherwise — and the note ran into its own byline. The margins were there and
  // did nothing. Asserted on layout rather than on the rule, because the rule is not the promise.
  await openPlayground(page, 'thread-layout');
  const button = page.locator('[data-testid="card-latte"] .add');

  await plantPin(page, button, 'Une note assez longue pour se voir');
  await badgeFor(page, 'Une note assez').click();

  const lines = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
    const rect = (selector: string) => root?.querySelector(selector)?.getBoundingClientRect();
    const note = rect('.fruitback-thread-note');
    const meta = rect('.fruitback-thread-meta');

    return note === undefined || meta === undefined ? null : { noteBottom: note.bottom, metaTop: meta.top };
  });

  expect(lines, 'the thread should show a note and a byline').not.toBeNull();
  expect(lines!.metaTop, 'the byline starts below the note, not beside it').toBeGreaterThanOrEqual(lines!.noteBottom);
});
