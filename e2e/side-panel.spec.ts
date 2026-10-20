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

/** What the panel shows: the title, the site it names, and the lines it says. */
function panelWords(page: Page) {
  return inPanel<{ title: string; site: string | null; lines: string[]; close: string | null }>(
    page,
    `({
      title: document.querySelector('h2')?.textContent ?? '',
      site: document.querySelector('.panel-site')?.textContent ?? null,
      lines: [...document.querySelectorAll('.panel-body p')].map((line) => line.textContent),
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
  await expect
    .poll(() => panelWords(page))
    .toMatchObject({
      title: 'Notes on this page',
      site: new URL(PLAYGROUND_ORIGIN).host,
      close: 'Close the sidebar',
    });

  // Another tab, on a page Fruitback is not on: the panel says so. Back: the site again.
  const other = await extension.context.newPage();
  await other.goto(`${AUTHENTICATED_WORKER_ORIGIN}/health`);
  await other.bringToFront();
  await expect
    .poll(() => panelWords(page))
    .toMatchObject({
      site: null,
      lines: ['Fruitback is not on for this page.', 'Turn it on from the Fruitback button in the toolbar.'],
    });
  await page.bringToFront();
  await expect.poll(() => panelWords(page)).toMatchObject({ site: new URL(PLAYGROUND_ORIGIN).host });

  // « Show the notes on the page »: the list of the widget opens in the page, until FRU-299.
  await inPanel(page, `document.querySelector('.panel-body button').click()`);
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();
});
