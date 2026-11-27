import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { noteFixture } from '../packages/shared/src/note.fixture.ts';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * The history of a note in its panel (FRU-704, « Keep every version »): who edited or deleted it, when,
 * and the text of before, oldest first. The worker is answered by stubs at the shape of
 * `GET …/notes/<note>`; what it keeps, and to whom it answers it, is measured by
 * `apps/worker/src/note-versions.test.ts`. Test data only.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'everyone', writers: 'anyone' }];
const AT = '2026-11-20T10:00:00.000Z';
const NOTE = noteFixture({
  id: 'sd_1',
  text: 'The price of the yearly plan is cut off on a phone.',
  page: { url: 'https://staging.acme.dev/pricing', path: '/pricing' },
});

/** Two notes the worker keeps: one with two versions, and one with none. */
async function worker(page: Page, locale: 'en' | 'fr' = 'en'): Promise<void> {
  const row = (id: string, excerpt: string) => ({
    id,
    excerpt,
    page: { url: NOTE.page.url, host: 'staging.acme.dev', path: '/pricing' },
    site: { id: 's1' },
    stage: 'new',
    author: { kind: 'anonymous' },
    place: { kind: 'fruitback' },
    createdAt: AT,
  });
  const read = (text: string, versions: unknown[]) => ({
    note: {
      id: 'sd_1',
      identifier: 'FB-1',
      title: '',
      stage: 'new',
      stateName: '',
      updatedAt: AT,
      note: { ...NOTE, text },
      comments: [],
    },
    versions,
  });
  await stubWorker(page, {
    locale,
    workspaces: [{ ...ACME, role: 'member' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({
          json: {
            notes: [row('n1', NOTE.text), row('n2', 'The logo is blurry.')],
            total: 2,
            counts: { all: 2 },
          },
        });
      }
      if (pathname === '/console/workspaces/w1/notes/n1') {
        return route.fulfill({
          json: read(NOTE.text, [
            {
              id: 'ver_1',
              kind: 'edit',
              text: 'The price is cut.',
              author: { kind: 'anonymous' },
              at: '2026-11-20T10:05:00.000Z',
            },
            {
              id: 'ver_2',
              kind: 'edit',
              text: 'The price of the plan is cut.',
              author: { kind: 'member', name: 'Ben Martin' },
              at: '2026-11-20T10:10:00.000Z',
            },
          ]),
        });
      }
      if (pathname === '/console/workspaces/w1/notes/n2') {
        return route.fulfill({ json: read('The logo is blurry.', []) });
      }

      return undefined;
    },
  });
}

test('the panel of a note shows its versions, oldest first, and no history for a note with none (FRU-704)', async ({
  page,
}) => {
  await worker(page);
  await page.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const panel = page.getByRole('dialog', { name: /The price of the yearly plan/ });
  const history = panel.locator('[data-task-history]');

  await expect(history.getByRole('heading', { name: /History/ })).toContainText('2');
  const versions = history.locator('[data-task-version]');
  await expect(versions).toHaveCount(2);
  await expect(versions.nth(0)).toContainText('Visitor edited the note');
  await expect(versions.nth(0)).toContainText('The price is cut.');
  await expect(versions.nth(1)).toContainText('Ben Martin edited the note');
  await expect(versions.nth(1)).toContainText('The price of the plan is cut.');
  // The text of now is the note's, above.
  await expect(panel.locator('h2')).toHaveText(NOTE.text);
  const results = await new AxeBuilder({ page }).include('[data-task-panel]').analyze();
  expect(results.violations.map((each) => each.id)).toEqual([]);

  // A note with no version draws no section.
  await page.goto(`${CONSOLE}/w/w1/notes?task=n2`);
  const other = page.getByRole('dialog', { name: /The logo is blurry/ });
  await expect(other.locator('[data-task-replies]')).toBeVisible();
  await expect(other.locator('[data-task-history]')).toHaveCount(0);
});

test('reads the history in French (FRU-704)', async ({ page }) => {
  await worker(page, 'fr');
  await page.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const history = page.locator('[data-task-history]');

  await expect(history.getByRole('heading', { name: /Historique/ })).toBeVisible();
  await expect(history.locator('[data-task-version]').nth(1)).toContainText('Ben Martin a modifié la note');
  await expect(history.locator('[data-task-version]').nth(1)).toContainText('Avant');
});
