import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The statuses of a site (FRU-371), against the board `design/site-statuses/` and the API of FRU-366:
 * the list of the worker store, editing with the contrast of the text, adding, ordering by keyboard,
 * deleting an empty status and one that holds notes, a GitHub and a Linear destination, 390 px in
 * French, the roles, and axe. The worker is answered by stubs, which keep what the console sent.
 */
const CONSOLE = 'http://localhost:5178';
const STATUSES = '/console/workspaces/w1/sites/s1/statuses';

type Row = {
  source: string;
  key: string;
  name: string | null;
  stage: string;
  color: string | null;
  textColor: string | null;
  position: number;
  origin: 'tracker' | 'team';
  hidden: boolean;
};
type Sent = { method: string; path: string; body: unknown };

const row = (fields: Partial<Row> & Pick<Row, 'key' | 'stage'>): Row => ({
  source: 'own',
  name: null,
  color: null,
  textColor: null,
  position: 0,
  origin: 'tracker',
  hidden: false,
  ...fields,
});

/** The rows of the board, frame A: « Won't fix » for the closed built-in, and two statuses of the team. */
const ROWS: Row[] = [
  row({ key: 'closed', stage: 'closed', name: 'Won’t fix', position: 4 }),
  row({ key: 'waiting', stage: 'todo', name: 'Waiting for client', color: '#7dd3fc', origin: 'team', position: 5 }),
  row({
    key: 'legal',
    stage: 'progress',
    name: "Waiting for the client's legal team to approve the new wording",
    color: '#8b5cf6',
    origin: 'team',
    position: 6,
  }),
];

const SITE = { id: 's1', origin: 'https://preview.client.fr', visibility: 'members' };

type Worker = {
  sent: Sent[];
  rows: Row[];
  deleteAnswer?: (path: string) => { status: number; json: unknown };
  /** Holds the answer to a written status this long, in ms: a write that is still on its way. */
  slow?: number;
};

