import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, fulfillSites, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The tab « Access » of a site (FRU-703), as the mockup « Onglet Access » draws it: the levels of
 * « Public access », the table « What a visitor can do », how a visitor is recognised, and what a
 * visitor sees. The worker is answered by stubs; the sample data is of nobody. What the worker does
 * with each value is held by its own tests (`site-access.test.ts`, `visitor.test.ts`).
 */
const CONSOLE = 'http://localhost:5178';

const SITES = [
  // Members read it and anybody writes: no level, « Custom » (FRU-330 called it « Anyone on the page »).
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members', writers: 'anyone', notifyDone: false },
  // A new site of FRU-703: « Contribute », what the mockup chooses.
  {
    id: 's2',
    origin: 'https://acme.dev',
    visibility: 'everyone',
    writers: 'anyone',
    visitorEdit: 'while-open',
    visitorDelete: 'while-open',
    notifyDone: false,
  },
];

type Worker = { posted: Record<string, unknown>[]; refuses?: string; answersAnother?: boolean; ofBefore?: boolean };

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { posted: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    // The worker answers the site that exists to the add of its address, changed (FRU-504).
    if (pathname === '/console/workspaces/w1/sites' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      worker.posted.push(body);
      if (worker.refuses !== undefined) return json({ error: worker.refuses }, 403);
      const site = SITES.find((each) => each.origin === body.url);
      // Another site than the one of the page: this one was not changed.
      if (worker.answersAnother === true) return json({ ...site, ...body, id: 'another', origin: body.url }, 201);
      // A worker of before FRU-703 keeps no right of a visitor, and answers none.
      if (worker.ofBefore === true) {
        const { visitorEdit: _edit, visitorDelete: _delete, ...kept }: Record<string, unknown> = { ...site, ...body };

        return json({ ...kept, id: site?.id ?? 'new', origin: body.url }, 201);
      }

      return json({ ...site, ...body, id: site?.id ?? 'new', origin: body.url }, 201);
    }
    if (route.request().method() === 'GET' && /^\/console\/workspaces\/w1\/sites\/\w+$/.test(pathname)) {
      return fulfillSites(route, SITES) || undefined;
    }

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const levels = (page: Page) => card(page, 'Public access').getByRole('radiogroup', { name: 'Public access' });
const rights = (page: Page) => card(page, 'What a visitor can do');
/** The words of each row of the table: the action, then its two cells. */
const rows = (page: Page) =>
  rights(page)
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) =>
        // A list says the value on its button; its label is for a screen reader.
        [...tr.querySelectorAll('th, td')].map((cell) =>
          ((cell.querySelector('button') ?? (cell as HTMLElement)) as HTMLElement).innerText.trim(),
        ),
      ),
    );

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('an owner reaches the tab from the page of a site, and reads its access as the worker keeps it', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  // FRU-689: « Change » on the row of who sees the notes leads to the tab.
  await page.getByRole('link', { name: 'Change who sees the notes of staging.acme.dev' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/access`);

  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  const tabs = page.getByRole('navigation', { name: 'Sections of the site' });
  await expect(tabs.getByRole('link')).toHaveText([
    'Overview',
    'Install',
    'Destinations',
    'Statuses',
    'Access',
    'Advanced',
  ]);
  await expect(tabs.getByRole('link', { name: 'Access' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main h2')).toHaveText([
    'Public access',
    'What a visitor can do',
    'How a visitor is recognised',
    'What a visitor sees',
    'After a note',
  ]);
  await expect(card(page, 'Public access')).toContainText('Anyone on staging.acme.dev');

  // Members read it and anybody writes: no level is that, so no card is checked, and the table says « Custom ».
  for (const name of ['Closed', 'Read only', 'Contribute', 'Collaborate']) {
    await expect(levels(page).getByRole('radio', { name })).not.toBeChecked();
  }
  await expect(levels(page).getByRole('radio', { name: 'Collaborate' })).toBeDisabled();
  await expect(rights(page).getByRole('heading')).toHaveText('What a visitor can do');
  await expect(rights(page)).toContainText('Custom');
  expect(await rows(page)).toEqual([
    ['See notes', 'Hidden', 'Hidden'],
    ['Leave a note', 'Allowed', 'n/a'],
    ['Reply', 'Never', 'Never'],
    // A worker of before FRU-703 sends no right: a visitor could do neither.
    ['Edit the text', 'Never', 'Never'],
    ['Delete', 'Never', 'Never'],
    ['Change the status', 'Never', 'Never'],
    ['See the tracker and assignee', 'Hidden', 'Hidden'],
  ]);
  // The browser is the one way today; the two others are drawn and not chosen.
  const ways = card(page, 'How a visitor is recognised').getByRole('radio');
  await expect(ways).toHaveCount(3);
  await expect(ways.nth(0)).toBeChecked();
  await expect(ways.nth(1)).toBeDisabled();
  await expect(ways.nth(2)).toBeDisabled();
  await expect(card(page, 'What a visitor sees')).toContainText('A visitor leaves a note and cannot read it back.');
  await expectNoViolation(page, 'the tab « Access »');

  // « Overview » leads back to what the page showed.
  await tabs.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1`);
  expect(worker.posted).toEqual([]);
});

