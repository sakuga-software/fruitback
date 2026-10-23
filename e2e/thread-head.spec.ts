import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

/**
 * The bubble of a note, in French (FRU-419): the cross stays at the top on the right, the age of the
 * status leaves the head, and the source and an empty « Réponses » are hidden.
 *
 * The defect was a measure of layout: « In Progress · il y a 21 minutes · DEV-1 → » asked about 338 px
 * of 314, and the cross fell alone to a second line. Only a real browser lays it out.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

type Read = { stateName: string; replies: number };

/** What the read gives: the status of Mathieu's screenshot, changed 21 minutes ago, a source, and replies. */
async function rewriteReads(page: Page, read: Read): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      issues: {
        stateName: string;
        stage: string;
        updatedAt: string;
        comments?: unknown[];
        seed: Record<string, unknown>;
      }[];
    };
    for (const issue of body.issues) {
      issue.stateName = read.stateName;
      issue.stage = 'progress';
      issue.updatedAt = new Date(Date.now() - 21 * 60_000).toISOString();
      issue.seed.source = { component: 'HeroBanner', file: 'src/components/Hero.tsx', line: 42 };
      issue.comments = Array.from({ length: read.replies }, (_, index) => ({
        id: `reply-${index}`,
        body: 'On essaie la variante crème dans le prochain build.',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        author: 'Léa',
      }));
    }
    await route.fulfill({ response, json: body });
  });
}

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as {
      Fruitback: { init(options: Record<string, unknown>): unknown };
      fruitbackWidget: unknown;
    };
    scope.fruitbackWidget = scope.Fruitback.init({ endpoint, clientId: 'playground', locale: 'fr-FR' });
  }, WORKER_ORIGIN);
}

async function plant(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Laisser une note' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('Que faut-il changer ?').fill(note);
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Nouvelle note' })).toBeHidden({ timeout: 10_000 });
}

async function openNote(page: Page, note: string) {
  await page.getByRole('button', { name: new RegExp(`^Note 1, .*${note}`) }).click();
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();

  return thread;
}

/** The boxes of the state and of the cross, as drawn: the cross is 28 px inside a border of 8 px. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const state = root.querySelector('.fruitback-thread-stage')!.getBoundingClientRect();
    const close = root.querySelector('.fruitback-thread-close')!.getBoundingClientRect();
    const head = root.querySelector('.fruitback-thread-head')!.getBoundingClientRect();

    return {
      stateTop: state.top,
      stateMiddle: state.top + state.height / 2,
      closeTop: close.top + 8,
      closeMiddle: close.top + close.height / 2,
      closeRight: close.right - 8,
      headRight: head.right,
    };
  });

const axe = async (page: Page) => {
  const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();

  return results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`);
};

for (const width of [1280, 390] as const) {
  test(`in French at ${width} px, the cross stays on the first line at the right, and the age of the status is in its title (FRU-419)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await rewriteReads(page, { stateName: 'In Progress', replies: 0 });
    await mount(page, `thread-head-${width}`);
    await plant(page, 'La croix passe à la ligne.');

    const thread = await openNote(page, 'La croix passe');
    await expect(thread.getByRole('link')).toHaveText(/^DEV-\d+ →$/);
    await expect(thread.locator('.fruitback-thread-state')).toHaveText('In Progress');

    // On the first line, at the right: the cross is centred on the line of the state.
    const box = await boxes(page);
    expect(Math.abs(box.closeMiddle - box.stateMiddle)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.closeTop - box.stateTop)).toBeLessThanOrEqual(5);
    expect(box.headRight - box.closeRight).toBeCloseTo(14, 0);

    // The age of the status is in the title of its word, and no longer in the head.
    const today = new Date().toLocaleDateString('fr-FR');
    await expect(thread.locator('.fruitback-thread-state')).toHaveAttribute('title', `In Progress depuis le ${today}`);
    await expect(thread.locator('.fruitback-thread-head')).not.toContainText('il y a');
    // The age of the note stays under the note.
    await expect(thread.locator('.fruitback-thread-meta')).toContainText('il y a');

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    );
    expect(await axe(page)).toEqual([]);
  });
}

test('in French, a long status wraps in its column and the cross keeps the top of the head (FRU-350, FRU-419)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rewriteReads(page, { stateName: 'En attente de la validation du client sur la préproduction', replies: 0 });
  await mount(page, 'thread-head-long');
  await plant(page, 'Un statut très long.');

  const thread = await openNote(page, 'Un statut très long');
  const box = await boxes(page);
  expect(Math.abs(box.closeTop - box.stateTop)).toBeLessThanOrEqual(5);
  // Never cut: the whole word of the status is on screen.
  const state = thread.locator('.fruitback-thread-state');
  expect(await state.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await expect(state).toHaveText('En attente de la validation du client sur la préproduction');
});

test('in French, no « Réponses » over nothing, and the title and the list from the first reply on (FRU-419)', async ({
  page,
}) => {
  const read: Read = { stateName: 'In Progress', replies: 0 };
  await rewriteReads(page, read);
  await mount(page, 'thread-head-replies');
  await plant(page, 'Personne n’a encore répondu.');

  let thread = await openNote(page, 'Personne n’a encore');
  await expect(thread.getByRole('textbox', { name: 'Réponse' })).toBeVisible();
  await expect(thread).not.toContainText('Réponses');
  await expect(thread).not.toContainText('Pas encore de réponse.');
  await expect(thread.locator('.fruitback-thread-answers')).toHaveCount(0);
  expect(await axe(page)).toEqual([]);

  read.replies = 1;
  await page.reload();
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await mount(page, 'thread-head-replies');
  thread = await openNote(page, 'Personne n’a encore');
  await expect(thread.locator('.fruitback-thread-answers-title')).toHaveText('Réponses');
  await expect(thread.getByRole('list', { name: 'Réponses' }).getByRole('listitem')).toHaveCount(1);
});

test('in French, neither the selector nor the source without showSelectors, and both with it (FRU-349, FRU-419)', async ({
  page,
}) => {
  await rewriteReads(page, { stateName: 'In Progress', replies: 0 });
  await mount(page, 'thread-head-source');
  await plant(page, 'La source est pour un développeur.');

  const thread = await openNote(page, 'La source est');
  await expect(thread.locator('.fruitback-thread-source')).toHaveCount(0);
  await expect(thread).not.toContainText('HeroBanner');
  await expect(thread).not.toContainText('card-espresso');

  await page.evaluate(() =>
    (globalThis as unknown as { fruitbackWidget: { showSelectors(on: boolean): void } }).fruitbackWidget.showSelectors(
      true,
    ),
  );
  await expect(thread.locator('.fruitback-thread-selector')).toHaveText(/card-espresso/);
  await expect(thread.locator('.fruitback-thread-component')).toHaveText('<HeroBanner> · src/components/Hero.tsx:42');
  // Discreet: a line of 12 px in mono, no box, and a developer can select it to copy it.
  const look = await thread.locator('.fruitback-thread-source').evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      border: style.borderTopWidth,
      background: style.backgroundColor,
      select: style.userSelect,
    };
  });
  expect(look).toMatchObject({ fontSize: '12px', border: '0px', background: 'rgba(0, 0, 0, 0)', select: 'text' });
  expect(look.fontFamily).toMatch(/^ui-monospace/);
  expect(await axe(page)).toEqual([]);
});