async function workerWith(
  page: Page,
  options: {
    role?: Role;
    locale?: 'en' | 'fr';
    site?: unknown;
    connectors?: unknown[];
    rows?: Row[];
    /** What `GET …/statuses/tracker` answers (FRU-368). */
    tracker?: unknown;
  } = {},
): Promise<Worker> {
  const worker: Worker = { sent: [], rows: [...(options.rows ?? ROWS)] };
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const method = request.method();
    if (pathname === '/console/workspaces/w1/connectors')
      return route.fulfill({ json: { connectors: options.connectors ?? [], available: true } });
    if (!pathname.startsWith(STATUSES)) return undefined;
    const path = `${pathname}${new URL(request.url()).search}`;
    if (pathname === `${STATUSES}/tracker`)
      return route.fulfill({ json: options.tracker ?? { trackerColours: false, trackers: [] } });
    if (method === 'GET') return route.fulfill({ json: { statuses: worker.rows } });
    const body = method === 'POST' ? request.postDataJSON() : undefined;
    worker.sent.push({ method, path, body });
    if (method === 'DELETE') {
      const answered = worker.deleteAnswer?.(path) ?? { status: 200, json: { moved: 0 } };
      if (answered.status === 200) {
        const key = decodeURIComponent(pathname.split('/').at(-1) ?? '');
        worker.rows = worker.rows.filter((each) => each.key !== key);
      }

      return route.fulfill(answered);
    }
    if (pathname === `${STATUSES}/order` || pathname === `${STATUSES}/settings`) return route.fulfill({ json: body });
    const kept = body as Row;
    const write = () => {
      worker.rows = [...worker.rows.filter((each) => each.key !== kept.key || each.source !== kept.source), kept];

      return route.fulfill({ json: { status: kept } });
    };

    return worker.slow === undefined ? write() : new Promise((resolve) => setTimeout(resolve, worker.slow)).then(write);
  };
  await stubWorker(page, {
    locale: options.locale ?? 'en',
    workspaces: [{ ...ACME, role: options.role ?? 'owner' }],
    sites: [options.site ?? SITE],
    answer,
  });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites/s1/statuses`);
  await expect(page.locator('main h1')).toBeVisible();
}

const list = (page: Page) => page.locator('main ol').first();
const item = (page: Page, key: string) => page.locator(`[data-status-key="${key}"]`);

/**
 * axe on the page. `[data-sample]` is the preview of the editor: a picture of the colours being chosen,
 * hidden from a screen reader, which shows a text under 4.5:1 on purpose before the screen refuses it.
 * The sentence beside it says the ratio; the test of the editor reads both.
 */
async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').exclude('[data-sample]').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('lists the five built-in statuses and the ones of the team, with stage, colour and the contrast of the text', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuses');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('preview.client.fr');
  await expect(list(page).locator('> li')).toHaveCount(7);
  const keys = await list(page)
    .locator('> li')
    .evaluateAll((items) => items.map((each) => each.getAttribute('data-status-key')));
  expect(keys).toEqual(['new', 'todo', 'progress', 'done', 'closed', 'waiting', 'legal']);

  // A built-in: its word, « Built in », the colour of its stage, the text computed (9.90:1 on new).
  await expect(item(page, 'new')).toContainText('Built in');
  await expect(item(page, 'new')).toContainText('Colour of the stage');
  await expect(item(page, 'new')).toContainText('Auto · 9.90:1');
  await expect(item(page, 'new').getByRole('button', { name: 'Reset New' })).toHaveCount(0);
  // A built-in that changed can be reset, never deleted; a status of the team is deleted, never reset.
  await expect(item(page, 'closed').getByRole('button', { name: 'Reset Won’t fix' })).toBeVisible();
  await expect(item(page, 'closed').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  await expect(item(page, 'waiting')).toContainText('Added by your team');
  await expect(item(page, 'waiting')).toContainText('#7dd3fc');
  await expect(item(page, 'waiting')).toContainText('Auto · 10.63:1');
  await expect(item(page, 'waiting').getByRole('button', { name: 'Delete Waiting for client' })).toBeVisible();
  // #8b5cf6 takes black, the last step of readableTextColor: 4.96:1.
  await expect(item(page, 'legal')).toContainText('Auto · 4.96:1');
  // The first has no « up », the last no « down ».
  await expect(item(page, 'new').getByRole('button', { name: 'Move New up' })).toBeDisabled();
  await expect(item(page, 'legal').getByRole('button', { name: /down$/ })).toBeDisabled();

  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the list at 1440 px');
});

test('an edit shows the contrast, refuses a text under 4.5:1 without sending it, and writes one status', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  await item(page, 'waiting').getByRole('button', { name: 'Edit Waiting for client' }).click();
  const editor = page.getByRole('region', { name: 'Edit Waiting for client' });
  await expect(editor.getByRole('heading', { name: 'Edit Waiting for client' })).toBeFocused();
  await expect(editor.getByRole('status')).toHaveText('Text on this colour: 10.63:1. It reads well.');

  const colour = editor.getByRole('textbox', { name: 'Hex code of the colour' });
  await colour.fill('#0ea5e9');
  // The radio of HeroUI is pressed by its label, as a person does: the input itself is drawn under it.
  await editor.getByText('Your colour', { exact: true }).nth(1).click();
  await expect(editor.getByRole('radio', { name: 'Your colour' }).nth(1)).toBeChecked();
  await editor.getByRole('textbox', { name: 'Hex code of the text' }).fill('#ffffff');
  await expect(editor.getByRole('status')).toHaveText(
    'Text on this colour: 2.77:1. Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.',
  );
  await expectNoViolation(page, 'the editor, a text under 4.5:1');

  await editor.getByRole('button', { name: 'Save' }).click();
  const text = editor.getByRole('textbox', { name: 'Hex code of the text' });
  await expect(text).toBeFocused();
  await expect(text).toHaveAttribute('aria-invalid', 'true');
  expect(worker.sent).toEqual([]);

  await editor.getByText('Auto: dark or white, whichever reads better', { exact: true }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  expect(worker.sent).toEqual([
    {
      method: 'POST',
      path: STATUSES,
      body: row({
        key: 'waiting',
        stage: 'todo',
        name: 'Waiting for client',
        color: '#0ea5e9',
        origin: 'team',
        position: 5,
      }),
    },
  ]);
  await expect(item(page, 'waiting')).toContainText('#0ea5e9');
  await expect(item(page, 'waiting').getByRole('button', { name: 'Edit Waiting for client' })).toBeFocused();
});

test('a text colour of the team goes with a colour of the team: on the colour of a stage, the text is Auto', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  await item(page, 'waiting').getByRole('button', { name: 'Edit Waiting for client' }).click();
  const editor = page.getByRole('region', { name: 'Edit Waiting for client' });
  await editor.getByText('Your colour', { exact: true }).nth(1).click();
  await editor.getByRole('textbox', { name: 'Hex code of the text' }).fill('#000000');
  // Back to the colour of the stage: the text goes back to Auto, and cannot be chosen.
  await editor.getByText('Colour of the stage', { exact: true }).click();
  await expect(editor.getByRole('radio', { name: 'Auto: dark or white, whichever reads better' })).toBeChecked();
  await expect(editor.getByRole('radio', { name: 'Your colour' }).nth(1)).toBeDisabled();
  await expect(editor.getByText('A text colour of your own goes with a colour of your own.')).toBeVisible();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  // What the worker takes: no text colour without a colour (`text-without-color`).
  expect(worker.sent.at(-1)?.body).toEqual(
    row({ key: 'waiting', stage: 'todo', name: 'Waiting for client', origin: 'team', position: 5 }),
  );
});

test('a built-in status keeps its stage, and Escape closes the editor with focus back on « Edit »', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);

  await item(page, 'todo').getByRole('button', { name: 'Edit To do' }).click();
  const editor = page.getByRole('region', { name: 'Edit To do' });
  await expect(editor.getByText('A built-in status keeps its stage')).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveAttribute('placeholder', 'To do');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(item(page, 'todo').getByRole('button', { name: 'Edit To do' })).toBeFocused();
});

test('adds a status: its name first, a key made of it, at the end of the list', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);

  await page.getByRole('button', { name: 'Add a status' }).click();
  const editor = page.getByRole('region', { name: 'Add a status' });
  const name = editor.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await editor.getByRole('button', { name: 'Add the status' }).click();
  await expect(name).toBeFocused();
  await expect(editor).toContainText('Give the status a name.');
  expect(worker.sent).toEqual([]);

  await name.fill('In review');
  await editor.getByRole('button', { name: 'Add the status' }).click();
  await expect(editor).toHaveCount(0);
  expect(worker.sent.at(-1)).toEqual({
    method: 'POST',
    path: STATUSES,
    body: row({ key: 'in-review', stage: 'todo', name: 'In review', origin: 'team', position: 7 }),
  });
  await expect(item(page, 'in-review')).toContainText('In review');
  await expect(page.locator('main [aria-live="polite"]')).toHaveText('« In review » was added.');
});

test('moves a status with the keyboard: the order is written whole, said, and focus stays on the row', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  const up = item(page, 'waiting').getByRole('button', { name: 'Move Waiting for client up' });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main [aria-live="polite"]')).toHaveText('Waiting for client is now 5 of 7.');
  const keys = await list(page)
    .locator('> li')
    .evaluateAll((items) => items.map((each) => each.getAttribute('data-status-key')));
  expect(keys).toEqual(['new', 'todo', 'progress', 'done', 'waiting', 'closed', 'legal']);
  await expect(up).toBeFocused();

  // The defaults with no row get one first, at their place; then the order of the whole list.
  expect(worker.sent.map((each) => [each.method, each.path, (each.body as Row | undefined)?.key])).toEqual([
    ['POST', STATUSES, 'new'],
    ['POST', STATUSES, 'todo'],
    ['POST', STATUSES, 'progress'],
    ['POST', STATUSES, 'done'],
    ['POST', `${STATUSES}/order`, undefined],
  ]);
  expect(worker.sent.at(-1)?.body).toEqual({
    order: ['new', 'todo', 'progress', 'done', 'waiting', 'closed', 'legal'].map((key) => ({ source: 'own', key })),
  });

  // To the top: « up » is disabled there, and focus goes to « down » of the same row.
  for (let step = 0; step < 4; step += 1) {
    // Focus comes back to the button once the order is written: a press before that goes nowhere.
    await expect(up).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main [aria-live="polite"]')).toHaveText(`Waiting for client is now ${4 - step} of 7.`);
  }
  await expect(item(page, 'waiting').getByRole('button', { name: 'Move Waiting for client down' })).toBeFocused();
});

test('two presses in one moment write once: the lock is taken before the first answer', async ({ page }) => {
  const worker = await workerWith(page, {
    rows: ROWS.map((each) => ({ ...each })).concat(
      ['new', 'todo', 'progress', 'done'].map((key, position) => row({ key, stage: key, position })),
    ),
  });
  await open(page);

  // Both clicks land before React draws again, so both see the controls enabled (lite review of #493).
  await item(page, 'todo')
    .getByRole('button', { name: 'Move To do down' })
    .evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });
  await expect(page.locator('main [aria-live="polite"]')).toHaveText('To do is now 3 of 7.');
  await page.waitForTimeout(300);
  expect(worker.sent.map((each) => each.path)).toEqual([`${STATUSES}/order`]);
});

test('two presses on « Save » in one moment write once, and the editor closes only on the answer', async ({ page }) => {
  const worker = await workerWith(page);
  worker.slow = 1500;
  await open(page);

  await item(page, 'waiting').getByRole('button', { name: 'Edit Waiting for client' }).click();
  const editor = page.getByRole('region', { name: 'Edit Waiting for client' });
  await editor.getByRole('textbox', { name: 'Name' }).fill('Waiting for the client');
  // The second press finds the lock taken: it sends nothing and closes nothing (lite review of PR 493).
  await editor.getByRole('button', { name: 'Save' }).evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  // While the first write is on its way, the editor stays, with what was typed.
  await page.waitForTimeout(500);
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Waiting for the client');
  await expect(editor).toHaveCount(1);
  await expect(editor).toHaveCount(0);
  await expect(item(page, 'waiting')).toContainText('Waiting for the client');
  await page.waitForTimeout(300);
  expect(worker.sent.map((each) => [each.method, (each.body as Row).name])).toEqual([
    ['POST', 'Waiting for the client'],
  ]);
});

test('deletes an empty status after asking twice', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);

  await item(page, 'legal')
    .getByRole('button', { name: /^Delete Waiting for the client's legal/ })
    .click();
  const confirm = page.getByRole('group', { name: /^Delete Waiting for the client's legal/ });
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirm.getByRole('button', { name: /^Delete/ }).click();
  await expect(item(page, 'legal')).toHaveCount(0);
  expect(worker.sent).toEqual([{ method: 'DELETE', path: `${STATUSES}/own/legal`, body: undefined }]);
  await expect(page.locator('main [aria-live="polite"]')).toContainText('was deleted.');
});

test('a status that holds notes asks where they go, the built-in of its stage first, then moves them', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.deleteAnswer = (path) =>
    path.includes('moveTo=')
      ? { status: 200, json: { moved: 12 } }
      : { status: 409, json: { error: 'status-in-use', notes: 12 } };
  await open(page);

  await item(page, 'waiting').getByRole('button', { name: 'Delete Waiting for client' }).click();
  await page
    .getByRole('group', { name: 'Delete Waiting for client' })
    .getByRole('button', { name: 'Delete Waiting for client' })
    .click();
  const move = page.getByRole('group', { name: 'Delete Waiting for client' });
  await expect(move).toContainText('12 notes are in « Waiting for client ».');
  await expect(move.getByRole('radio').first()).toBeChecked();
  await expect(move.getByRole('radio').first()).toHaveAccessibleName('To do · To do');
  await expect(move.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await expectNoViolation(page, 'the move of the notes');

  await move.getByRole('button', { name: 'Move 12 notes and delete' }).click();
  await expect(item(page, 'waiting')).toHaveCount(0);
  expect(worker.sent.map((each) => each.path)).toEqual([
    `${STATUSES}/own/waiting`,
    `${STATUSES}/own/waiting?moveTo=todo`,
  ]);
  await expect(page.locator('main [aria-live="polite"]')).toHaveText(
    '« Waiting for client » was deleted, and its notes are in « To do ».',
  );
});

test('a site that sends to GitHub shows its four states, beside a Linear list that could not be read', async ({
  page,
}) => {
  const github = { connector: 'g1', label: 'GitHub · acme/website' };
  const linear = { connector: 'l1', teamId: 't1', label: 'Linear · Acme web' };
  const worker = await workerWith(page, {
    site: { ...SITE, destinations: [github, linear], destination: github },
    connectors: [
      { id: 'g1', kind: 'github', label: 'GitHub', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'l1', kind: 'linear', label: 'Linear', createdAt: '2026-10-01T00:00:00Z' },
    ],
    rows: [row({ source: 'g1', key: 'closed:completed', stage: 'done', name: 'Fixed', color: '#15803d', position: 1 })],
  });
  await open(page);

  // No list of the worker store: the notes go to GitHub and Linear.
  await expect(page.getByRole('heading', { name: 'Notes kept in Fruitback' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a status' })).toHaveCount(0);
  const section = page.getByRole('region', { name: 'GitHub · acme/website' });
  await expect(section.locator('ol > li')).toHaveCount(4);
  await expect(item(page, 'closed:completed')).toContainText('Fixed');
  await expect(item(page, 'closed:completed')).toContainText('In GitHub: Closed as completed');
  await expect(item(page, 'closed:not_planned').getByRole('button', { name: /^Delete/ })).toHaveCount(0);

  // With no state of Linear read (the stub answers none), the Linear list says so (FRU-368).
  const linearSection = page.getByRole('region', { name: 'Linear · Acme web' });
  await expect(linearSection.getByRole('alert')).toContainText('Fruitback could not read the states of Linear.');

  // A GitHub state is re-staged; its row says its source.
  await item(page, 'open').getByRole('button', { name: 'Edit Open' }).click();
  const editor = page.getByRole('region', { name: 'Edit Open' });
  await editor.getByRole('button', { name: /Stage/ }).click();
  await page.getByRole('option', { name: 'To do' }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  expect(worker.sent.at(-1)?.body).toEqual(row({ source: 'g1', key: 'open', stage: 'todo', position: 0 }));
  await expectNoViolation(page, 'GitHub and Linear');
});

test('a site that sends to two repositories of one GitHub connector has one list of its four states (FRU-369)', async ({
  page,
}) => {
  const site = { connector: 'g1', teamId: 'acme/website', label: 'GitHub · acme/website' };
  const docs = { connector: 'g1', teamId: 'acme/docs', label: 'GitHub · acme/docs' };
  await workerWith(page, {
    site: { ...SITE, destinations: [site, docs], destination: site },
    connectors: [{ id: 'g1', kind: 'github', label: 'acme', createdAt: '2026-10-01T00:00:00Z' }],
    rows: [],
  });
  await open(page);

  // One list, named by both repositories, and the four states once: never two identical lists.
  const list = page.getByRole('region', { name: 'GitHub · acme/website, acme/docs' });
  await expect(list.locator('ol > li')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'GitHub · acme/website', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'GitHub · acme/docs', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-status-key="closed:duplicate"]')).toHaveCount(1);
  await expectNoViolation(page, 'two repositories of one GitHub connector');
});

test('at 390 px in French: one card per status, no sideways scroll, and the words of the phase', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, { locale: 'fr' });
  await open(page);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuts');
  await expect(item(page, 'new')).toContainText('Couleur de la phase');
  await expect(item(page, 'new')).toContainText('Phase');
  await expect(item(page, 'waiting')).toContainText('Auto · 10,63:1');
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the list at 390 px');

  await item(page, 'waiting').getByRole('button', { name: 'Modifier Waiting for client' }).click();
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the editor at 390 px');
});

test('only an owner or an admin sets the statuses, and the menu of a site leads there', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await page.getByRole('button', { name: 'More for https://preview.client.fr' }).click();
  await page.getByRole('menuitem', { name: 'Statuses' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/statuses`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuses');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await workerWith(page, { role: 'member' });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await page.getByRole('button', { name: 'More for https://preview.client.fr' }).click();
  await expect(page.getByRole('menuitem', { name: 'Statuses' })).toHaveCount(0);
  await page.goto(`${CONSOLE}/w/w1/sites/s1/statuses`);
  await expect(page.locator('main')).toContainText(
    'Only an owner or an admin of the workspace sets the statuses of a site.',
  );
});