test('a level fills the table, a cell changed says « Custom », and « Save » sends what is shown (FRU-703)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1/access`);

  await levels(page).getByText('Contribute', { exact: true }).click();
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).toBeChecked();
  await expect(rights(page)).toContainText('Contribute');
  expect(await rows(page)).toEqual([
    ['See notes', 'All notes', 'All notes'],
    ['Leave a note', 'Allowed', 'n/a'],
    ['Reply', 'Allowed', 'Allowed'],
    ['Edit the text', 'While open', 'Never'],
    ['Delete', 'While open', 'Never'],
    ['Change the status', 'Never', 'Never'],
    ['See the tracker and assignee', 'All notes', 'All notes'],
  ]);
  const preview = card(page, 'What a visitor sees');
  await expect(preview.locator('[data-preview-action]')).toHaveCount(2);
  await expect(preview).toContainText('Editable while the note is open');

  // One cell changed: no level is that any more. « Allowed », at any time, is not offered (FRU-699).
  await rights(page)
    .getByRole('button', { name: /Delete their own notes/ })
    .click();
  const deletes = page.getByRole('listbox', { name: 'Delete their own notes' });
  await expect(deletes.getByRole('option')).toHaveText(['Never', 'While open']);
  await deletes.getByRole('option', { name: 'Never' }).click();
  await expect(rights(page)).toContainText('Custom');
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).not.toBeChecked();
  await expect(preview.locator('[data-preview-action]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Save the access of staging.acme.dev' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. The script on the site stays the same.');
  expect(worker.posted).toEqual([
    {
      url: 'https://staging.acme.dev',
      visibility: 'everyone',
      writers: 'anyone',
      visitorEdit: 'while-open',
      visitorDelete: 'never',
      notifyDone: false,
    },
  ]);

  // « Save » with nothing changed asks nothing of the worker.
  await page.getByRole('button', { name: 'Save the access of staging.acme.dev' }).click();
  expect(worker.posted).toHaveLength(1);
});

test('« Read only » and « Closed » store « Never » for what a visitor does, and send no e-mail', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s2/access`);
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).toBeChecked();
  await expect(card(page, 'After a note')).toBeVisible();

  await levels(page).getByText('Read only', { exact: true }).click();
  expect(await rows(page)).toEqual([
    ['See notes', 'All notes', 'All notes'],
    ['Leave a note', 'Never', 'n/a'],
    ['Reply', 'Never', 'Never'],
    ['Edit the text', 'Never', 'Never'],
    ['Delete', 'Never', 'Never'],
    ['Change the status', 'Never', 'Never'],
    ['See the tracker and assignee', 'All notes', 'All notes'],
  ]);
  // No note of a visitor there: no list of their rights, no e-mail, and no « Reply » in the preview.
  await expect(rights(page).getByRole('button', { name: /their own notes/ })).toHaveCount(0);
  await expect(card(page, 'After a note')).toHaveCount(0);
  await expect(card(page, 'What a visitor sees')).toContainText('A visitor reads the notes and leaves none.');
  await expect(card(page, 'What a visitor sees').getByText('Reply', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save the access of acme.dev' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. The script on the site stays the same.');
  expect(worker.posted.at(-1)).toEqual({
    url: 'https://acme.dev',
    visibility: 'everyone',
    writers: 'members',
    visitorEdit: 'never',
    visitorDelete: 'never',
  });

  await levels(page).getByText('Closed', { exact: true }).click();
  await expect(card(page, 'What a visitor sees')).toContainText('A visitor sees no note and leaves none.');
  await page.getByRole('button', { name: 'Save the access of acme.dev' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. The script on the site stays the same.');
  expect(worker.posted.at(-1)).toEqual({
    url: 'https://acme.dev',
    visibility: 'members',
    writers: 'members',
    visitorEdit: 'never',
    visitorDelete: 'never',
  });
});

test('« Offer visitors an e-mail when their note is done » is sent where anybody leaves a note (FRU-604)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s2/access`);
  const offer = card(page, 'After a note').getByRole('switch', { name: /Offer visitors an e-mail/ });
  await expect(offer).not.toBeChecked();
  await card(page, 'After a note')
    .getByText('Offer visitors an e-mail when their note is done', { exact: true })
    .click();
  await expect(offer).toBeChecked();
  // The switch is no level: the table still says « Contribute ».
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).toBeChecked();
  await page.getByRole('button', { name: 'Save the access of acme.dev' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. The script on the site stays the same.');
  expect(worker.posted.at(-1)).toMatchObject({ writers: 'anyone', notifyDone: true });
});

