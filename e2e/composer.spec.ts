import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN, openPlayground } from './pin.ts';

/**
 * The popover (FRU-4) in a browser: the two things that only exist there — a media query deciding
 * whether it is a popover or a sheet, and an animation that has to stop when the reader asked for
 * less motion.
 */

async function selectTheCta(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('#checkout-cta').click();
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();
}

test('a note goes from sending to sent, and the pin lands', async ({ page }) => {
  await openPlayground(page, 'composer-happy');
  await selectTheCta(page);

  await page.getByPlaceholder('What should change?').fill('Le CTA devrait être plus large');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The product's own word for it, in the status the composer announces.
  await expect(page.locator('[data-fruitback-composer]')).toContainText(/\bSent\b/);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  // And it closes itself once the confirmation has been read.
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 5_000 });
});

test('a failed send keeps the note and stays open', async ({ page }) => {
  // The one failure this widget cannot afford. The worker is made to refuse for this test only.
  await openPlayground(page, 'composer-failure');
  await page.route('**/feedback', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"store-unavailable"}' })
      : route.fallback(),
  );
  await selectTheCta(page);

  const note = 'Une remarque qui a pris du temps à écrire';
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.locator('[data-fruitback-composer]')).toContainText(/Did not go through/);
  await expect(page.locator('[data-fruitback-composer]')).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);
  // Retrying is one click, not one more typing session.
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('on a phone it is a sheet at the bottom, not a popover beside the element', async ({ page }) => {
  // A 320px popover anchored to an element is unusable at that width.
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlayground(page, 'composer-mobile');
  await selectTheCta(page);

  const viewport = page.viewportSize();
  const measure = () =>
    page.locator('[data-fruitback-composer]').evaluate((node) => {
      // Viewport coordinates, not `boundingBox()`: the sheet is `position: fixed` and the page has
      // been scrolled to reach the element, so a document-relative measurement would carry the
      // scroll offset with it.
      const rect = node.getBoundingClientRect();

      return { left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
    });

  // Polled, because `toBeVisible()` resolves the moment the sheet appears — which is while it is
  // still sliding up from below the fold, translated by its own height.
  await expect.poll(async () => (await measure()).bottom).toBe(viewport?.height);

  const box = await measure();
  expect(box.left).toBeLessThanOrEqual(1);
  expect(box.right).toBe(viewport?.width);
});

test('it stays inside the viewport when the element is against the right edge', async ({ page }) => {
  // The popover is clamped against its declared width, so the rendered box has to match it — with
  // content-box the padding sat outside and the popover overhung the edge by that much.
  await openPlayground(page, 'composer-edge');
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('main header button').click();
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();

  const viewport = page.viewportSize();
  await expect
    .poll(async () =>
      page.locator('[data-fruitback-composer]').evaluate((node) => Math.round(node.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(viewport?.width ?? 0);
});

test('it honours a reader who asked for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'composer-reduced-motion');
  await selectTheCta(page);

  const animation = await page
    .locator('[data-fruitback-composer]')
    .evaluate((node) => getComputedStyle(node).animationName);

  expect(animation).toBe('none');
});

test('the pin is a drop, and it says what it is to a screen reader', async ({ page }) => {
  await openPlayground(page, 'composer-pin-shape');
  await selectTheCta(page);
  await page.getByPlaceholder('What should change?').fill('Un pin en goutte');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  const badge = page.locator('.fruitback-pin-badge');
  const shape = await badge.evaluate((node) => {
    const style = getComputedStyle(node);

    return { radius: style.borderRadius, transform: style.transform };
  });

  // Three round corners and one sharp, turned to point at the element.
  expect(shape.radius).toMatch(/50%/);
  expect(shape.transform).not.toBe('none');
  // The note lives in the accessible name now that the badge carries an emoji.
  await expect(badge).toHaveAttribute('aria-label', /Un pin en goutte/);
});

test('the composer has the measures of the mock-up, above its element (FRU-258)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'composer-measures');
  // The button at the foot of the page: the window has room above it, whatever the fonts measure.
  const button = page.locator('#checkout-cta');
  await button.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await button.click();
  const composer = page.getByRole('dialog', { name: 'New note', exact: true });
  await expect(composer).toBeVisible();
  const read = (selector: string, properties: string[]) =>
    page.locator(selector).evaluate((element, names) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();

      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
      } as Record<string, string | number>;
    }, properties);

  const box = await read('[data-fruitback-composer]', [
    'border-radius',
    'background-color',
    'font-size',
    'line-height',
  ]);
  expect(box).toMatchObject({
    width: 360,
    'border-radius': '14px',
    'background-color': 'rgb(255, 255, 255)',
    'font-size': '14px',
    'line-height': '21px',
  });
  expect(await page.locator('[data-fruitback-composer]').evaluate((node) => getComputedStyle(node).boxShadow)).toBe(
    'rgba(28, 25, 23, 0.22) 0px 14px 40px 0px',
  );
  // Above the element: it ends 40 px over its top, on the edge of the frame, 6 px off the element.
  const target = (await button.boundingBox())!;
  expect(Number(box.y) + Number(box.height)).toBeCloseTo(target.y - 40, 0);
  expect(Number(box.x)).toBeCloseTo(target.x - 6, 0);
  // The frame stays on the element the note is about, with the name of its component.
  await expect(page.locator('[data-fruitback-host-highlight]')).toBeVisible();
  await expect(page.locator('.fruitback-highlight-tag')).toHaveText('Button');
  // The capture is over: one click, one note.
  await expect(page.locator('[data-fruitback-host-launch]')).toHaveAttribute('aria-pressed', 'false');

  expect(await read('.fruitback-composer-head', ['padding', 'gap'])).toMatchObject({
    height: 48,
    padding: '8px 8px 8px 16px',
    gap: '10px',
  });
  await expect(page.locator('.fruitback-composer-title')).toHaveText('New note');
  expect(await read('.fruitback-composer-title', ['font-size', 'font-weight'])).toMatchObject({
    'font-size': '13px',
    'font-weight': '600',
  });
  // What the element says, on one line.
  await expect(page.locator('.fruitback-composer-about')).toHaveText('on Commander');
  expect(await read('.fruitback-composer-about', ['font-size', 'color', 'white-space', 'text-overflow'])).toMatchObject(
    {
      'font-size': '12px',
      color: 'rgb(117, 110, 105)',
      'white-space': 'nowrap',
      'text-overflow': 'ellipsis',
    },
  );
  const cross = page.getByRole('button', { name: 'Close without sending' });
  expect(await read('.fruitback-composer-close', ['border-radius', 'color'])).toMatchObject({
    width: 32,
    height: 32,
    'border-radius': '8px',
    color: 'rgb(117, 110, 105)',
  });
  expect(await read('.fruitback-composer-body', ['padding'])).toMatchObject({ padding: '0px 16px 12px' });
  expect(
    await read('[data-fruitback-note]', ['border-top-width', 'border-top-color', 'border-radius', 'padding', 'resize']),
  ).toMatchObject({
    // Three lines of 21 px, 9 px above and under, and the border.
    height: 83,
    width: 328,
    'border-top-width': '1px',
    'border-top-color': 'rgb(143, 136, 131)',
    'border-radius': '8px',
    padding: '9px 12px',
    resize: 'vertical',
  });
  expect(
    await read('.fruitback-composer-foot', ['padding', 'gap', 'border-top-width', 'border-top-color']),
  ).toMatchObject({
    padding: '10px 12px 12px 16px',
    gap: '8px',
    'border-top-width': '1px',
    'border-top-color': 'rgb(231, 229, 228)',
  });
  expect(
    await read('[data-fruitback-cancel]', ['padding', 'border-radius', 'color', 'font-size', 'font-weight']),
  ).toMatchObject({
    height: 36,
    padding: '0px 12px',
    'border-radius': '999px',
    color: 'rgb(117, 110, 105)',
    'font-size': '13px',
    'font-weight': '600',
  });
  expect(await read('[data-fruitback-send]', ['padding', 'border-radius', 'background-color', 'color'])).toMatchObject({
    height: 36,
    padding: '0px 18px',
    'border-radius': '999px',
    'background-color': 'rgb(221, 44, 39)',
    color: 'rgb(255, 255, 255)',
  });
  // A visitor with no account: no sentence « As … », and the name stays an offer.
  await expect(composer).not.toContainText(/\bAs /);
  await expect(page.getByRole('button', { name: 'Add my name (optional)' })).toBeVisible();

  // Under the pointer: the strong accent for Send, the sunken surface for Cancel and for the cross.
  await page.locator('[data-fruitback-send]').hover();
  expect(await read('[data-fruitback-send]', ['background-color'])).toMatchObject({
    'background-color': 'rgb(185, 28, 28)',
  });
  await page.locator('[data-fruitback-cancel]').hover();
  expect(await read('[data-fruitback-cancel]', ['background-color'])).toMatchObject({
    'background-color': 'rgb(245, 245, 244)',
  });
  await cross.hover();
  expect(await read('.fruitback-composer-close', ['background-color'])).toMatchObject({
    'background-color': 'rgb(245, 245, 244)',
  });

  // The cross closes without sending, and the frame goes with the composer.
  await cross.click();
  await expect(composer).toBeHidden();
  await expect(page.locator('[data-fruitback-host-highlight]')).toBeHidden();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
});

