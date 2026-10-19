import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The notes of the instance (FRU-273), against screen 20 of the mockup of 2026-10-13
 * (`20-admin-notes-and-where-they-went.html`), read-only. The worker is answered by stubs, with the
 * shapes of `adminNoteView` of `instance-admin.ts` (FRU-272).
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */
const CONSOLE = 'http://localhost:5178';
const HOUR = 60 * 60_000;

/** A note Fruitback keeps: its whole text, longer than the 64 characters of its excerpt. */
const KEPT_TEXT =
  'The order form rejects postcodes with a space, and the error under the field says nothing about why.';
const KEPT = {
  id: 's9:n1',
  workspace: { id: 'w9', name: 'Acme support' },
  site: { id: 's9', origin: 'https://support.acme.dev' },
  page: { url: 'https://support.acme.dev/contact', host: 'support.acme.dev', path: '/contact' },
  // Not the first 64 characters of the text: a screen that shows the excerpt of a kept note is seen.
  excerpt: 'An excerpt the screen must not show for a note Fruitback keeps.',
  text: KEPT_TEXT,
  stage: 'seeded',
  channel: 'script',
  author: { kind: 'visitor' },
  place: { kind: 'fruitback' },
  createdAt: new Date(Date.now() - HOUR / 2).toISOString(),
  checkedAt: new Date(Date.now() - HOUR / 2).toISOString(),
};

/** A note that went to Linear: 64 characters, cut, and no text. */
const SENT_EXCERPT = 'The headline runs to three lines on a phone. Could it be shorter';
const SENT = {
  id: 's1:n2',
  workspace: { id: 'w1', name: 'Acme web' },
  site: { id: 's1', origin: 'https://staging.acme.dev' },
  page: { url: 'https://staging.acme.dev/', host: 'staging.acme.dev', path: '/' },
  excerpt: SENT_EXCERPT,
  stage: 'green',
  channel: 'extension',
  author: { kind: 'site' },
  place: { kind: 'linear', connector: 'c1', label: 'Linear · Acme' },
  ref: 'ACM-151',
  url: 'https://linear.app/acme/issue/ACM-151',
  createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  checkedAt: new Date(Date.now() - HOUR).toISOString(),
};

const SEARCHED = ['excerpt', 'page', 'site', 'workspace', 'stage', 'reference'];

type Notes = { notes: unknown[]; total: number; next?: string };

type Options = {
  admin?: boolean;
  locale?: 'en' | 'fr';
  /** The answer of `GET /console/admin/notes` for a query; a number: that status. */
  notes?: (query: URLSearchParams) => Notes | number;
  hold?: Promise<void>;
};

const BOTH: Notes = { notes: [KEPT, SENT], total: 2 };

/** Every request the page sends to the worker, as `METHOD /path?query`. */
function watched(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(WORKER_ORIGIN)) return;
    const url = new URL(request.url());
    sent.push(`${request.method()} ${url.pathname}${url.search}`);
  });

  return sent;
}

async function stub(page: Page, options: Options = {}): Promise<void> {
  const { admin = true, locale = 'en', notes = () => BOTH, hold } = options;
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
    instanceAdmin: admin,
  };
  const answer = (pathname: string, route: Route): Promise<void> | undefined => {
    if (pathname === '/console/me') return route.fulfill({ json: me });
    if (pathname.startsWith('/console/admin') && !admin)
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    if (pathname === '/console/admin/notes')
      return (hold ?? Promise.resolve()).then(() => {
        const found = notes(new URL(route.request().url()).searchParams);

        return typeof found === 'number'
          ? route.fulfill({ status: found, json: { error: 'unavailable' } })
          : route.fulfill({ json: { ...found, searched: SEARCHED } });
      });

    return undefined;
  };
  await stubWorker(page, { locale, answer });
}

const main = (page: Page) => page.locator('main');
const rows = (page: Page) => page.getByRole('table').getByRole('row');

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`${CONSOLE}/admin/notes${query}`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
}

