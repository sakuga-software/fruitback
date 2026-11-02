import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * The colour and the name of a status that a team chose, drawn by the widget (FRU-370).
 *
 * The worker of the dev loop sends the five built-in statuses with no colour, and its in-memory
 * Linear says no `status` (FRU-368 brings it). So the read is the worker's, and this adds to it what a
 * site with statuses would add: a list, and the key of each note. The widget is what is measured, as
 * `init` assembles it: the playground builds it part by part and reads no status, so this loads the
 * built script, like `sidebar.spec.ts`. Each colour is a computed style, which only a browser
 * resolves: the unit tests read a `var()`.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const NOTES = {
  pale: { card: 'card-latte', note: 'A pale colour the team chose', name: 'Waiting for the client', color: '#fef9c3' },
  dark: { card: 'card-mocha', note: 'A dark colour the team chose', name: 'In review', color: '#7c3aed' },
};
const EDGE = 'rgb(138, 138, 147) 0px 0px 0px 1px';
const INK = 'rgb(24, 24, 27)';
const WHITE = 'rgb(255, 255, 255)';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
}

async function plant(page: Page, card: string, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator(`[data-testid="${card}"] .add`).click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(note) }).first()).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
}

/** Adds statuses to every read of the page: one per planted note, in the stage the worker gave it. */
async function withStatuses(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === WORKER_ORIGIN && url.pathname === '/feedback',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { issues: { id: string; stage: string; note: { text: string } }[] };
      const statuses: Record<string, string>[] = [];
      const issues = body.issues.map((issue) => {
        const chosen = Object.values(NOTES).find((each) => each.note === issue.note.text);
        if (chosen === undefined) return issue;
        const key = `e2e:${issue.id}`;
        statuses.push({ key, name: chosen.name, stage: issue.stage, color: chosen.color });

        return { ...issue, status: key };
      });
      await route.fulfill({ response, json: { ...body, issues, statuses } });
    },
  );
}

const pin = (page: Page, note: string) =>
  page.locator('.fruitback-pin').filter({ has: page.getByRole('button', { name: new RegExp(note) }) });

/** The fill, the text, the edge and the stage of a pin, as the browser draws them. */
function drawn(page: Page, note: string) {
  return pin(page, note).evaluate((element) => {
    const badge = element.querySelector('.fruitback-pin-badge') as HTMLElement;
    const glyph = element.querySelector('.fruitback-pin-glyph') as HTMLElement;

    return {
      fill: getComputedStyle(badge).backgroundColor,
      text: getComputedStyle(glyph).color,
      edge: getComputedStyle(badge).boxShadow.split(', rgba')[0],
      stage: (element as HTMLElement).dataset.fruitbackStage,
    };
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`a pin wears the colour of its status and keeps its edge, in the ${colorScheme} scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const testCase = `team-status-colours-${colorScheme}`;
    await mount(page, testCase);
    await plant(page, NOTES.pale.card, NOTES.pale.note);
    await plant(page, NOTES.dark.card, NOTES.dark.note);
    const stages = [
      await pin(page, NOTES.pale.note).getAttribute('data-fruitback-stage'),
      await pin(page, NOTES.dark.note).getAttribute('data-fruitback-stage'),
    ];

    // The control: with no statuses, the pin wears its stage, which is not the colour below.
    expect((await drawn(page, NOTES.pale.note)).fill).not.toBe('rgb(254, 249, 195)');

    await withStatuses(page);
    await mount(page, testCase);
    await expect(page.locator('.fruitback-pin')).toHaveCount(2);

    // A pale yellow is 1.07:1 on white: the edge of FRU-334 is what draws it on a white page.
    await expect
      .poll(() => drawn(page, NOTES.pale.note))
      .toEqual({ fill: 'rgb(254, 249, 195)', text: INK, edge: EDGE, stage: stages[0] });
    // A dark violet takes white (5.70:1), and keeps the edge too.
    expect(await drawn(page, NOTES.dark.note)).toEqual({
      fill: 'rgb(124, 58, 237)',
      text: WHITE,
      edge: EDGE,
      stage: stages[1],
    });

    // The thread names the status, beside a drop of its colour.
    await pin(page, NOTES.pale.note).getByRole('button').click();
    const thread = page.locator('[data-fruitback-thread]');
    await expect(thread.locator('.fruitback-thread-state')).toHaveText(NOTES.pale.name);
    await expect(thread.locator('.fruitback-thread-drop')).toHaveCSS('background-color', 'rgb(254, 249, 195)');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');

    // The list names it too, and its chips stay the stages.
    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    const list = page.getByRole('dialog', { name: 'Notes on this page' });
    const row = list.locator('[data-fruitback-note]').filter({ hasText: NOTES.dark.note });
    await expect(row.locator('.fruitback-sidebar-status')).toHaveText(NOTES.dark.name);
    await expect(row.locator('.fruitback-sidebar-pin')).toHaveCSS('background-color', 'rgb(124, 58, 237)');
    await expect(list.getByRole('button', { name: 'All 2', exact: true })).toBeVisible();
    const chips = await list.locator('button[aria-pressed]').allTextContents();
    expect(chips.length).toBeGreaterThan(1);
    for (const chip of chips) expect(chip).toMatch(/^(All|New|To do|In progress|Done|Closed)\s*\d+$/);
    await page.waitForTimeout(400);
  });
}
