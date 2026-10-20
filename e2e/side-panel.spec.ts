import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { pinFor } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The side panel of the browser (FRU-296): its place in the manifest, the warnings Chrome shows for
 * it, and the panel opened from a click in the popup, which follows the active tab.
 *
 * Playwright does not hand the panel over as a `Page`: measured, `context.pages()` does not list it.
 * The service worker sees it in `runtime.getContexts`, and the protocol of the browser reaches it as
 * a target: `panel()` evaluates in it through `Target.sendMessageToTarget`.
 */

/** The `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  runtime: {
    getManifest(): Record<string, unknown> & { permissions?: string[] };
    getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]>;
  };
  management: { getPermissionWarningsByManifest(manifest: string): Promise<string[]> };
};

const NAME = 'Camille Durand';

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

/** Runs `expression` in the side panel, and answers its value. */
async function inPanel<T>(page: Page, expression: string): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const target = targetInfos.find((info) => info.url.endsWith('/sidepanel.html'));
    if (target === undefined) throw new Error('no side panel among the targets');
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })) as {
      sessionId: string;
    };
    const answer = new Promise<T>((resolve, reject) => {
      cdp.on('Target.receivedMessageFromTarget', (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message) as {
          id?: number;
          result?: { result: { value: T }; exceptionDetails?: unknown };
        };
        if (message.id !== 1) return;
        if (message.result?.exceptionDetails !== undefined) reject(new Error(JSON.stringify(message.result)));
        else resolve(message.result?.result.value as T);
      });
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        // A promise is awaited: axe answers one (FRU-307).
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    });
    const value = await answer;
    await cdp.send('Target.detachFromTarget', { sessionId });

    return value;
  } finally {
    await cdp.detach();
  }
}

/**
 * The words of the panel in each language. The account of the suite may read French, and the panel
 * speaks the language of the account, as the popup does: the spec reads which one it speaks.
 */
const WORDS = {
  en: {
    title: 'Notes on this page',
    close: 'Close the sidebar',
    notOn: ['Fruitback is not on for this page.', 'Turn it on from the Fruitback button in the toolbar.'],
    open: 'Open',
    done: 'Done',
    show: 'Show on the page',
    reply: 'Reply',
    ready: 'Ready to check',
    fixed: 'Looks fixed',
    wrong: 'Still wrong',
    markedDone: 'Marked done',
    doneStage: 'Done',
    newStage: 'New',
    checkedByYou: 'Checked by you',
    reopenedByYou: 'Reopened by you',
    justNow: 'just now',
  },
  fr: {
    title: 'Notes de cette page',
    close: 'Fermer le panneau',
    notOn: [
      'Fruitback n’est pas activé sur cette page.',
      'Activez-le depuis le bouton Fruitback de la barre d’outils.',
    ],
    open: 'Ouvertes',
    done: 'Terminées',
    show: 'Voir sur la page',
    reply: 'Répondre',
    ready: 'À vérifier',
    fixed: 'C’est corrigé',
    wrong: 'Toujours pas',
    markedDone: 'Marquée terminée',
    doneStage: 'Terminé',
    newStage: 'Nouveau',
    checkedByYou: 'Vérifiée par vous',
    reopenedByYou: 'Rouverte par vous',
    justNow: 'à l’instant',
  },
} as const;

/** The words of the language the panel speaks now. */
async function words(page: Page): Promise<(typeof WORDS)[keyof typeof WORDS]> {
  return (await inPanel<string>(page, 'document.documentElement.lang')).startsWith('fr') ? WORDS.fr : WORDS.en;
}

/** What the panel shows: the title, the site it names, and the lines it says. */
function panelWords(page: Page) {
  return inPanel<{ title: string; site: string | null; lines: string[]; close: string | null }>(
    page,
    `({
      title: document.querySelector('h2')?.textContent ?? '',
      site: document.querySelector('.panel-where')?.textContent?.split(' · ')[0] ?? null,
      lines: [...document.querySelectorAll('.panel-state p')].map((line) => line.textContent),
      close: document.querySelector('button.panel-close')?.getAttribute('aria-label') ?? null,
    })`,
  );
}

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

  expect(read.permissions).toEqual(['storage', 'scripting', 'activeTab', 'alarms', 'sidePanel']);
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

  await popup
    .getByRole('button', { name: /^(Show all notes in a sidebar|Voir toutes les notes dans un panneau)$/ })
    .click();
  await expect.poll(() => popup.isClosed()).toBe(true);
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

/** A note on `selector`, with the widget the extension mounted on a site of the workspace. */
async function plantOn(page: Page, selector: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-note]:visible').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

/** What the panel lists: each row with the number of its drop, its note, and whether it is open. */
function panelRows(page: Page) {
  return inPanel<{ tabs: string[]; rows: { number: string; note: string; open: boolean }[] }>(
    page,
    `({
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      rows: [...document.querySelectorAll('li[data-note]')].map((row) => ({
        number: row.querySelector('.kit-drop-number')?.textContent ?? '',
        note: row.querySelector('.panel-row-note')?.textContent ?? '',
        open: row.querySelector('.panel-row-head')?.getAttribute('aria-expanded') === 'true',
      })),
    })`,
  );
}

