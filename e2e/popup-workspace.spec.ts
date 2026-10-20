import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * A site of a workspace in the popup (FRU-254): « Turn on here » (06), then the switch, the notes of
 * the page and the two actions (07), in the real extension, against the second worker of the suite,
 * whose workspace lists the playground.
 */

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
  await popup.getByRole('button', { name: /^(Pair with this worker|Appairer avec ce worker)$/ }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

/** The popup again: one at a time, `openPopup` finds it by its address. */
async function reopen(extension: LoadedExtension, page: Page, previous?: Page): Promise<Page> {
  if (previous !== undefined && !previous.isClosed()) await previous.close();

  return openPopup(extension, page);
}

test('a site of the workspace: one click, then the switch, the notes of the page and the two actions', async ({
  extension,
}) => {
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-workspace');

  // 06: the workspace, who reads the notes, and one click.
  let popup = await reopen(extension, page);
  await popup.setViewportSize({ width: 360, height: 420 });
  await expect(popup.getByRole('heading', { level: 1, name: 'localhost:5177' })).toBeVisible();
  await expect(popup.getByText(/^In Playground · (members see|everyone sees) the notes$/)).toBeVisible();
  await expect(popup.getByText('Chrome asks for access to this site only.')).toBeVisible();
  await expect(popup.getByRole('img', { name: `Signed in as ${NAME}` })).toHaveCount(0);
  expectNear(await boxOf(popup.getByRole('heading', { level: 1 })), { x: 16, y: 77, width: 328 }, 'title');
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Turn on here' })),
    // Without the counts of FRU-237 the block stays at the foot: the mock-up has a foot of the account.
    { x: 16, width: 328, height: 46 },
    'turn on',
  );
  await clean(popup, 'the popup on a site of the workspace');

  await popup.getByRole('button', { name: 'Turn on here' }).click();
  // 07: on, with the switch; the widget is on the page.
  await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();
  await expect(popup.getByText('On · Playground')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // A note, then the counts of the page: the pins the page shows.
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Planté depuis un site du workspace');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  popup = await reopen(extension, page, popup);
  await popup.setViewportSize({ width: 360, height: 540 });
  const section = popup.getByRole('region', { name: /^On this page/ });
  await expect(section).toContainText('1 note');
  const rows = section.getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveText(/New\s*1/);
  await expect(rows.nth(4)).toHaveText(/Closed\s*0/);
  // The drops of the kit (FRU-293): a mark of 12 px in the colour of each status.
  expect(
    await section.locator('.kit-drop').evaluateAll((drops) =>
      drops.map((drop) => {
        const drawn = getComputedStyle(drop);

        return `${drawn.width} ${drawn.height} ${drawn.backgroundColor}`;
      }),
    ),
  ).toEqual(
    ['rgb(106, 121, 80)', 'rgb(86, 128, 46)', 'rgb(172, 95, 0)', 'rgb(221, 44, 39)', 'rgb(141, 110, 99)'].map(
      (fill) => `12px 12px ${fill}`,
    ),
  );
  // The switch of the kit (FRU-293): 44 × 26.
  expectNear(await boxOf(popup.getByRole('switch')), { x: 300, y: 84, width: 44, height: 26 }, 'switch');
  // A session of a pairing keeps its row under the actions, so their size is measured here, and
  // their place on the screen of an account (`popup-new-site.spec.ts`).
  await expect(popup.getByText(`Paired as ${NAME}`)).toBeVisible();
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Leave feedback' })),
    { x: 16, width: 328, height: 46 },
    'leave',
  );
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Show every note of the page' })),
    { x: 16, width: 328, height: 44 },
    'every note',
  );
  // The keyboard: the gear, the switch, then the two actions.
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await popup.keyboard.press('Tab');
    stops.push(
      await popup.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '',
      ),
    );
  }
  expect(stops).toEqual([
    'Settings and every site',
    'Fruitback on localhost:5177',
    'Leave feedback',
    'Show every note of the page',
  ]);
  await clean(popup, 'the popup on a site that is on');

  // « Show every note of the page »: the list of the widget opens, and the popup goes.
  await popup.getByRole('button', { name: 'Show every note of the page' }).click();
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await page.getByRole('button', { name: 'Close the notes' }).click();

  // « Leave feedback »: the widget waits for an element.
  popup = await reopen(extension, page);
  await popup.getByRole('button', { name: 'Leave feedback' }).click();
  await expect(page.locator('[data-fruitback-capturing]')).toHaveCount(1);
  await expect.poll(() => popup.isClosed()).toBe(true);
  await page.keyboard.press('Escape');

  // A note being written: « Leave feedback » takes nothing from it, and the popup stays and says why.
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Une note en cours');
  popup = await reopen(extension, page);
  await popup.getByRole('button', { name: 'Leave feedback' }).click();
  await expect(popup.getByText('A note is being written on the page. Send it or close it first.')).toBeVisible();
  expect(popup.isClosed()).toBe(false);
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une note en cours');
  await expect(page.locator('[data-fruitback-capturing]')).toHaveCount(0);
  await page.getByPlaceholder('What should change?').fill('');
  await page.getByPlaceholder('What should change?').press('Escape');
  await expect(page.getByPlaceholder('What should change?')).toBeHidden();

  // The switch, twice: the widget leaves, then comes back once.
  popup = await reopen(extension, page);
  await popup.getByRole('switch').click();
  await expect(popup.getByRole('switch')).not.toBeChecked();
  await expect(popup.getByText('Off · Playground')).toBeVisible();
  await expect(popup.getByRole('region', { name: /^On this page/ })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Leave feedback' })).toHaveCount(0);
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  await popup.getByRole('switch').click();
  await expect(popup.getByRole('switch')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test('screen 07 is drawn before the page answers how many notes it shows, and the notes come after', async ({
  extension,
}) => {
  // The answers of the widget of the page are held in its own world, until the spec lets them go.
  await extension.context.addInitScript(() => {
    const held: (() => void)[] = [];
    const scope = window as unknown as { __releaseCounts?: () => void };
    scope.__releaseCounts = () => {
      for (const send of held.splice(0)) send();
    };
    const post = window.postMessage.bind(window);
    window.postMessage = ((message: unknown, ...rest: unknown[]) => {
      const answer = message as { kind?: string; counts?: unknown };
      if (answer?.kind === 'command-response' && answer.counts !== undefined) {
        held.push(() => (post as (...all: unknown[]) => void)(message, ...rest));

        return;
      }
      (post as (...all: unknown[]) => void)(message, ...rest);
    }) as typeof window.postMessage;
  });
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-workspace-held');
  let popup = await reopen(extension, page);
  await popup.getByRole('button', { name: 'Turn on here' }).click();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  popup = await reopen(extension, page, popup);
  // The switch and the actions are there while the page holds its answer.
  await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();
  await expect(popup.getByRole('button', { name: 'Leave feedback' })).toBeVisible();
  await expect(popup.getByRole('region', { name: /^On this page/ })).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { __releaseCounts: () => void }).__releaseCounts());
  await expect(popup.getByRole('region', { name: /^On this page/ })).toContainText('0 notes');
});

test('the popup on a site of the workspace speaks French', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
  });
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-workspace-fr');
  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 360, height: 540 });

  await expect(popup.getByText(/^Dans Playground · /)).toBeVisible();
  await expect(popup.getByText('Chrome demande l’accès à ce site seulement.')).toBeVisible();
  await popup.getByRole('button', { name: 'Activer ici' }).click();
  await expect(popup.getByRole('switch', { name: 'Fruitback sur localhost:5177' })).toBeChecked();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await clean(popup, 'the popup on a site that is on, in French');
});
