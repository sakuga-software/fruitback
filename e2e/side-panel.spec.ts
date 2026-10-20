import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, mintPairing, openBareSite, openPopup, test } from './extension.ts';
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
  await clickInRow(page, target?.note ?? '', said.show);
  await expect(page.getByRole('dialog', { name: /^(Note|Feedback) / })).toContainText('Answered from the side panel');

  // The panel read no worker: every read went through the widget of the tab.
  const fetched = await inPanel<string[]>(page, `performance.getEntriesByType('resource').map((entry) => entry.name)`);
  expect(fetched.filter((url) => !url.startsWith('chrome-extension://'))).toEqual([]);
});
