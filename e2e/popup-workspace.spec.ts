import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect } from '@playwright/test';
import {
  type LoadedExtension,
  clickThatClosesPopup,
  mintPairing,
  openBareSite,
  openPopup,
  test,
  OPEN_SIDEBAR,
  SITE_ON,
  SITE_SWITCH,
} from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * A site of a workspace in the popup (FRU-254, FRU-298, FRU-695): « Leave notes on this site? » (2),
 * then the card and its switch, « Leave a note », the notes of the page and the side panel (3), in the real extension,
 * against the second worker of the suite, whose workspace lists the playground.
 */

/** The one `chrome.*` call of this spec, from the service worker: the contexts of the extension. */
declare const chrome: { runtime: { getContexts(filter: { contextTypes: string[] }): Promise<unknown[]> } };

const NAME = 'Camille Durand';

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = (await locator.first().boundingBox()) as Box;
  const round = (value: number) => Math.round(value * 10) / 10;

  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/** The boxes of the mock-up are measured in the font of macOS: compared there, and only there. */
function expectNear(built: Box, mockup: Partial<Box>, name: string): void {
  if (process.platform !== 'darwin') return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    const expected = mockup[side];
    if (expected === undefined) continue;
    expect
      .soft(Math.abs(built[side] - expected), `${name}: ${side} is ${built[side]}, the mock-up has ${expected}`)
      .toBeLessThanOrEqual(2);
  }
}

async function clean(surface: Page, name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await surface.emulateMedia({ colorScheme });
    const { violations, passes } = await new AxeBuilder({ page: surface }).analyze();
    expect(
      passes.map((rule) => rule.id),
      `${name}, ${colorScheme}`,
    ).toContain('color-contrast');
    expect(
      violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
      `${name}, ${colorScheme}`,
    ).toEqual([]);
  }
  await surface.emulateMedia({ colorScheme: 'light' });
}

/** A session of the workspace of the suite's second worker, through a pairing link. */
async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: /^(Connect to this server|Se connecter à ce serveur)$/ }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

/** The popup again: one at a time, `openPopup` finds it by its address. */
async function reopen(extension: LoadedExtension, page: Page, previous?: Page): Promise<Page> {
  if (previous !== undefined && !previous.isClosed()) await previous.close();

  return openPopup(extension, page);
}

