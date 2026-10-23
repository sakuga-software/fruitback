import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The files of a note in the composer (FRU-332), in French, at 390 px, with axe, in both schemes:
 * « Joindre » and its menu, the area, a capture that fails and the drop zone (FRU-351), and no pin
 * on the page while a capture is taken.
 *
 * The bundle is mounted with a transport that answers the read with `canAttach: true` and keeps a
 * file as the worker does, and with a capture of the host that answers a PNG: what the extension
 * gives a site of a workspace. The path through the real relay and worker is in `extension.spec.ts`.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as {
      Fruitback: { init(options: unknown): unknown };
      areas: unknown[];
      /** FRU-351: whether the pins were on the page while the capture was taken. */
      pinsSeen: boolean[];
      failNext: boolean;
    };
    scope.areas = [];
    scope.pinsSeen = [];
    scope.failNext = false;
    let n = 0;
    (scope.Fruitback as { init(options: unknown): unknown }).init({
      endpoint,
      clientId: 'playground',
      locale: 'fr',
      label: 'Laisser une note',
      captureVisible: async (area?: unknown) => {
        scope.areas.push(area ?? null);
        const host = document.querySelector('[data-fruitback-host]');
        const pin = host?.shadowRoot?.querySelector('[data-fruitback-pin]');
        scope.pinsSeen.push(pin !== null && pin !== undefined && getComputedStyle(pin).visibility !== 'hidden');
        if (scope.failNext) {
          scope.failNext = false;
          throw new Error('the browser refused the capture');
        }

        return { name: area === undefined ? 'page.png' : 'zone.png', type: 'image/png', size: 4, base64: 'iVBORw==' };
      },
      transport: async (request: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
        const url = new URL(request.url);
        if (url.pathname === '/attachments') {
          n += 1;

          return { ok: true, status: 201, body: JSON.stringify({ id: `att_${String(n).padStart(32, '0')}` }) };
        }
        const answer = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        const body = await answer.text();
        if (request.method === 'GET' && answer.ok) {
          return { ok: true, status: 200, body: JSON.stringify({ ...JSON.parse(body), canAttach: true }) };
        }

        return { ok: answer.ok, status: answer.status, body };
      },
    });
  }, WORKER_ORIGIN);
}

/** Whether the pin of the page is drawn now: hidden while a capture is taken (FRU-351). */
async function pinShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pin = document.querySelector('[data-fruitback-host]')?.shadowRoot?.querySelector('[data-fruitback-pin]');

    return pin !== null && pin !== undefined && getComputedStyle(pin).visibility !== 'hidden';
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`in French at 390 px, « Joindre », its menu, the area and the drop zone work with the keyboard, the pins are not on a capture, and axe finds nothing (${scheme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/?case=attachments-${scheme}&widget=off`);
    await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
    await mount(page);

    // A pin on the page first: a note with no file, to the worker of the suite.
    await page.getByRole('button', { name: 'Laisser une note' }).click();
    await page.locator('[data-testid="card-espresso"] .add').click();
    await page.getByPlaceholder('Que faut-il changer ?').fill('Une note pour son pin');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
    expect(await pinShown(page)).toBe(true);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Laisser une note' }).click();
    await page.locator('[data-testid="card-latte"] .add').click();
    const files = page.getByRole('group', { name: 'Pièces jointes' });
    await expect(files).toBeVisible();
    await expect(page.locator('[data-fruitback-attach-file-input]')).toBeHidden();
    const trigger = files.getByRole('button', { name: 'Joindre' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    // The menu, with the keyboard only: it opens on its first way, and the arrows go round.
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const menu = files.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Ajouter une pièce jointe',
      'Capturer une zone',
      'Capturer la page entière',
      'Glisser-déposer',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Ajouter une pièce jointe' })).toBeFocused();
    const axeMenu = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(axeMenu.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    );
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // The area: the pins go while it is chosen, and come back after.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Capturer une zone' })).toBeFocused();
    await page.keyboard.press('Enter');
    const area = page.getByRole('dialog', { name: 'Choisir une zone de la page' });
    await expect(area).toBeVisible();
    expect(await pinShown(page)).toBe(false);
    const axeArea = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(axeArea.violations).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await expect(area).toBeHidden();
    await expect(page.locator('.fruitback-composer-file-name')).toHaveText(['zone.png']);
    await expect(trigger).toBeFocused();
    expect(await pinShown(page)).toBe(true);
    const taken = (await page.evaluate(() => (globalThis as unknown as { areas: unknown[] }).areas)) as {
      left: number;
    }[];
    expect(taken).toHaveLength(1);
    expect(taken[0]?.left).toBeCloseTo(390 * 0.25 + 10, 0);

    // Esc cancels, nothing is joined, the focus is back on « Joindre », and the pins are back.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(area).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(area).toBeHidden();
    await expect(page.locator('.fruitback-composer-file')).toHaveCount(1);
    await expect(trigger).toBeFocused();
    expect(await pinShown(page)).toBe(true);

    // The whole page, whose capture fails: said under its name, and the pins come back all the same.
    await page.evaluate(() => {
      (globalThis as unknown as { failNext: boolean }).failNext = true;
    });
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Capturer la page entière' }).click();
    await expect(page.locator('.fruitback-composer-file')).toHaveCount(2);
    await expect(page.locator('.fruitback-composer-file-detail').nth(1)).toHaveText('La capture n’a pas été prise');
    expect(await pinShown(page)).toBe(true);
    // No capture saw a pin.
    expect(await page.evaluate(() => (globalThis as unknown as { pinsSeen: boolean[] }).pinsSeen)).toEqual([
      false,
      false,
    ]);

    // The drop zone: a file dropped on it joins the note.
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Glisser-déposer' }).click();
    const zone = page.locator('[data-fruitback-attach-dropzone]');
    await expect(zone).toBeVisible();
    await expect(zone).toContainText('Déposez vos fichiers ici');
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['une ligne'], 'journal.txt', { type: 'text/plain' }));

      return transfer;
    });
    await zone.dispatchEvent('dragover', { dataTransfer });
    await zone.dispatchEvent('drop', { dataTransfer });
    await expect(page.locator('.fruitback-composer-file-name')).toHaveText(['zone.png', 'page.png', 'journal.txt']);
    await expect(zone).toBeHidden();

    const axe = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(axe.violations).toEqual([]);
  });
}

