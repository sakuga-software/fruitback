import { expect, test } from '@playwright/test';
import { caseOf, hydrated, openPlayground, WORKER_ORIGIN } from './pin.ts';

/**
 * The popover (FRU-4) in a browser: the two things that only exist there — a media query deciding
 * whether it is a popover or a sheet, and an animation that has to stop when the reader asked for
 * less motion.
 */

async function selectTheCta(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /Leave a note/ }).click();
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
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
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

  await expect(page.locator('[data-fruitback-composer]')).toContainText(/Not sent/);
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
  await page.getByRole('button', { name: /Leave a note/ }).click();
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

test('the composer has the measures of the mock-up, beside its element, with the tools in its field (FRU-258, FRU-305, FRU-607)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'composer-measures');
  // The button at the foot of the page: the window has room above it, whatever the fonts measure.
  const button = page.locator('#checkout-cta');
  await button.scrollIntoViewIfNeeded();
  // HeroUI scales a pressed button to 0.97: its top moves 0.54 px down during the press. The composer
  // is placed during the click, so on the pressed box. The test read the box later, pressed or not
  // depending on the timing, and failed on main at 663.53 for 663. Without the scale, there is one box.
  await button.evaluate((element) => element.style.setProperty('transform', 'none', 'important'));
  await page.getByRole('button', { name: /Leave a note/ }).click();
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
    'border-top-width',
    'border-top-color',
    'background-color',
    'font-size',
    'line-height',
  ]);
  expect(box).toMatchObject({
    width: 360,
    'border-radius': '14px',
    'border-top-width': '1px',
    'border-top-color': 'rgb(228, 228, 231)',
    'background-color': 'rgb(255, 255, 255)',
    'font-size': '14px',
    'line-height': '21px',
  });
  expect(await page.locator('[data-fruitback-composer]').evaluate((node) => getComputedStyle(node).boxShadow)).toBe(
    'rgba(24, 24, 27, 0.22) 0px 14px 40px 0px',
  );
  // Beside the element, on the right (FRU-607): 16 px off the frame, which stands 5 px off the
  // element, its top on the top of the frame unless the window ends first.
  const target = (await button.boundingBox())!;
  expect(Number(box.x)).toBeCloseTo(target.x + target.width + 5 + 16, 0);
  expect(Number(box.y)).toBeCloseTo(Math.min(target.y - 5, 900 - Number(box.height) - 10), 0);
  await expect(page.locator('[data-fruitback-composer]')).toHaveAttribute('data-fruitback-side', 'right');
  // The tether: 2 px of the accent, from the edge of the composer to the frame, at the middle of the element.
  const tether = await read('[data-fruitback-tether]', ['background-color']);
  expect(tether).toMatchObject({ width: 16, height: 2, 'background-color': 'rgb(221, 44, 39)' });
  expect(Number(tether.x) + 16).toBeCloseTo(Number(box.x), 0);
  expect(Number(tether.y) + 1).toBeCloseTo(target.y + target.height / 2, 0);
  // The frame stays on the element the note is about, named as the head names it.
  await expect(page.locator('[data-fruitback-host-highlight]')).toBeVisible();
  await expect(page.locator('.fruitback-highlight-tag')).toHaveText('Commander · <Button>');
  // The capture is over: one click, one note.
  await expect(page.locator('[data-fruitback-host-launch]')).toHaveAttribute('aria-pressed', 'false');

  // The head (FRU-305): the drop of a new note, what the element says (FRU-607), « Choose another element ».
  expect(
    await read('.fruitback-composer-head', ['padding', 'gap', 'background-color', 'border-bottom-width']),
  ).toMatchObject({
    padding: '12px 12px 12px 14px',
    gap: '8px',
    'background-color': 'rgb(250, 250, 250)',
    'border-bottom-width': '1px',
  });
  // The words of the element, not its selector: the selector waits for « Show CSS selectors ».
  await expect(page.locator('.fruitback-composer-about')).toHaveText('Commander · <Button>');
  const about = await read('.fruitback-composer-about', [
    'font-size',
    'font-weight',
    'font-family',
    'white-space',
    'text-overflow',
  ]);
  expect(about).toMatchObject({
    'font-size': '13px',
    'font-weight': '600',
    'white-space': 'nowrap',
    'text-overflow': 'ellipsis',
  });
  expect(String(about['font-family'])).not.toMatch(/monospace/);
  // The drop is turned: its own box, not the one on screen, is 10 px.
  expect(
    await page
      .locator('.fruitback-composer-drop')
      .evaluate((node) => [(node as HTMLElement).offsetWidth, getComputedStyle(node).backgroundColor]),
  ).toEqual([10, 'rgb(190, 194, 200)']);
  const pick = page.getByRole('button', { name: 'Choose another element' });
  await expect(pick).toBeVisible();
  expect(await read('.fruitback-composer-pick', ['font-size', 'font-weight', 'color', 'padding'])).toMatchObject({
    // 44 px to press: a chip of 26 px inside a transparent border of 9 px.
    height: 44,
    'font-size': '12px',
    'font-weight': '600',
    color: 'rgb(107, 107, 116)',
    padding: '4px 6px',
  });
  // No cross: « Cancel » and Escape close it.
  await expect(page.getByRole('button', { name: 'Close without sending' })).toHaveCount(0);

  expect(await read('.fruitback-composer-body', ['padding', 'gap'])).toMatchObject({ padding: '14px', gap: '12px' });
  // « Your note » names the field for a screen reader; the eye reads the placeholder.
  await expect(page.getByRole('textbox', { name: 'Your note' })).toBeVisible();
  // The field (FRU-607): one box with the edge, the note in it with none, then the row of icons.
  const field = await read('[data-fruitback-box]', ['border-top-width', 'border-top-color', 'border-top-left-radius']);
  expect(field).toMatchObject({
    width: 330,
    'border-top-width': '1px',
    'border-top-color': 'rgb(138, 138, 147)',
    'border-top-left-radius': '6px',
  });
  const note = await read('[data-fruitback-note]', ['border-top-width', 'padding', 'resize']);
  // It grows with its text instead of a handle to drag (FRU-611, P7).
  expect(note).toMatchObject({ width: 328, 'border-top-width': '0px', padding: '10px 12px', resize: 'none' });
  expect(Number(note.height)).toBeGreaterThanOrEqual(96);
  const tools = await read('[data-fruitback-tools]', []);
  expect(Number(tools.y)).toBeGreaterThanOrEqual(Number(note.y) + Number(note.height) - 1);
  expect(Number(tools.y) + Number(tools.height)).toBeLessThanOrEqual(Number(field.y) + Number(field.height));
  // The signature, at the end of the field: « Guest », in dashes.
  const avatar = page.getByRole('button', { name: 'Signed as Guest. Add your name' });
  await expect(avatar).toHaveText('Guest');
  expect(await read('[data-fruitback-avatar]', ['border-top-style'])).toMatchObject({
    'border-top-style': 'dashed',
    height: 28,
  });
  // A click opens « Name » (FRU-609): a field of 36 px, in 13 px.
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).toBeHidden();
  await avatar.click();
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
  expect(await name.evaluate((node) => [node.getBoundingClientRect().height, getComputedStyle(node).fontSize])).toEqual(
    [36, '13px'],
  );
  await name.fill('Camille Durand');
  await expect(page.getByRole('button', { name: 'Signed as Camille Durand. Change the name' })).toHaveText('CD');

  expect(
    await read('.fruitback-composer-foot', ['padding', 'gap', 'border-top-width', 'border-top-color']),
  ).toMatchObject({
    padding: '10px 12px 12px 14px',
    gap: '8px',
    'border-top-width': '1px',
    'border-top-color': 'rgb(228, 228, 231)',
  });
  // Where the note lands: the playground offers no place, so « Sent to the team ».
  await expect(page.locator('[data-fruitback-lands]')).toHaveText('Sent to the team');
  expect(await read('[data-fruitback-lands]', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  // 34 px drawn, as the mock-up, in a target of 44 px.
  expect(
    await read('[data-fruitback-cancel]', ['padding', 'border-top-width', 'color', 'font-size', 'font-weight']),
  ).toMatchObject({
    height: 44,
    padding: '0px 12px',
    'border-top-width': '5px',
    color: 'rgb(107, 107, 116)',
    'font-size': '13px',
    'font-weight': '600',
  });
  expect(
    await read('[data-fruitback-send]', [
      'padding-left',
      'padding-right',
      'border-top-width',
      'background-color',
      'color',
    ]),
  ).toMatchObject({
    height: 44,
    'padding-left': '12px',
    'padding-right': '14px',
    'border-top-width': '5px',
    'background-color': 'rgb(221, 44, 39)',
    color: 'rgb(255, 255, 255)',
  });
  await expect(page.locator('[data-fruitback-send] svg')).toHaveCount(1);
  // A visitor with no account: no sentence « As … ».
  await expect(composer).not.toContainText(/\bAs /);

  // Under the pointer: the strong accent for Send, the sunken surface for Cancel.
  await page.locator('[data-fruitback-send]').hover();
  expect(await read('[data-fruitback-send]', ['background-color'])).toMatchObject({
    'background-color': 'rgb(185, 28, 28)',
  });
  await page.locator('[data-fruitback-cancel]').hover();
  expect(await read('[data-fruitback-cancel]', ['background-color'])).toMatchObject({
    'background-color': 'rgb(244, 244, 245)',
  });

  // « Cancel » closes without sending, and the frame goes with the composer.
  await page.locator('[data-fruitback-cancel]').click();
  await expect(composer).toBeHidden();
  await expect(page.locator('[data-fruitback-host-highlight]')).toBeHidden();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
});

