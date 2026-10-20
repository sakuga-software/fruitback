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
      message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }),
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
  await popup.getByRole('button', { name: 'Turn on here' }).click();
  await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // No panel before the click: the icon opens the popup, and nothing opens a panel by itself.
  const panels = () =>
    extension.worker.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((context) => context.documentUrl),
    );
  expect(await panels()).toEqual([]);

  await popup.getByRole('button', { name: 'Show every note of the page' }).click();
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
  await popup.getByRole('button', { name: 'Turn on here' }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  // Five notes, through the widget the extension mounted.
  const places = [
    '[data-testid="card-espresso"] .add',
    '[data-testid="card-latte"] .add',
    '[data-testid="card-mocha"] .add',
    '[data-testid="card-espresso"] h3',
    '[data-testid="card-latte"] h3',
  ];
  for (const [index, place] of places.entries()) await plantOn(page, place, `Panel note ${index + 1}`);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(5);

  // The panel, from the popup.
  const again = await openPopup(extension, page);
  await again.getByRole('button', { name: 'Show every note of the page' }).click();
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
  await popup.getByRole('button', { name: 'Turn on here' }).click();
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
  await again.getByRole('button', { name: 'Show every note of the page' }).click();
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
  await popup.getByRole('button', { name: 'Turn on here' }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

  // The bridge stays, the widget goes: the page answers `no-widget`, and no `notes-changed` follows.
  await page.evaluate(() => window.postMessage({ channel: 'fruitback-extension', kind: 'unmount' }, '*'));
  await expect(page.locator('[data-fruitback-host-launch]')).toHaveCount(0);

  const again = await openPopup(extension, page);
  await again.getByRole('button', { name: 'Show every note of the page' }).click();
  await expect.poll(() => inPanel<string>(page, 'document.title').catch(() => ''), { timeout: 10_000 }).not.toBe('');

  // Not « Reading… » for ever: once the page still has no widget, the panel says to reload it.
  await expect
    .poll(() => inPanel<boolean>(page, `document.querySelector('.panel-reading') !== null`), { timeout: 15_000 })
    .toBe(false);
  expect(await inPanel<boolean>(page, `document.querySelector('.panel-failed button') !== null`)).toBe(true);
});