type Box = { top: number; bottom: number; left: number; right: number; height: number };

/** The boxes of the composer, of « Attach » and of its menu, and the window, in CSS px of the viewport. */
async function boxes(page: Page): Promise<{ composer: Box; trigger: Box; menu: Box; width: number; height: number }> {
  return page.evaluate(() => {
    const shadow = (document.querySelector('[data-fruitback-host]') as Element).shadowRoot as ShadowRoot;
    const box = (selector: string): Box => {
      const { top, bottom, left, right, height } = (shadow.querySelector(selector) as Element).getBoundingClientRect();

      return { top, bottom, left, right, height };
    };

    return {
      composer: box('.fruitback-composer'),
      trigger: box('[data-fruitback-attach-trigger]'),
      menu: box('[data-fruitback-attach-menu]'),
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
  });
}

/** Opens the composer on the latte card, with a note typed: the text that nothing may clear. */
async function openOnLatte(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mount(page);
  await page.getByRole('button', { name: 'Laisser une note' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('Que faut-il changer ?').fill('Le texte reste');
  // The composer rises and scales as it comes: its box is its own only once that is over.
  await page.evaluate(() =>
    Promise.all(
      (document.querySelector('[data-fruitback-host]')?.shadowRoot?.getAnimations() ?? []).map((each) => each.finished),
    ),
  );
}

test('the menu « Joindre » floats under its button, and the composer keeps its size (FRU-431)', async ({ page }) => {
  await openOnLatte(page, '/?case=attachments-float&widget=off');
  const files = page.getByRole('group', { name: 'Pièces jointes' });
  const trigger = files.getByRole('button', { name: 'Joindre' });
  const menu = files.getByRole('menu');
  const closed = await boxes(page);

  await trigger.click();
  await expect(menu).toBeVisible();
  const open = await boxes(page);
  expect(open.composer.height).toBeCloseTo(closed.composer.height, 1);
  expect(open.composer.top).toBeCloseTo(closed.composer.top, 1);
  expect(open.menu.top).toBeGreaterThanOrEqual(open.trigger.bottom);
  expect(open.menu.bottom).toBeLessThanOrEqual(open.height);

  // A click out of the menu closes it, and the note keeps its text.
  await page.getByPlaceholder('Que faut-il changer ?').click();
  await expect(menu).toBeHidden();
  await expect(page.getByPlaceholder('Que faut-il changer ?')).toHaveValue('Le texte reste');
  expect((await boxes(page)).composer.height).toBeCloseTo(closed.composer.height, 1);
});

for (const [width, height] of [
  [1440, 600],
  [390, 844],
  [320, 568],
] as const) {
  test(`at ${width} × ${height}, at the foot of the window, the menu « Joindre » opens above its button and stays in the window (FRU-431)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openOnLatte(page, `/?case=attachments-up-${width}&widget=off`);
    const files = page.getByRole('group', { name: 'Pièces jointes' });
    const trigger = files.getByRole('button', { name: 'Joindre' });
    const menu = files.getByRole('menu');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    const open = await boxes(page);
    // The premise of the case: the menu does not fit under « Joindre ».
    expect(open.height - open.trigger.bottom).toBeLessThan(open.menu.height);
    expect(open.menu.bottom).toBeLessThanOrEqual(open.trigger.top);
    expect(open.menu.top).toBeGreaterThanOrEqual(0);
    expect(open.menu.left).toBeGreaterThanOrEqual(0);
    expect(open.menu.right).toBeLessThanOrEqual(open.width);
    expect(open.menu.bottom).toBeLessThanOrEqual(open.height);
    await expect(menu.getByRole('menuitem', { name: 'Ajouter une pièce jointe' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // A way of the menu above takes a click: nothing clips or covers it.
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Glisser-déposer' }).click();
    await expect(page.locator('[data-fruitback-attach-dropzone]')).toBeVisible();
    await expect(page.getByPlaceholder('Que faut-il changer ?')).toHaveValue('Le texte reste');
  });
}