test('it rises from the corner nearest to its element, with no fade', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPlayground(page, 'composer-rise');
  await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('#checkout-cta').click();
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();

  const motion = await page.locator('[data-fruitback-composer]').evaluate((node) => {
    const style = getComputedStyle(node);

    return {
      name: style.animationName,
      duration: style.animationDuration,
      curve: style.animationTimingFunction,
      origin: style.transformOrigin,
      // Its own height, not the one on screen: it is still growing from 96 %.
      height: (node as HTMLElement).offsetHeight,
    };
  });
  expect(motion).toMatchObject({
    name: 'fruitback-composer-in',
    duration: '0.42s',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
  });
  // « bottom left », in the pixels of its own box.
  const [x, y] = motion.origin.split(' ').map((part) => Number.parseFloat(part));
  expect(x).toBe(0);
  expect(Math.abs((y ?? 0) - motion.height)).toBeLessThanOrEqual(1);
});

test('a second capture while a note is on its way loses nothing, and the failure still says why', async ({ page }) => {
  // The launch button is in reach of the pointer under the composer. A choice made while the note
  // is sending is let go: the note in flight is about the element chosen before.
  await openPlayground(page, 'composer-second-capture');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/feedback', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"store-unavailable"}' });
  });
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const about = page.locator('.fruitback-composer-about');
  await expect(about).toHaveText('on Ajouter');
  const note = 'Written before a second capture';
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-composer]')).toHaveAttribute('data-fruitback-state', 'sending');

  await page.locator('[data-fruitback-host-launch]').click();
  // Another element, away from the composer, which stands over the card it is about.
  await page.locator('[data-testid="card-mocha"] .add').click();

  await expect(page.locator('[data-fruitback-composer]')).toHaveAttribute('data-fruitback-state', 'sending');
  await expect(about).toHaveText('on Ajouter');
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);

  release();
  await expect(page.locator('[data-fruitback-composer]')).toContainText(/Did not go through/);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);
});

