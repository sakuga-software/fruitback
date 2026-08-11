import { expect, test } from '@playwright/test';
import { openPlayground, plantPin } from './pin.ts';

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

  expect(await cta.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(before);
  // Nothing the widget draws is in the page's own tree — the dev toolbar is the playground's, and
  // deliberately outside the Shadow root, so it is excluded from the count rather than from the rule.
  const strays = await page.evaluate(() =>
    [...document.querySelectorAll('.fb-launch, .fb-highlight, .fb-pin, .fb-thread, [data-fb-pin]')]
      .filter((node) => node.closest('[data-fb-dev]') === null)
      .map((node) => node.className),
  );
  expect(strays).toEqual([]);
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
});

test('hovering highlights the element the pointer is really over', async ({ page }) => {
  // react-grab's hit testing, for real: it has to see past our own highlight box and the overlay.
  await openPlayground(page, 'hover');
  const button = page.locator('[data-testid="card-latte"] .add');
  const highlight = page.locator('[data-fb-host-highlight]');

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

  await page.locator('[data-fb-dev="redeploy"]').click();

  // The button did its job — the redeploy ran — and no composer opened on it.
  await expect(page.locator('[data-fb-inserted]')).toHaveCount(1);
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toBeHidden();
});

test('the pins live in the Shadow root now, and still land on their elements', async ({ page }) => {
  await openPlayground(page, 'pins-in-shadow');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Toujours au bon endroit');

  // Not reachable from the page's own DOM — only through the Shadow root.
  expect(await page.evaluate(() => document.querySelectorAll('[data-fb-pin]').length)).toBe(0);
  expect(
    await page.evaluate(
      () => document.querySelector('[data-fruitback-host]')?.shadowRoot?.querySelectorAll('[data-fb-pin]').length,
    ),
  ).toBe(1);
});