test('2 then 3: a site of the workspace turns on in one click, then the switch, « Leave a note », what waits and the side panel (FRU-298)', async ({
  extension,
}) => {
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-workspace');

  // 2: the question, who reads the notes, and one click.
  let popup = await reopen(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  await expect(popup.getByRole('heading', { level: 1, name: 'Leave notes on this site?' })).toBeVisible();
  await expect(popup.locator('.kit-site-host')).toHaveText('localhost:5177');
  await expect(popup.getByText('In Playground · not on in this browser')).toBeVisible();
  // P2 of FRU-598: a summary in the words of the console, and no list before the link.
  await expect(popup.locator('.turn-on-summary .kit-dl-entry').filter({ hasText: 'Seen by' }).locator('dd')).toHaveText(
    /^(Members of Playground|Everyone who visits)$/,
  );
  await expect(popup.getByRole('combobox')).toHaveCount(0);
  await expect(popup.getByText('Your browser asks once for access to this site.')).toBeVisible();
  await expect(popup.locator('.kit-avatar-dot', { hasText: /\S/ })).toHaveCount(0);
  // The boxes of the mock-up (`popup-2-site-not-added.png`): 24 px around, the title at 22 px.
  expectNear(await boxOf(popup.getByRole('heading', { level: 1 })), { x: 24, width: 332 }, 'title');
  expectNear(await boxOf(popup.getByRole('button', { name: 'Turn on' })), { x: 24, width: 332, height: 46 }, 'turn on');
  await clean(popup, 'the popup on a site of the workspace');

  await popup.getByRole('button', { name: 'Turn on' }).click();
  // 3: on, with its dot; the widget is on the page.
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  await expect(popup.locator('.kit-site-state')).toHaveText(/^On · /);
  await expect(popup.getByRole('switch', { name: SITE_SWITCH })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Leave a note' })).toBeVisible();
  // FRU-695: « On this page » reads the widget of the tab, which has no note yet.
  await expect(popup.locator('.page-notes-said')).toHaveText('No notes on this page yet');

  // A note, then « 1 open note », as the worker counts the notes of the site (FRU-237).
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Planté depuis un site du workspace');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The count of the worker is read through its cache (15 s): asked again until it says one more.
  await expect
    .poll(
      async () => {
        popup = await reopen(extension, page, popup);
        await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();

        return popup
          .locator('.kit-site-state')
          .textContent({ timeout: 3_000 })
          .catch(() => '');
      },
      { timeout: 40_000, intervals: [3_000] },
    )
    .toMatch(/^On · Playground · \d+ open notes?$/);
  await popup.setViewportSize({ width: 380, height: 580 });
  // A session of a pairing names no « fixes to check » (an account's only, FRU-295).
  await expect(popup.locator('.page-notes-check')).toBeEmpty();
  // FRU-695: the note of the page, on one line, with its stage and its age, as the widget reads it.
  const line = popup.locator('.page-note');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(/^New, Planté depuis un site du workspace(now|\d+m)$/);
  await expect(popup.locator('.page-notes-count')).toHaveText('1');
  // The boxes of the mock-up of 2026-11-25 (popup-mockup.html of FRU-695, measured in a browser): the
  // head of 48, the card, « Sent to » left out (the worker of a pairing names no place), « Leave a
  // note » of 40, the line of a note of 34, the foot of 44 at the bottom of 580.
  expectNear(await boxOf(popup.locator('.popup-head')), { x: 0, y: 0, width: 380, height: 48 }, 'head');
  expectNear(await boxOf(popup.locator('.site-card')), { x: 12, y: 60, width: 356 }, 'card');
  expectNear(await boxOf(popup.getByRole('switch', { name: SITE_SWITCH })), { width: 36, height: 22 }, 'switch');
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Leave a note' })),
    { x: 12, width: 356, height: 40 },
    'leave',
  );
  expectNear(await boxOf(line), { x: 12, width: 356, height: 34 }, 'note');
  expectNear(await boxOf(popup.locator('.popup-foot')), { x: 0, y: 536, width: 380, height: 44 }, 'foot');
  // The keys of « Leave a note », inside it, as the browser has them (FRU-291); its name stays its words.
  await expect(popup.locator('.leave-keys')).toHaveText(/\S+ \S+/);
  await expect(popup.getByRole('button', { name: 'Leave a note', exact: true })).toHaveAttribute(
    'aria-keyshortcuts',
    /\+/,
  );
  // A session of a pairing keeps its person and its « Sign out », in the foot.
  await expect(popup.locator('.popup-foot').getByText(`Connected as ${NAME}`)).toBeVisible();
  // Nothing wraps: every line of the popup is one line at 380 px (FRU-695).
  const wrapped = await popup.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.kit-site-state, .destination-place, .page-note-text, .leave-note')]
      .filter((node) => node.getClientRects().length > 1 || node.scrollHeight > node.clientHeight + 1)
      .map((node) => node.textContent),
  );
  expect(wrapped).toEqual([]);
  // The keyboard: the account, the switch, « Leave a note », « Open sidebar », the note, then the foot:
  // the person's « Sign out », the guide and the menu of the site (FRU-695).
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    await popup.keyboard.press('Tab');
    stops.push(
      await popup.evaluate(() => {
        const active = document.activeElement;
        const words = active?.querySelector('.page-note-text')?.textContent;

        const own = [...(active?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE);

        return active?.getAttribute('aria-label') ?? words ?? own.map((node) => node.textContent).join('');
      }),
    );
  }
  expect(stops).toEqual([
    'Account and settings',
    'Fruitback on this site',
    'Leave a note',
    'Open sidebar',
    'Planté depuis un site du workspace',
    'Sign out',
    'How Fruitback works',
    'More for this site',
  ]);
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site that is on');

  // A click on the note opens it on the page, its thread, and the popup goes (FRU-695).
  await clickThatClosesPopup(popup, line);
  await expect(page.getByRole('dialog', { name: /^(Note|Feedback) / })).toBeVisible();
  await page.keyboard.press('Escape');

  // « Open sidebar » opens the side panel of the browser on the tab (FRU-296), and the popup goes.
  // `e2e/side-panel.spec.ts` reads the panel.
  const panels = () =>
    extension.worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length);
  popup = await reopen(extension, page);
  await clickThatClosesPopup(popup, popup.getByRole('button', { name: OPEN_SIDEBAR }));
  await expect.poll(panels).toBe(1);

  // Again: the panel is open already, and the popup closes at once.
  popup = await reopen(extension, page);
  await clickThatClosesPopup(popup, popup.getByRole('button', { name: OPEN_SIDEBAR }));
  await expect.poll(panels).toBe(1);

  // « Leave a note »: the widget waits for an element.
  popup = await reopen(extension, page);
  await clickThatClosesPopup(popup, popup.getByRole('button', { name: 'Leave a note' }));
  await expect(page.locator('[data-fruitback-capturing]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A note being written: « Leave a note » takes nothing from it, and the popup stays and says why.
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Une note en cours');
  popup = await reopen(extension, page);
  await popup.getByRole('button', { name: 'Leave a note' }).click();
  await expect(popup.getByText('A note is being written on the page. Send it or close it first.')).toBeVisible();
  expect(popup.isClosed()).toBe(false);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une note en cours');
  await expect(page.locator('[data-fruitback-capturing]')).toHaveCount(0);
  await page.getByPlaceholder('What should change?').fill('');
  await page.getByPlaceholder('What should change?').press('Escape');
  await expect(page.getByPlaceholder('What should change?')).toBeHidden();

  // The switch turns the site off, then « Turn on » turns it on: the widget leaves, then comes back once.
  popup = await reopen(extension, page);
  await popup.getByRole('switch', { name: SITE_SWITCH }).click();
  await expect(popup.getByText('Off · Playground')).toBeVisible();
  await expect(popup.getByRole('img', { name: SITE_ON })).toHaveCount(0);
  await expect(popup.getByRole('switch', { name: SITE_SWITCH })).toHaveAttribute('aria-checked', 'false');
  await expect(popup.locator('.page-notes')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Leave a note' })).toHaveCount(0);
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  await clean(popup, 'the popup on a site turned off');
  await popup.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave a note' })).toBeVisible();
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test('the popup on a site of the workspace speaks French', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
  });
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-workspace-fr');
  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  await expect(popup.getByRole('heading', { level: 1, name: 'Laisser des notes sur ce site ?' })).toBeVisible();
  await expect(popup.getByText(/^Dans Playground · pas activé dans ce navigateur$/)).toBeVisible();
  await expect(popup.getByText('Votre navigateur demande une fois l’accès à ce site.')).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site of the workspace, in French');
  await popup.getByRole('button', { name: 'Activer', exact: true }).click();
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Laisser une note' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Ouvrir le panneau' })).toBeVisible();
  await expect(popup.getByRole('switch', { name: 'Fruitback sur ce site' })).toBeVisible();
  await expect(popup.getByRole('heading', { level: 2, name: /^Sur cette page/ })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site that is on, in French');
});