/**
 * « Send » ends the row of the foot, whatever the length of the words (FRU-317). In French, « Garder
 * pour plus tard », « Annuler » and « Envoyer » do not fit on one line of the popover of 360 px:
 * « Envoyer » fell alone on a second line, at the start. On the widget as `init` mounts it, which
 * offers « Keep for later » once the worker offers a batch.
 */
for (const [locale, keep, cancel, send] of [
  ['fr-FR', 'Garder pour plus tard', 'Annuler', 'Envoyer'],
  ['en-US', 'Keep for later', 'Cancel', 'Send'],
] as const) {
  test(`in ${locale}, « ${send} » ends the row of the foot, and the ghosts never go under it (FRU-317)`, async ({
    page,
  }) => {
    await page.goto(`/?widget=off&case=composer-foot-${locale}-${test.info().retry}`);
    await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
    await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
    // « Keep for later » is offered once the first read says the worker takes a batch.
    const firstRead = page.waitForResponse(
      (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/feedback',
    );
    await page.evaluate(
      ([endpoint, tag]) =>
        (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
          endpoint: endpoint as string,
          clientId: 'playground',
          locale: tag as string,
        }),
      [WORKER_ORIGIN, locale],
    );
    await firstRead;
    await page.locator('[data-fruitback-host-launch]').click();
    await page.locator('[data-testid="card-latte"] .add').click();
    const keepButton = page.getByRole('button', { name: keep, exact: true });
    await expect(keepButton).toBeVisible();

    const box = async (name: string) => (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    const [kept, cancelled, sent] = [await box(keep), await box(cancel), await box(send)];
    const foot = (await page.locator('.fruitback-composer-foot').boundingBox())!;

    // The end of the row: the right edge of the foot, less its padding of 12 px.
    expect(Math.round(sent.x + sent.width)).toBe(Math.round(foot.x + foot.width - 12));
    // No ghost under « Send », nor to its right.
    for (const ghost of [kept, cancelled]) {
      expect(ghost.y).toBeLessThanOrEqual(sent.y + 1);
      if (Math.abs(ghost.y - sent.y) < 1) expect(ghost.x + ghost.width).toBeLessThanOrEqual(sent.x);
    }
  });
}