async function axe(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').include('aside.kit-rail').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('an administrator reads every note: the text of a kept note, the excerpt and its line for another', async ({
  page,
}) => {
  await stub(page);
  await open(page);

  const nav = page.getByRole('navigation', { name: 'Instance' });
  await expect(nav.getByRole('link')).toHaveText(['Instance', 'Notes', 'My workspaces']);
  await expect(nav.getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
  await expect(main(page).locator('header')).toContainText(
    'Every note left on this instance, and where it is stored now.',
  );
  await expect(main(page).locator('header')).toContainText(
    'The owners of each workspace see that you read its notes, with your address and the day.',
  );

  const table = page.getByRole('region', { name: 'Notes of the instance' }).getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText([
    'Note',
    'Workspace',
    'Status',
    'Left by',
    'Stored in',
    'When',
  ]);
  await expect(rows(page)).toHaveCount(3);

  // The note Fruitback keeps: its whole text, clamped to two lines, never its excerpt.
  const kept = rows(page).nth(1).getByRole('cell');
  await expect(kept.nth(0)).toContainText(KEPT_TEXT);
  await expect(kept.nth(0)).not.toContainText(KEPT.excerpt);
  await expect(kept.nth(0)).not.toContainText('Fruitback keeps the first 64 characters.');
  await expect(kept.nth(0)).toContainText('support.acme.dev/contact');
  await expect(kept.nth(0).locator('.line-clamp-2')).toHaveText(KEPT_TEXT);
  await expect(kept.nth(1)).toHaveText('Acme support');
  await expect(kept.nth(2)).toHaveText('New');
  await expect(kept.nth(3)).toHaveText('Visitor');
  await expect(kept.nth(4)).toHaveText('In Fruitback');
  await expect(kept.nth(5)).toHaveText('30 min ago');

  // The note that went to Linear: its 64 characters, cut, and the line that says where the rest is.
  const sent = rows(page).nth(2).getByRole('cell');
  await expect(sent.nth(0).locator('.line-clamp-2')).toHaveText(`${SENT_EXCERPT}…`);
  await expect(sent.nth(0)).toContainText('Kept in Linear. Fruitback keeps the first 64 characters.');
  await expect(sent.nth(1)).toHaveText('Acme web');
  await expect(sent.nth(2)).toHaveText('To do');
  await expect(sent.nth(3)).toHaveText('Verified by staging.acme.dev');
  await expect(sent.nth(4)).toContainText('Linear');
  await expect(sent.nth(4).getByRole('link', { name: 'ACM-151' })).toHaveAttribute(
    'href',
    'https://linear.app/acme/issue/ACM-151',
  );

  // Read-only: no « Send again », no deletion.
  for (const name of ['Send again', 'Delete', 'Remove'])
    await expect(main(page).getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Pages of notes' })).toContainText('1 to 2 of 2');

  await axe(page, 'the notes at 1440 px');
});

test('the workspace of the address is chosen, the filters read the list again, and no request writes', async ({
  page,
}) => {
  const sent = watched(page);
  await stub(page, {
    notes: (query) => {
      if (query.get('q') === 'nothing') return { notes: [], total: 0 };
      if (query.get('workspace') === 'w1') return { notes: [SENT], total: 1 };

      return BOTH;
    },
  });
  await open(page, '?workspace=w1');

  await expect(rows(page)).toHaveCount(2);
  expect(sent.find((request) => request.startsWith('GET /console/admin/notes'))).toBe(
    'GET /console/admin/notes?workspace=w1',
  );
  const workspace = main(page).getByRole('button', { name: /Workspace/ });
  await expect(workspace).toContainText('Acme web');
  // No list of the workspaces is read: it would leave a trace in every workspace of the instance.
  expect(sent.filter((request) => request.includes('/console/admin/workspaces'))).toEqual([]);

  // The search reads the list again; a filter that keeps nothing says so, and clears.
  await main(page).getByRole('searchbox', { name: 'Search notes' }).fill('nothing');
  await expect(main(page)).toContainText('No note matches.');
  await main(page).getByRole('button', { name: 'Clear the filters' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page).toHaveURL(`${CONSOLE}/admin/notes`);

  // Every button of the screen is pressed: none of them writes.
  for (const button of await main(page).getByRole('button').all()) {
    if (await button.isEnabled()) await button.click();
    await page.keyboard.press('Escape');
  }
  expect(sent.some((request) => request.startsWith('GET /console/admin/notes'))).toBe(true);
  expect(sent.filter((request) => !request.startsWith('GET ') && !request.startsWith('OPTIONS '))).toEqual([]);
});

test('an account that is not the administrator is sent to the front door, and reads no note', async ({ page }) => {
  const sent = watched(page);
  await stub(page, { admin: false });
  await page.goto(`${CONSOLE}/admin/notes`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(main(page).locator('h1')).toBeVisible();
  expect(sent.filter((request) => request.includes('/console/admin'))).toEqual([]);
});

test('the screen says it is loading, then an instance with no note says so', async ({ page }) => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  await stub(page, { hold, notes: () => ({ notes: [], total: 0 }) });
  await open(page);

  await expect(main(page).getByText('Loading…')).toBeVisible();
  release();
  await expect(main(page)).toContainText('No note on this instance yet.');
  await expect(main(page).getByText('Loading…')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await axe(page, 'an instance with no note');
});

test('a read that failed says so, never « no note », and reads again on « Try again »', async ({ page }) => {
  let status: number | undefined = 503;
  await stub(page, { notes: () => status ?? BOTH });
  await open(page);

  await expect(main(page).getByRole('alert')).toContainText('The notes did not load');
  await expect(main(page)).not.toContainText('No note on this instance yet.');
  await axe(page, 'a read that failed');
  status = undefined;
  await main(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(main(page).getByRole('alert')).toHaveCount(0);
});

test('in French, every sentence of the screen is French', async ({ page }) => {
  await stub(page, { locale: 'fr' });
  await page.goto(`${CONSOLE}/admin/notes`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);

  await expect(main(page)).toContainText('Chaque note laissée sur cette instance, et où elle est gardée maintenant.');
  await expect(main(page)).toContainText(
    'Les propriétaires de chaque workspace voient que vous avez lu ses notes, avec votre adresse et le jour.',
  );
  await expect(main(page)).toContainText('Gardée dans Linear. Fruitback garde les 64 premiers caractères.');
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveText([
    'Note',
    'Workspace',
    'Statut',
    'Laissée par',
    'Gardée dans',
    'Quand',
  ]);
  await expect(main(page).getByRole('searchbox')).toHaveAttribute(
    'placeholder',
    'Chercher le texte, la page, le site, le workspace, le statut ou la référence',
  );

  const english = [
    'Every note left',
    'The owners of',
    'Kept in',
    'first 64 characters',
    'Stored in',
    'Left by',
    'Every workspace',
    'Any status',
    'Visitor',
    'Verified by',
    'In Fruitback',
    'To do',
    'min ago',
    'Previous',
    'My workspaces',
  ];
  const text = (await page.locator('body').innerText()).replaceAll('\n', ' ');
  expect(english.filter((sentence) => text.includes(sentence))).toEqual([]);
});

test('at 390 px the document does not scroll sideways, and axe finds nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stub(page);
  await open(page);
  await expect(rows(page)).toHaveCount(3);

  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the notes at 390 px');
});