test('a refusal says why and keeps what was chosen, and a member reads the tab with nothing to change', async ({
  page,
}) => {
  const worker = await workerWith(page, 'admin');
  worker.refuses = 'forbidden';
  await page.goto(`${CONSOLE}/w/w1/sites/s1/access`);
  await levels(page).getByText('Closed', { exact: true }).click();
  await page.getByRole('button', { name: 'Save the access of staging.acme.dev' }).click();
  await expect(page.locator('main')).toContainText(
    'Only an owner or an admin of the workspace changes who sees the notes.',
  );
  await expect(levels(page).getByRole('radio', { name: 'Closed' })).toBeChecked();

  // An answer that is another site: the page says it did not change, and keeps what was chosen.
  worker.refuses = undefined;
  worker.answersAnother = true;
  await levels(page).getByText('Read only', { exact: true }).click();
  await page.getByRole('button', { name: 'Save the access of staging.acme.dev' }).click();
  await expect(page.locator('main')).toContainText('Who sees the notes did not change. Try again.');
  await expect(levels(page).getByRole('radio', { name: 'Read only' })).toBeChecked();
  await expect(page.getByRole('status')).toHaveCount(0);
  // A worker that answers the site without the rights it was sent did not keep them: said the same way.
  worker.answersAnother = false;
  worker.ofBefore = true;
  await levels(page).getByText('Contribute', { exact: true }).click();
  await page.getByRole('button', { name: 'Save the access of staging.acme.dev' }).click();
  await expect(page.locator('main')).toContainText('Who sees the notes did not change. Try again.');
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).toBeChecked();
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/sites/s2/access`);
  await expect(page.locator('main')).toContainText(
    'Only an owner or an admin of the workspace changes the access of a site.',
  );
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  for (const name of ['Closed', 'Read only', 'Contribute', 'Collaborate']) {
    await expect(levels(page).getByRole('radio', { name })).toBeDisabled();
  }
  await expect(levels(page).getByRole('radio', { name: 'Contribute' })).toBeChecked();
  await expect(card(page, 'After a note').getByRole('switch')).toBeDisabled();
  // The overview shows no way to change it either: its one « Change » leads to « Install » (FRU-689).
  await page.goto(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.locator('a[href$="/access"]').filter({ hasText: 'Change' })).toHaveCount(0);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing of the tab « Access » scrolls sideways but the table in its frame, in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await page.goto(`${CONSOLE}/w/w1/sites/s2/access`);
    await expect(page.locator('main h1')).toHaveText('acme.dev');
    await expect(page.locator('[data-access-card="visitor-preview"]')).toBeVisible();
    expect.soft(await sideScroll(page)).toBe(0);
    await expectNoViolation(page, `the tab « Access » at 390 px, ${locale}`);
  });
}

test('the row of a « Read only » site on the Sites screen says that only members leave notes (FRU-703)', async ({
  page,
}) => {
  await stubWorker(page, {
    workspaces: [ACME],
    sites: [
      { id: 's1', origin: 'https://docs.acme.dev', visibility: 'everyone', writers: 'members' },
      { id: 's2', origin: 'https://acme.dev', visibility: 'everyone', writers: 'anyone' },
    ],
  });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const rowOf = (name: string) =>
    page
      .locator('tbody[data-site]')
      .filter({ has: page.locator('th[scope="row"]').getByRole('link', { name, exact: true }) })
      .locator('[data-column="who"]');
  await expect(rowOf('docs.acme.dev').locator('.sr-only').last()).toHaveText('Notes from members only');
  await expect(rowOf('docs.acme.dev').locator('svg[data-access="members"]')).toBeVisible();
  await expect(rowOf('acme.dev').getByText('Notes from members only', { exact: true })).toHaveCount(0);
});