/** A site that sends to Linear (FRU-368), and the states of its team as the worker reads them. */
const LINEAR_PLACE = { connector: 'l1', teamId: 't1', label: 'Linear · Acme web' };
const LINEAR_SITE = { ...SITE, destination: LINEAR_PLACE, destinations: [LINEAR_PLACE] };
const LINEAR_CONNECTORS = [{ id: 'l1', kind: 'linear', label: 'Linear', createdAt: '2026-10-01T00:00:00Z' }];
const STATES = [
  { id: 'b1', name: 'Backlog', type: 'backlog', stage: 'new', color: '#bec2c8' },
  { id: 't1', name: 'Todo', type: 'unstarted', stage: 'todo', color: '#e2e2e2' },
  { id: 'p1', name: 'In Progress', type: 'started', stage: 'progress', color: '#f2c94c' },
  { id: 'r1', name: 'In Review', type: 'started', stage: 'progress', color: '#0f783c' },
  { id: 'd1', name: 'Done', type: 'completed', stage: 'done', color: '#5e6ad2' },
  { id: 'c1', name: 'Canceled', type: 'canceled', stage: 'closed', color: '#95a2b3' },
];

test('a site that sends to Linear lists the states of its team, takes their colours when asked, and re-stages one', async ({
  page,
}) => {
  const worker = await workerWith(page, {
    site: LINEAR_SITE,
    connectors: LINEAR_CONNECTORS,
    rows: [row({ source: 'l1', key: 't1', stage: 'todo', name: 'To do', position: 1 })],
    tracker: { trackerColours: false, trackers: [{ ...LINEAR_PLACE, states: STATES }] },
  });
  await open(page);

  const section = page.getByRole('region', { name: 'Linear · Acme web' });
  await expect(section.locator('ol > li')).toHaveCount(6);
  await expect(item(page, 'b1')).toContainText('In Linear: Backlog');
  await expect(item(page, 'b1')).toContainText('Colour of the stage');
  // A state renamed by the site can be reset; no state of Linear is deleted here.
  await expect(item(page, 't1')).toContainText('In Linear: Todo');
  await expect(item(page, 't1').getByRole('button', { name: 'Reset To do' })).toBeVisible();
  await expect(section.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a status' })).toHaveCount(0);
  await expectNoViolation(page, 'Linear, the colours of the stages');

  // « Use Linear's colours »: written at once, and the states take Linear's colours.
  const toggle = section.getByRole('switch', { name: "Use Linear's colours" });
  await expect(toggle).not.toBeChecked();
  await section.getByText("Use Linear's colours", { exact: true }).click();
  await expect(toggle).toBeChecked();
  expect(worker.sent.at(-1)).toEqual({ method: 'POST', path: `${STATUSES}/settings`, body: { trackerColours: true } });
  await expect(item(page, 'd1')).toContainText("Linear's colour");
  // Linear's Done takes white, 4.70:1 (statuses.md, « The colours »).
  await expect(item(page, 'd1')).toContainText('Auto · 4.70:1');
  await expectNoViolation(page, "Linear, Linear's colours");

  // In Review moves to Done, for this site.
  await item(page, 'r1').getByRole('button', { name: 'Edit In Review' }).click();
  const editor = page.getByRole('region', { name: 'Edit In Review' });
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveAttribute('placeholder', 'In Review');
  await expect(editor.getByText('Empty: the name in Linear, « In Review ».')).toBeVisible();
  await expect(editor.getByText("Linear's colour", { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: /Stage/ }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  expect(worker.sent.at(-1)).toEqual({
    method: 'POST',
    path: STATUSES,
    body: row({ source: 'l1', key: 'r1', stage: 'done', position: 3 }),
  });
  await expect(item(page, 'r1')).toContainText('Done');
});

test('a Linear team that the worker could not read says so, and is read again', async ({ page }) => {
  // The console of development mounts a screen twice, so the stub answers by what Linear can do now.
  let answers = false;
  await workerWith(page, {
    site: LINEAR_SITE,
    connectors: LINEAR_CONNECTORS,
    rows: [],
    get tracker() {
      return !answers
        ? { trackerColours: false, trackers: [{ ...LINEAR_PLACE, error: 'tracker-unreachable' }] }
        : { trackerColours: false, trackers: [{ ...LINEAR_PLACE, states: STATES }] };
    },
  });
  await open(page);

  const section = page.getByRole('region', { name: 'Linear · Acme web' });
  await expect(section.getByRole('alert')).toHaveText(
    'Fruitback could not read the states of Linear. The statuses you set are not lost.',
  );
  answers = true;
  await section.getByRole('button', { name: 'Try again' }).click();
  await expect(section.locator('ol > li')).toHaveCount(6);
});

test('the switch stays when the first Linear team of the site could not be read', async ({ page }) => {
  const other = { connector: 'l2', teamId: 't2', label: 'Linear · Acme docs' };
  await workerWith(page, {
    site: { ...SITE, destination: LINEAR_PLACE, destinations: [LINEAR_PLACE, other] },
    connectors: [
      ...LINEAR_CONNECTORS,
      { id: 'l2', kind: 'linear', label: 'Linear', createdAt: '2026-10-01T00:00:00Z' },
    ],
    rows: [],
    tracker: {
      trackerColours: false,
      trackers: [
        { ...LINEAR_PLACE, error: 'tracker-unreachable' },
        { ...other, states: STATES },
      ],
    },
  });
  await open(page);

  await expect(page.getByRole('region', { name: 'Linear · Acme web' }).getByRole('alert')).toBeVisible();
  await expect(page.getByRole('switch', { name: "Use Linear's colours" })).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Linear · Acme docs' }).getByRole('switch', { name: "Use Linear's colours" }),
  ).toBeVisible();
});

test('the switch is drawn when no Linear team of the site could be read, so it can still be turned off', async ({
  page,
}) => {
  const worker = await workerWith(page, {
    site: LINEAR_SITE,
    connectors: LINEAR_CONNECTORS,
    rows: [],
    tracker: { trackerColours: true, trackers: [{ ...LINEAR_PLACE, error: 'tracker-unreachable' }] },
  });
  await open(page);

  const section = page.getByRole('region', { name: 'Linear · Acme web' });
  await expect(section.getByRole('alert')).toBeVisible();
  const toggle = section.getByRole('switch', { name: "Use Linear's colours" });
  await expect(toggle).toBeChecked();
  await section.getByText("Use Linear's colours", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  expect(worker.sent.at(-1)).toEqual({ method: 'POST', path: `${STATUSES}/settings`, body: { trackerColours: false } });
});

test('a site that sends to two teams of one Linear connector has one list for each team', async ({ page }) => {
  const docs = { connector: 'l1', teamId: 't2', label: 'Linear · Acme docs' };
  await workerWith(page, {
    site: { ...SITE, destination: LINEAR_PLACE, destinations: [LINEAR_PLACE, docs] },
    connectors: LINEAR_CONNECTORS,
    rows: [],
    tracker: {
      trackerColours: false,
      trackers: [
        { ...LINEAR_PLACE, states: STATES },
        {
          ...docs,
          states: [
            { id: 'x1', name: 'Inbox', type: 'triage', stage: 'new' },
            { id: 'x2', name: 'Shipped', type: 'completed', stage: 'done' },
          ],
        },
      ],
    },
  });
  await open(page);

  const web = page.getByRole('region', { name: 'Linear · Acme web' });
  const team = page.getByRole('region', { name: 'Linear · Acme docs' });
  await expect(web.locator('ol > li')).toHaveCount(6);
  await expect(team.locator('ol > li')).toHaveCount(2);
  await expect(team.locator('[data-status-key="x1"]')).toContainText('In Linear: Inbox');
  await expect(web.locator('[data-status-key="x1"]')).toHaveCount(0);
  // One switch for the site, above the first list.
  await expect(page.getByRole('switch', { name: "Use Linear's colours" })).toHaveCount(1);
  await expectNoViolation(page, 'two teams of one connector');
});

test('at 390 px in French, Linear and its switch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, {
    locale: 'fr',
    site: LINEAR_SITE,
    connectors: LINEAR_CONNECTORS,
    rows: [],
    tracker: { trackerColours: true, trackers: [{ ...LINEAR_PLACE, states: STATES }] },
  });
  await open(page);

  await expect(page.getByRole('switch', { name: 'Utiliser les couleurs de Linear' })).toBeChecked();
  await expect(item(page, 'd1')).toContainText('Couleur de Linear');
  await expect(item(page, 'd1')).toContainText('Dans Linear : Done');
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'Linear at 390 px');
});