/** A click in the panel, on the button of a row with these words; `row` opens the row. */
function clickInRow(page: Page, note: string, label: string): Promise<unknown> {
  return inPanel(
    page,
    `(() => {
      const row = [...document.querySelectorAll('li[data-note]')].find((each) => each.querySelector('.panel-row-note')?.textContent === ${JSON.stringify(note)});
      if (${JSON.stringify(label)} === 'row') {
        const head = row?.querySelector('.panel-row-head');
        // Opened, never closed: a row may be open already, from a click on its pin.
        if (head?.getAttribute('aria-expanded') !== 'true') head?.click();
        return head !== undefined;
      }
      const button = [...(row?.querySelectorAll('button') ?? [])].find((each) => each.textContent === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`,
  );
}

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
      done: ['ripe', 'composted'].includes((pin as HTMLElement).dataset.fruitbackStage ?? ''),
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

/** What « Ready to check » shows: its title, and each note with the line of who fixed it. */
function readyBlock(page: Page) {
  return inPanel<{ title: string | null; items: { note: string; meta: string }[]; problem: string | null }>(
    page,
    `({
      title: document.querySelector('section.ready h3')?.textContent ?? null,
      items: [...document.querySelectorAll('.ready-item')].map((item) => ({
        note: item.querySelector('.ready-note')?.textContent ?? '',
        meta: item.querySelector('.ready-meta')?.textContent ?? '',
      })),
      problem: document.querySelector('.ready-problem')?.textContent ?? null,
    })`,
  );
}

/** A click on « Looks fixed » or « Still wrong » of the note with these words. */
function verdict(page: Page, note: string, label: string): Promise<boolean> {
  return inPanel<boolean>(
    page,
    `(() => {
      const item = [...document.querySelectorAll('.ready-item')].find((each) => each.querySelector('.ready-note')?.textContent === ${JSON.stringify(note)});
      const button = [...(item?.querySelectorAll('button') ?? [])].find((each) => each.textContent.trim() === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`,
  );
}

/** The meta line of the row of a note, in the list of the panel. */
function rowMeta(page: Page, note: string): Promise<string | null> {
  return inPanel<string | null>(
    page,
    `[...document.querySelectorAll('li[data-note]')].find((row) => row.querySelector('.panel-row-note')?.textContent === ${JSON.stringify(note)})?.querySelector('.panel-row-meta')?.textContent ?? null`,
  );
}

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
    ['Check note 2', 'ripe'],
    ['Check note 3', 'ripe'],
    ['Check note 4', 'composted'],
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

        return page.locator('[data-fruitback-pin][data-fruitback-stage="ripe"]').count();
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
  await expect(page.locator('[data-fruitback-pin][data-fruitback-stage="seeded"]')).not.toHaveCount(0);
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
  await page.evaluate(() => window.postMessage({ channel: 'fruitback-extension', kind: 'unmount' }, '*'));
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

/** The source of axe, run in the panel: Playwright hands the panel over as no `Page` for `AxeBuilder`. */
function axeSource(): string {
  // From the root of the repository, where Playwright runs: a spec has no `import.meta.url`.
  const playwrightAxe = createRequire(`${process.cwd()}/package.json`).resolve('@axe-core/playwright');

  return readFileSync(createRequire(playwrightAxe).resolve('axe-core/axe.min.js'), 'utf8');
}

/** The rows the panel lists now: the words of each, and the path of a row of the whole site. */
function searchRows(page: Page) {
  return inPanel<{ note: string; meta: string; hollow: boolean }[]>(
    page,
    `[...document.querySelectorAll('.panel-notes li[data-note]')].map((row) => ({
      note: row.querySelector('.panel-row-note')?.textContent ?? '',
      meta: row.querySelector('.panel-row-meta')?.textContent ?? '',
      hollow: row.querySelector('.kit-drop')?.getAttribute('data-hollow') === 'true',
    }))`,
  );
}

/** Types in the search of the panel, as a person does: the value, then an `input` event. */
function search(page: Page, words: string): Promise<unknown> {
  return inPanel(
    page,
    `(() => {
      const field = document.querySelector('.search-input');
      field.value = ${JSON.stringify(words)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
}

/** A click on the first element of the panel that `selector` finds, with these words if given. */
function clickPanel(page: Page, selector: string, text?: RegExp): Promise<boolean> {
  return inPanel<boolean>(
    page,
    `(() => {
      const pattern = ${text === undefined ? 'null' : `new RegExp(${JSON.stringify(text.source)})`};
      const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => pattern === null || pattern.test(each.textContent));
      found?.click();
      return found !== undefined;
    })()`,
  );
}

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
  expect(await chips()).toEqual(['all 3', 'seeded 3', 'green 0', 'ripening 0', 'ripe 0']);
  expect(await clickPanel(page, '.search-chip[data-stage="ripening"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length).toBe(0);
  expect(await clickPanel(page, '.search-chip[data-stage="seeded"]')).toBe(true);
  await expect.poll(async () => (await searchRows(page)).length).toBe(3);
  await search(page, `${tag} mocha`);
  await expect.poll(chips, { timeout: 15_000 }).toEqual(['all 1', 'seeded 1', 'green 0', 'ripening 0', 'ripe 0']);

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
      const note = (seed, excerpt) => ({
        seed,
        excerpt,
        page: { url: 'http://localhost:5177/?case=elsewhere', path: '/?case=elsewhere' },
        stage: 'seeded',
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
