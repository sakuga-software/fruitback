import { expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, clickThatClosesPopup, openBareSite, openPopup, test } from './extension.ts';
import { pinFor } from './pin.ts';
import {
  paired,
  inPanel,
  words,
  panelWords,
  plantOn,
  panelRows,
  clickInRow,
  readyBlock,
  verdict,
  rowMeta,
} from './side-panel.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The side panel of the browser (FRU-296): its place in the manifest, the warnings Chrome shows for
 * it, and the panel opened from a click in the popup, which follows the active tab. Its search and its
 * rows of the whole site are in `side-panel-search.spec.ts`, and `side-panel.ts` holds what both use:
 * one file took 165 s on one worker of CI (FRU-480).
 */

/** The `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  runtime: {
    getManifest(): Record<string, unknown> & { permissions?: string[] };
    getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]>;
  };
  management: { getPermissionWarningsByManifest(manifest: string): Promise<string[]> };
};

test('the manifest declares the panel, and Chrome shows no new warning for it', async ({ extension }) => {
  const read = await extension.worker.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    // The same manifest with no panel: what an update from the version before asks.
    const before: Record<string, unknown> = {
      ...manifest,
      permissions: (manifest.permissions ?? []).filter((permission) => permission !== 'sidePanel'),
    };
    delete before.side_panel;

    return {
      permissions: manifest.permissions,
      panel: manifest.side_panel,
      action: manifest.action,
      now: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(manifest)),
      before: await chrome.management.getPermissionWarningsByManifest(JSON.stringify(before)),
    };
  });

  expect(read.permissions).toEqual(['storage', 'scripting', 'activeTab', 'alarms', 'contextMenus', 'sidePanel']);
  expect(read.panel).toEqual({ default_path: 'sidepanel.html' });
  // The icon keeps its popup.
  expect(read.action).toMatchObject({ default_popup: 'popup.html' });
  expect(read.now).toEqual(read.before);
});

test('a click in the popup opens the panel on the tab, and the panel follows the active tab', async ({ extension }) => {
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // No panel before the click: the icon opens the popup, and nothing opens a panel by itself.
  const panels = () =>
    extension.worker.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((context) => context.documentUrl),
    );
  expect(await panels()).toEqual([]);

  await clickThatClosesPopup(
    popup,
    popup.getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ }),
  );
  await expect.poll(panels).toEqual([`chrome-extension://${extension.id}/sidepanel.html`]);

  // The panel names the site of the tab.
  await expect.poll(async () => (await panelWords(page)).site).toBe(new URL(PLAYGROUND_ORIGIN).host);
  const said = await words(page);
  expect(await panelWords(page)).toMatchObject({ title: said.title, close: said.close });

  // Another tab, on a page Fruitback is not on: the panel says so. Back: the site again.
  const other = await extension.context.newPage();
  await other.goto(`${AUTHENTICATED_WORKER_ORIGIN}/health`);
  await other.bringToFront();
  await expect.poll(() => panelWords(page)).toMatchObject({ site: null, lines: [...said.notOn] });
  await page.bringToFront();
  await expect.poll(() => panelWords(page)).toMatchObject({ site: new URL(PLAYGROUND_ORIGIN).host });
});

test('« Notes on this page » lists the pins of the page, opens a row from a pin, shows a note, and replies (FRU-299)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-notes');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  // Five notes, through the widget the extension mounted.
  const places = [
    '[data-testid="card-espresso"] .add',
    '[data-testid="card-latte"] .add',
    '[data-testid="card-mocha"] .add',
    '[data-testid="card-espresso"] h3',
    '[data-testid="card-latte"] h3',
  ];
  // One note long enough to wrap in the panel.
  const long = ': the Add button is almost invisible until you hover it, on every card of the page';
  for (const [index, place] of places.entries()) {
    await plantOn(page, place, `Panel note ${index + 1}${index === 0 ? long : ''}`);
  }
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(5);

  // The panel, from the popup.
  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect.poll(async () => (await panelRows(page).catch(() => ({ tabs: [], rows: [] }))).tabs.length).toBe(2);

  // The same numbers as the pins; Open and Done count the stages of the pins.
  const pins = await page.locator('[data-fruitback-pin]').evaluateAll((all) =>
    all.map((pin) => ({
      number: pin.querySelector('.fruitback-pin-badge')?.textContent?.trim() ?? '',
      done: ['done', 'closed'].includes((pin as HTMLElement).dataset.fruitbackStage ?? ''),
    })),
  );
  const open = pins.filter((pin) => !pin.done);
  const done = pins.filter((pin) => pin.done);
  const listed = await panelRows(page);
  const said = await words(page);
  expect(listed.tabs).toEqual([`${said.open} · ${open.length}`, `${said.done} · ${done.length}`]);
  expect(listed.rows.map((row) => row.number).sort()).toEqual(open.map((pin) => pin.number).sort());

  // A click on a pin opens its row in the panel.
  const first = page
    .locator('[data-fruitback-pin]')
    .filter({ hasText: open[0]?.number ?? '' })
    .first();
  await first.locator('.fruitback-pin-badge').click();
  await expect
    .poll(async () => (await panelRows(page)).rows.filter((row) => row.open).map((row) => row.number))
    .toEqual([open[0]?.number]);
  await page.keyboard.press('Escape');

  // « Show on the page »: the thread of the note opens on the page.
  const target = (await panelRows(page)).rows[0];
  expect(target).toBeDefined();
  await clickInRow(page, target?.note ?? '', 'row');
  await expect.poll(() => clickInRow(page, target?.note ?? '', said.show)).toBe(true);
  await expect(page.getByRole('dialog', { name: /^(Note|Feedback) / })).toBeVisible();
  await page.keyboard.press('Escape');

  // « Reply »: the reply is in the thread of the widget.
  await expect.poll(() => clickInRow(page, target?.note ?? '', said.reply)).toBe(true);
  await inPanel(
    page,
    `(() => {
      const field = document.querySelector('.panel-reply-field');
      field.value = 'Answered from the side panel';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.panel-reply-form').requestSubmit();
    })()`,
  );
  await expect
    .poll(() => inPanel<string>(page, `document.querySelector('.panel-replies')?.textContent ?? ''`), {
      timeout: 20_000,
    })
    .toContain('Answered from the side panel');
  // A long note wraps inside its row: nothing runs past the edge of the panel (review of #404).
  expect(
    await inPanel<number>(
      page,
      `[...document.querySelectorAll('.panel-row-head')].filter((head) => head.scrollWidth > head.clientWidth).length`,
    ),
  ).toBe(0);
  // The focus is back on « Reply » of the row, not on the body of the panel (review).
  await expect
    .poll(() => inPanel<string | null>(page, `document.activeElement?.getAttribute('data-action') ?? null`))
    .toBe('reply');
  await clickInRow(page, target?.note ?? '', said.show);
  await expect(page.getByRole('dialog', { name: /^(Note|Feedback) / })).toContainText('Answered from the side panel');

  // The panel read no worker: every read went through the widget of the tab.
  const fetched = await inPanel<string[]>(page, `performance.getEntriesByType('resource').map((entry) => entry.name)`);
  expect(fetched.filter((url) => !url.startsWith('chrome-extension://'))).toEqual([]);
});

test('« Ready to check »: « Looks fixed » sends a note to Done, « Still wrong » reopens one (FRU-300)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-check');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  // Four notes of the person. The team marks the second and the third done, and closes the fourth,
  // as it would in its tracker: `POST /__dev/stage` of the worker of the suite.
  for (let index = 0; index < 4; index += 1) {
    await plantOn(
      page,
      `[data-testid="card-${['espresso', 'latte', 'mocha', 'espresso'][index]}"] ${index < 3 ? '.add' : 'h3'}`,
      `Check note ${index + 1}`,
    );
  }
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(4);
  for (const [note, stage] of [
    ['Check note 2', 'done'],
    ['Check note 3', 'done'],
    ['Check note 4', 'closed'],
  ] as const) {
    const id = await pinFor(page, note).getAttribute('data-fruitback-pin');
    const moved = await fetch(`${AUTHENTICATED_WORKER_ORIGIN}/__dev/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: id, stage }),
    });
    expect(moved.status, note).toBe(200);
  }
  // The widget reads the stages of now when the page comes back, once the shared cache of the read
  // (15 s, `CACHE_TTL_MS`) has let go of the answer of before.
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.locator('[data-fruitback-pin]')).toHaveCount(4);

        return page.locator('[data-fruitback-pin][data-fruitback-stage="done"]').count();
      },
      { timeout: 40_000, intervals: [3_000] },
    )
    .toBe(2);

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect.poll(async () => (await readyBlock(page).catch(() => ({ items: [] }))).items.length).toBe(2);
  const said = await words(page);
  const ready = await readyBlock(page);
  expect(ready.title).toBe(`${said.ready} · 2`);
  expect(ready.items.map((item) => item.note).sort()).toEqual(['Check note 2', 'Check note 3']);
  // No reply of the team: who marked it done is not known, only when.
  expect(ready.items.find((item) => item.note === 'Check note 3')?.meta).toMatch(new RegExp(`^${said.markedDone} · `));
  // Not in Done while they wait to be checked.
  expect((await panelRows(page)).tabs[1]).toBe(`${said.done} · 1`);

  // « Looks fixed »: the note is in Done, checked by the person.
  expect(await verdict(page, 'Check note 3', said.fixed)).toBe(true);
  await expect.poll(async () => (await readyBlock(page)).title, { timeout: 20_000 }).toBe(`${said.ready} · 1`);
  await expect
    .poll(() => rowMeta(page, 'Check note 3'))
    .toBe(`${said.doneStage} · ${said.checkedByYou} · ${said.justNow}`);

  // « Still wrong »: the note is open again, New, reopened by the person.
  expect(await verdict(page, 'Check note 2', said.wrong)).toBe(true);
  await expect.poll(async () => (await readyBlock(page)).title, { timeout: 20_000 }).toBeNull();
  await expect
    .poll(() => rowMeta(page, 'Check note 2'))
    .toBe(`${said.newStage} · ${said.reopenedByYou} · ${said.justNow}`);

  // The pins of the page say the same: the store moved the note, and the widget read it.
  await expect(page.locator('[data-fruitback-pin][data-fruitback-stage="new"]')).not.toHaveCount(0);
});

test('a tab whose widget is gone does not leave the panel reading for ever (FRU-299, review)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-no-widget');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  // The bridge stays, the widget goes: the page answers `no-widget`, and no `notes-changed` follows.
  // With the tag of the copy (FRU-397), which the page can read: the bridge is no access control.
  await page.evaluate(() =>
    window.postMessage(
      {
        channel: 'fruitback-extension/2',
        kind: 'unmount',
        copy: (window as unknown as { __fruitbackPageHolder: { tag: string } }).__fruitbackPageHolder.tag,
      },
      '*',
    ),
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toHaveCount(0);

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  // The panel first follows the tab and reads: « Reading… » (`no-widget`). Polled on what it shows,
  // never on what it does not: a panel not drawn yet has no « Reading… » either (it made this flaky).
  const shows = () =>
    inPanel<string>(
      page,
      `document.querySelector('.panel-reading') ? 'reading' : document.querySelector('.panel-failed button') ? 'reload' : 'other'`,
    ).catch(() => 'other');
  await expect.poll(shows, { timeout: 10_000 }).toBe('reading');

  // Not « Reading… » for ever: once the page still has no widget, the panel says to reload it.
  await expect.poll(shows, { timeout: 15_000 }).toBe('reload');
  expect(await inPanel<string>(page, `document.querySelector('.panel-failed p')?.textContent ?? ''`)).toMatch(
    /did not start on this page|n’a pas démarré sur cette page/,
  );
});

test('a row of the panel wears the colour and the name of the status its pin wears (FRU-370)', async ({
  extension,
}) => {
  test.slow();
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'side-panel-statuses');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await popup.close();
  const notes = [
    { place: '[data-testid="card-latte"] .add', note: 'Status pale', name: 'Waiting for the client', color: '#fef9c3' },
    { place: '[data-testid="card-mocha"] .add', note: 'Status dark', name: 'In review', color: '#7c3aed' },
  ];
  for (const { place, note } of notes) await plantOn(page, place, note);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

  // The worker of the suite sends no status with a colour, and its notes no `status` (FRU-368): the
  // read is given what a site with statuses sends. The background relays it, so the context routes it.
  await extension.context.route(
    (url) => url.origin === AUTHENTICATED_WORKER_ORIGIN && url.pathname === '/feedback',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { issues: { id: string; stage: string; note: { text: string } }[] };
      const statuses: Record<string, string>[] = [];
      const issues = body.issues.map((issue) => {
        const chosen = notes.find((each) => each.note === issue.note.text);
        if (chosen === undefined) return issue;
        statuses.push({ key: `e2e:${issue.id}`, name: chosen.name, stage: issue.stage, color: chosen.color });

        return { ...issue, status: `e2e:${issue.id}` };
      });
      await route.fulfill({ response, json: { ...body, issues, statuses } });
    },
  );
  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  // The pins in the order of the page: the latte card, then the mocha card.
  const pins = await page.locator('[data-fruitback-pin]').evaluateAll((all) =>
    all.map((pin) => ({
      stage: (pin as HTMLElement).dataset.fruitbackStage,
      fill: getComputedStyle(pin.querySelector('.fruitback-pin-badge') as Element).backgroundColor,
    })),
  );

  const again = await openPopup(extension, page);
  await again
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  const drawn = () =>
    inPanel<{ word: string; fill: string; text: string; stage: string }[]>(
      page,
      `[...document.querySelectorAll('li[data-note]')].map((row) => {
        const drop = row.querySelector('.kit-drop');
        return {
          word: row.querySelector('.panel-row-stage')?.textContent ?? '',
          fill: getComputedStyle(drop).backgroundColor,
          text: getComputedStyle(drop.querySelector('.kit-drop-number')).color,
          stage: drop.dataset.stage,
        };
      }).sort((a, b) => a.word.localeCompare(b.word))`,
    ).catch(() => []);

  // The violet takes white (5.70:1), the pale yellow the ink: as the pins on the page.
  await expect.poll(drawn).toEqual([
    { word: 'In review', fill: 'rgb(124, 58, 237)', text: 'rgb(255, 255, 255)', stage: pins[1]?.stage },
    { word: 'Waiting for the client', fill: 'rgb(254, 249, 195)', text: 'rgb(24, 24, 27)', stage: pins[0]?.stage },
  ]);
});