test('« Choose another element » keeps the text and moves the composer to the element chosen (FRU-305)', async ({
  page,
}) => {
  await openPlayground(page, 'composer-pick-again');
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const field = page.getByPlaceholder('What should change?');
  await field.fill('Written before picking again');
  await page.getByRole('button', { name: 'Choose another element' }).click();
  // The espresso card: the composer stands beside the latte card, over the mocha one (FRU-607).
  await page.locator('[data-testid="card-espresso"] .add').click();
  await expect(page.locator('.fruitback-composer-about')).toHaveText(/^Ajouter · <Button>$/);
  await expect(field).toHaveValue('Written before picking again');
});

test('a sent note says « Sent as » its identifier, with the number of its pin and « Open → » (FRU-305)', async ({
  page,
}) => {
  // The widget as `init` assembles it: it reads the note back and finds its identifier and its pin.
  await page.goto(`/?widget=off&case=${caseOf('composer-sent-as')}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('A note to see its card');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.locator('[data-fruitback-sent]');
  await expect(card).toBeVisible();
  await expect(page.locator('[data-fruitback-sent-title]')).toHaveText(/^Sent as \S+$/);
  await expect(page.locator('[data-fruitback-sent-text]')).toHaveText(
    'The pin stays here and follows the issue’s status.',
  );
  expect(await page.locator('[data-fruitback-sent-text]').evaluate((node) => getComputedStyle(node).color)).toBe(
    'rgb(21, 128, 61)',
  );
  await expect(page.locator('[data-fruitback-sent-drop]')).toHaveText('1');
  await expect(page.locator('[data-fruitback-sent-open]')).toHaveText('Open →');
  // A click on the page closes it at once.
  await page.locator('main h2, main h1').first().click();
  await expect(card).toBeHidden();
});

test('it rises from the corner nearest to its element, with no fade', async ({ page }) => {
  // Beside the element (FRU-607): it comes from its side, and grows from its top corner there.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPlayground(page, 'composer-rise');
  await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /Leave a note/ }).click();
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
    name: 'fruitback-composer-from-left',
    duration: '0.42s',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
  });
  // « top left », in the pixels of its own box: the corner on the side of the element.
  const [x, y] = motion.origin.split(' ').map((part) => Number.parseFloat(part));
  expect(x).toBe(0);
  expect(y).toBe(0);
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
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const about = page.locator('.fruitback-composer-about');
  await expect(about).toHaveText(/^Ajouter · <Button>$/);
  const note = 'Written before a second capture';
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-composer]')).toHaveAttribute('data-fruitback-state', 'sending');

  await page.locator('[data-fruitback-host-launch]').click();
  // Another element, away from the composer, which stands beside the card it is about, over the
  // mocha card (FRU-607).
  await page.locator('[data-testid="card-espresso"] .add').click();

  await expect(page.locator('[data-fruitback-composer]')).toHaveAttribute('data-fruitback-state', 'sending');
  await expect(about).toHaveText(/^Ajouter · <Button>$/);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);

  release();
  await expect(page.locator('[data-fruitback-composer]')).toContainText(/Not sent/);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);
});

/**
 * « Send » ends the row of the foot, whatever the length of the words (FRU-317). In French, « Garder
 * pour plus tard », « Annuler » and « Envoyer » do not fit on one line of the popover of 360 px:
 * « Envoyer » fell alone on a second line, at the start. On the widget as `init` mounts it, which
 * offers « Add to batch » once the worker offers a batch (an icon since FRU-608).
 */
for (const [locale, keep, cancel, send] of [
  ['fr-FR', 'Ajouter au lot', 'Annuler', 'Envoyer'],
  ['en-US', 'Add to batch', 'Cancel', 'Send'],
] as const) {
  test(`in ${locale}, « ${send} » ends the row of the foot, and the ghosts never go under it (FRU-317)`, async ({
    page,
  }) => {
    // The composer rises with a scale and a slide (FRU-258). Each `boundingBox` is read at another
    // frame of that animation, so the boxes did not agree to a pixel or two on CI. With no motion,
    // the boxes are those of the final layout.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?widget=off&case=${caseOf(`composer-foot-${locale}`)}`);
    await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
    await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
    // « Add to batch » is offered once the first read says the worker takes a batch.
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

/**
 * The truncation of P7 (FRU-611, point 1), on the composer of FRU-607: words 40 % longer than the
 * English, the length of French and German, never wrap inside a button; they end in « … » with the
 * tooltip. The field grows with the text up to 150 px, then scrolls, with a fade at its foot.
 */
test('long words never wrap in a button, and the field grows to 150 px then scrolls with a fade (FRU-611)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/?widget=off&case=${caseOf('composer-long-words')}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
  const firstRead = page.waitForResponse(
    (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/feedback',
  );
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: unknown): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'de',
        // German is not bundled: these are the words of the buttons, longer than the French.
        messages: {
          de: {
            'composer.cancel': 'Abbrechen und das Fenster schließen, ohne irgendetwas zu senden',
            'composer.send': 'Absenden',
            'composer.pickAgain': 'Ein anderes Element auf der Seite auswählen',
          },
        },
      }),
    WORKER_ORIGIN,
  );
  await firstRead;
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const longest = page.getByRole('button', { name: /^Abbrechen/ });
  await expect(longest).toBeVisible();

  for (const name of [/^Abbrechen/, /^Absenden$/, /^Ein anderes Element/]) {
    const button = page.getByRole('button', { name });
    const drawn = await button.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      wrap: getComputedStyle(node).whiteSpace,
      cut: node.scrollWidth > node.clientWidth,
      title: node.getAttribute('title'),
      words: node.textContent,
    }));
    // One line, 44 px to press, whatever the length of its words.
    expect(drawn.height, String(name)).toBeLessThanOrEqual(44);
    expect(drawn.wrap, String(name)).toBe('nowrap');
    // Cut or not, the tooltip holds the whole words.
    expect(drawn.title, String(name)).toBe(drawn.words);
  }
  // The control: the longest words do not fit, so they are cut, not wrapped.
  expect(await longest.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await longest.evaluate((node) => getComputedStyle(node).textOverflow)).toBe('ellipsis');

  const field = page.locator('[data-fruitback-note]');
  const tall = () => field.evaluate((node) => Math.round(node.getBoundingClientRect().height));
  // At rest, its four rows: at least the 96 px of the mock-up.
  const rest = await tall();
  expect(rest).toBeGreaterThanOrEqual(96);
  await field.fill('Une ligne,\npuis une autre,\npuis une troisième,\npuis une quatrième,\npuis une cinquième.');
  const grown = await tall();
  expect(grown).toBeGreaterThan(rest);
  expect(grown).toBeLessThan(150);
  await field.fill(Array.from({ length: 14 }, (_, n) => `Ligne ${n + 1} d’une longue note`).join('\n'));
  expect(await tall()).toBe(150);
  expect(await field.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  // The measure behind the comment below: after typing, the field is scrolled to its end.
  const after = await field.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  expect(after).toBeLessThanOrEqual(1);
  await expect(field).not.toHaveAttribute('data-fruitback-more', '');
  // Typing leaves the caret, and the view, at the end of the text: nothing is below it then. Back at
  // the top of the field, the rest of the text is below, and the foot fades.
  await field.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(field).toHaveAttribute('data-fruitback-more', '');
  expect(await field.evaluate((node) => getComputedStyle(node).maskImage)).toContain('linear-gradient');
  // At the end of the text, no more fade: nothing is below.
  await field.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(field).not.toHaveAttribute('data-fruitback-more', '');
  expect(await field.evaluate((node) => getComputedStyle(node).maskImage)).toBe('none');
  // And the text is all there.
  await expect(field).toHaveValue(/Ligne 14 d’une longue note$/);
});
