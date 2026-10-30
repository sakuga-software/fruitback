import { expect } from '@playwright/test';
import { openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';
import {
  paired,
  inPanel,
  plantOn,
  panelRows,
  axeSource,
  searchRows,
  search,
  clickPanel,
  clickShowOnPage,
} from './side-panel.ts';

/**
 * The side panel, its search and its rows of the whole site (FRU-307, FRU-434). The first half of the
 * specs of the panel is in `side-panel.spec.ts`; `side-panel.ts` holds what both use.
 */

test('« Search and options »: the search, « Whole site » over three pages, the chips, a note of another page, the pins (FRU-307)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  // A word no other spec writes: the whole site holds the notes of every spec of the suite.
  const tag = `zq${Date.now().toString(36)}`;
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-search-a');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', `Search ${tag} espresso`);
  await plantOn(page, '[data-testid="card-latte"] .add', 'A plain note of the first page');
  // Two more pages of the same site, one note each.
  for (const [name, card] of [
    ['side-panel-search-b', 'latte'],
    ['side-panel-search-c', 'mocha'],
  ] as const) {
    const other = await extension.context.newPage();
    await openBareSite(other, name);
    await expect(other.locator('[data-fruitback-host-launch]')).toBeVisible();
    await plantOn(other, `[data-testid="card-${card}"] .add`, `Search ${tag} ${card}`);
    await other.close();
  }
  await page.bringToFront();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect.poll(async () => (await panelRows(page).catch(() => ({ tabs: [], rows: [] }))).rows.length).toBe(2);

  // The magnifier opens the options; the search filters the notes of the page.
  expect(await clickPanel(page, 'button.panel-search')).toBe(true);
  await expect
    .poll(() =>
      inPanel<string | null>(page, `document.querySelector('button.panel-search')?.getAttribute('aria-expanded')`),
    )
    .toBe('true');
  await search(page, tag);
  await expect.poll(async () => (await searchRows(page)).map((row) => row.note)).toEqual([`Search ${tag} espresso`]);

  // « Whole site »: the notes of the three pages, from the worker, the other pages hollow.
  expect(await clickPanel(page, '.search-scope [role="tab"][data-tab="site"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length, { timeout: 15_000 }).toBe(3);
  const site = await searchRows(page);
  expect(site.map((row) => row.note).sort()).toEqual(
    [`Search ${tag} espresso`, `Search ${tag} latte`, `Search ${tag} mocha`].sort(),
  );
  expect(
    site
      .filter((row) => row.hollow)
      .map((row) => row.note)
      .sort(),
  ).toEqual([`Search ${tag} latte`, `Search ${tag} mocha`].sort());
  expect(
    await inPanel<string | null>(page, `document.querySelector('.search-scope [data-tab="site"]')?.textContent`),
  ).toMatch(/ · 3$/);

  // A chip filters, and its count follows the search.
  const chips = () =>
    inPanel<string[]>(
      page,
      `[...document.querySelectorAll('.search-chip')].map((chip) => chip.dataset.stage + ' ' + chip.querySelector('.search-chip-count').textContent)`,
    );
  expect(await chips()).toEqual(['all 3', 'new 3', 'todo 0', 'progress 0', 'done 0']);
  expect(await clickPanel(page, '.search-chip[data-stage="progress"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length).toBe(0);
  expect(await clickPanel(page, '.search-chip[data-stage="new"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length).toBe(3);
  await search(page, `${tag} mocha`);
  await expect.poll(chips, { timeout: 15_000 }).toEqual(['all 1', 'new 1', 'todo 0', 'progress 0', 'done 0']);

  // axe, in the panel, with the options open.
  const violations = await inPanel<{ id: string; nodes: number }[]>(
    page,
    `(async () => {
      ${axeSource()}
      const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.length }));
    })()`,
  );
  expect(violations).toEqual([]);

  // « Show pins on the page »: off hides the pins of the tab, on shows them again.
  expect(await clickPanel(page, '.search-pins [role="switch"]')).toBe(true);
  await expect(page.locator('[data-fruitback-pin]').first()).toBeHidden();
  expect(await clickPanel(page, '.search-pins [role="switch"]')).toBe(true);
  await expect(page.locator('[data-fruitback-pin]').first()).toBeVisible();

  // A note of another page: its page opens in a new tab, and the widget there opens its thread.
  const opened = extension.context.waitForEvent('page');
  expect(await clickPanel(page, '.site-row .panel-row-head', /mocha/)).toBe(true);
  const tab = await opened;
  await expect(tab).toHaveURL(/side-panel-search-c/);
  await expect(tab.getByRole('dialog', { name: /^(Note|Feedback) / })).toContainText(`Search ${tag} mocha`, {
    timeout: 20_000,
  });
  // The panel follows the new tab, with the row of the note open.
  await expect
    .poll(
      async () =>
        (await panelRows(tab).catch(() => ({ rows: [] }))).rows.filter((row) => row.open).map((row) => row.note),
      {
        timeout: 15_000,
      },
    )
    .toEqual([`Search ${tag} mocha`]);
  // The pins hidden from the panel come back when the panel closes (review of #419): the background
  // shows them again once the port of the panel goes, whatever closed it.
  // The thread of the note is closed first: the pin of an open thread stays, as in the list of the
  // page (FRU-308).
  await tab.keyboard.press('Escape');
  await expect(tab.getByRole('dialog', { name: /^(Note|Feedback) / })).toBeHidden();
  expect(await clickPanel(tab, 'button.panel-search')).toBe(true);
  await expect.poll(() => clickPanel(tab, '.search-pins [role="switch"]')).toBe(true);
  await expect(tab.locator('[data-fruitback-pin]').first()).toBeHidden();
  expect(await clickPanel(tab, 'button.panel-close')).toBe(true);
  await expect(tab.locator('[data-fruitback-pin]').first()).toBeVisible({ timeout: 10_000 });
});

test('« Show on the page » of a row of the whole site: another page opens in a new tab on the note, the page of the tab scrolls to it (FRU-434)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const tag = `zl${Date.now().toString(36)}`;
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-link-a');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(page, '[data-testid="card-espresso"] .add', `Link ${tag} here`);
  const other = await extension.context.newPage();
  await openBareSite(other, 'side-panel-link-b');
  await expect(other.locator('[data-fruitback-host-launch]')).toBeVisible();
  await plantOn(other, '[data-testid="card-mocha"] .add', `Link ${tag} elsewhere`);
  await other.close();
  await page.bringToFront();

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect.poll(async () => (await panelRows(page).catch(() => ({ rows: [] }))).rows.length).toBeGreaterThan(0);
  expect(await clickPanel(page, 'button.panel-search')).toBe(true);
  expect(await clickPanel(page, '.search-scope [role="tab"][data-tab="site"]')).toBe(true);
  await search(page, tag);
  await expect.poll(async () => (await searchRows(page)).length, { timeout: 15_000 }).toBe(2);

  // The page of the tab: a button, and the thread of the note opens there, with no new tab.
  const pages = extension.context.pages().length;
  const here = await clickShowOnPage(page, / here$/);
  expect(here).toEqual({ tag: 'BUTTON', href: null });
  await expect(page.getByRole('dialog', { name: /^(Note|Feedback) / })).toContainText(`Link ${tag} here`, {
    timeout: 10_000,
  });
  expect(extension.context.pages().length).toBe(pages);
  await page.keyboard.press('Escape');
  // The row of the page of the tab closes the options and opens its own row, as before (FRU-307).
  await expect
    .poll(() =>
      inPanel<string | null>(page, `document.querySelector('button.panel-search')?.getAttribute('aria-expanded')`),
    )
    .toBe('false');
  expect(await clickPanel(page, 'button.panel-search')).toBe(true);
  expect(await clickPanel(page, '.search-scope [role="tab"][data-tab="site"]')).toBe(true);
  await search(page, tag);
  await expect.poll(async () => (await searchRows(page)).length, { timeout: 15_000 }).toBe(2);

  // Another page: a link to it, on the note, in a new tab; the tab of the reader stays where it is.
  const opened = extension.context.waitForEvent('page');
  const elsewhere = await clickShowOnPage(page, /elsewhere/);
  expect(elsewhere?.tag).toBe('A');
  expect(elsewhere?.href).toMatch(/side-panel-link-b.*#fruitback-note=/);
  const tab = await opened;
  await expect(tab).toHaveURL(/side-panel-link-b/);
  await expect(tab.getByRole('dialog', { name: /^(Note|Feedback) / })).toContainText(`Link ${tag} elsewhere`, {
    timeout: 20_000,
  });
  expect(page.url()).toMatch(/side-panel-link-a/);
});

test('a new search during « Show more » draws no page of the words of before (FRU-307, review of #419)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-search-stale');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect
    .poll(() => inPanel<boolean>(page, `document.querySelector('button.panel-search') !== null`).catch(() => false))
    .toBe(true);

  // The answers of the worker, held by the panel's `fetch`: a first page with a next one, the next
  // page at once, and the read of the new words late, so that the moment between the two is seen.
  await inPanel(
    page,
    `(() => {
      const real = window.fetch.bind(window);
      window.__asked = [];
      const note = (note, excerpt) => ({
        note,
        excerpt,
        page: { url: 'http://localhost:5177/?case=elsewhere', path: '/?case=elsewhere' },
        stage: 'new',
        author: { kind: 'anonymous' },
        createdAt: new Date().toISOString(),
      });
      const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (!url.pathname.endsWith('/session/notes')) return real(input, init);
        const q = url.searchParams.get('q') ?? '';
        const cursor = url.searchParams.get('cursor');
        window.__asked.push({ q, cursor });
        if (cursor !== null) return answer({ notes: [note('more-1', 'A next page of the words of before')], total: 4 });
        if (q === '') return answer({ notes: [note('old-1', 'Old one'), note('old-2', 'Old two'), note('old-3', 'Old three')], total: 4, next: 'c1' });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return answer({ notes: [note('new-1', 'The note of the new words')], total: 1 });
      };
    })()`,
  );
  expect(await clickPanel(page, 'button.panel-search')).toBe(true);
  expect(await clickPanel(page, '.search-scope [role="tab"][data-tab="site"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length).toBe(3);
  expect(await inPanel<boolean>(page, `document.querySelector('.site-more button.panel-link') !== null`)).toBe(true);

  // New words, and « Show more » in the same moment, before the read of the new words leaves.
  const pressed = await inPanel<boolean>(
    page,
    `(() => {
      const field = document.querySelector('.search-input');
      field.value = 'mocha';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const more = document.querySelector('.site-more button.panel-link');
      more?.click();
      return more !== null;
    })()`,
  );
  await page.waitForTimeout(1200);
  const asked = await inPanel<{ q: string; cursor: string | null }[]>(page, 'window.__asked');
  expect(
    asked.filter((each) => each.cursor !== null),
    'no next page asked with other words',
  ).toEqual([]);
  expect(pressed, '« Show more » is not offered for the list of the words of before').toBe(false);
  expect((await searchRows(page)).map((row) => row.note)).not.toContain('A next page of the words of before');

  // Then the list of the new words, alone.
  await expect
    .poll(async () => (await searchRows(page)).map((row) => row.note), { timeout: 10_000 })
    .toEqual(['The note of the new words']);
});

test('beyond five statuses, the filter of the search is a list over the notes, chosen with the keyboard (FRU-535)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-status-list');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await popup.close();
  await plantOn(page, '[data-testid="card-espresso"] .add', 'Seven statuses');

  // The worker of the suite sends no status of a team (FRU-368): its read is given what a site with
  // seven statuses of Linear sends, the note planted copied once for each status.
  const SEVEN = [
    ['new', 'Triage', '#e0f2fe'],
    ['todo', 'Backlog', '#e4e4e7'],
    ['todo', 'Ready', '#fde68a'],
    ['progress', 'In Progress', '#f97316'],
    ['progress', 'In Review', '#7c3aed'],
    ['done', 'Shipped', '#16a34a'],
    ['closed', 'Canceled', '#a1a1aa'],
  ] as const;
  await extension.context.route(
    (url) => url.origin === AUTHENTICATED_WORKER_ORIGIN && url.pathname === '/feedback',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { issues: { id: string; note: { text: string } }[] };
      const planted = body.issues.find((issue) => issue.note.text === 'Seven statuses');
      if (planted === undefined) return route.fulfill({ response, json: body });
      const issues = SEVEN.map(([stage, name], index) => ({
        ...planted,
        id: `${planted.id}-s${index}`,
        stage,
        status: `e2e:${index}`,
        note: { ...planted.note, text: `Status ${name}` },
      }));
      const statuses = SEVEN.map(([stage, name, color], index) => ({ key: `e2e:${index}`, name, stage, color }));
      await route.fulfill({ response, json: { ...body, issues, statuses } });
    },
  );
  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(7);

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect
    .poll(async () => (await panelRows(page).catch(() => ({ tabs: [], rows: [] }))).rows.length)
    .toBeGreaterThan(0);
  expect(await clickPanel(page, 'button.panel-search')).toBe(true);

  const read = () =>
    inPanel<{
      chips: number;
      trigger: string | null;
      expanded: string | null;
      options: string[];
      focus: string;
      notesTop: number;
      listBottom: number | null;
      rows: string[];
    }>(
      page,
      `(() => {
        const list = document.querySelector('.search-status [role="listbox"]');
        const active = document.activeElement;
        return {
          chips: document.querySelectorAll('button.search-chip').length,
          trigger: document.querySelector('.search-status .kit-select-trigger')?.textContent ?? null,
          expanded: document.querySelector('.search-status .kit-select-trigger')?.getAttribute('aria-expanded') ?? null,
          options: [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => option.querySelector('.kit-select-name')?.textContent ?? ''),
          focus: active?.classList.contains('kit-select-trigger') ? 'button' : active?.getAttribute('role') ?? active?.tagName ?? '',
          notesTop: document.querySelector('.panel-notes')?.getBoundingClientRect().top ?? -1,
          listBottom: list?.getBoundingClientRect().bottom ?? null,
          rows: [...document.querySelectorAll('.panel-notes li[data-note] .panel-row-note')].map((row) => row.textContent),
        };
      })()`,
    );
  /** A key, as the keyboard sends it to what has the focus in the panel. */
  const press = (key: string) =>
    inPanel(
      page,
      `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
    );

  // Seven statuses: no chip, the button says every status and how many notes.
  await expect.poll(async () => (await read()).trigger).toMatch(/^(Status · All · 7|Statut · Toutes · 7)▾$/);
  const closed = await read();
  expect(closed.chips).toBe(0);
  expect(closed.rows).toHaveLength(7);

  // The arrow on the button opens the list over the notes: the notes do not move.
  await inPanel(page, `document.querySelector('.search-status .kit-select-trigger').focus()`);
  await press('ArrowDown');
  const open = await read();
  expect(open.expanded).toBe('true');
  expect(open.focus).toBe('listbox');
  expect(open.options.slice(1)).toEqual([
    'Triage',
    'Backlog',
    'Ready',
    'In Progress',
    'In Review',
    'Shipped',
    'Canceled',
  ]);
  expect(open.notesTop).toBe(closed.notesTop);
  expect(open.listBottom).toBeGreaterThan(open.notesTop);

  // Escape closes it, and the focus is back on its button.
  await press('Escape');
  expect(await read()).toMatchObject({ expanded: 'false', options: [], focus: 'button' });

  // Down five times from « All »: « In Review », chosen with Enter.
  await press('ArrowDown');
  for (let step = 0; step < 5; step += 1) await press('ArrowDown');
  await press('Enter');
  await expect.poll(async () => (await read()).rows).toEqual(['Status In Review']);
  expect(await read()).toMatchObject({ expanded: 'false', focus: 'button' });
  expect((await read()).trigger).toMatch(/^(Status|Statut) · In Review · 1▾$/);

  // A click outside closes an open list.
  await press('ArrowDown');
  expect((await read()).expanded).toBe('true');
  await inPanel(
    page,
    `document.querySelector('.panel-notes').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`,
  );
  expect((await read()).expanded).toBe('false');
});
