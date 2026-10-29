import { type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { PLAYGROUND_ORIGIN, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The console of the Cloud connects the extension of the same browser in place (FRU-487): no tab
 * `/connect`, no word, no click on the icon. In a real Chromium, with the built extension, against a
 * worker of the Cloud on PGlite.
 *
 * `pnpm e2e` builds the extension with `WXT_FRUITBACK_CONSOLE=http://localhost:5178`, the console of
 * the suite, as the build of the store has `https://app.fruitback.com`. The console of the suite is
 * not the Cloud by its host, so `/config.js` names the id of the extension the spec loaded: the id of
 * an unpacked copy depends on its folder.
 */

declare const chrome: {
  runtime: {
    getManifest(): { externally_connectable?: { matches?: string[]; ids?: string[] } };
    sendMessage?: (id: string, message: unknown, answer: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
};

let worker: Worker | undefined;

test.afterEach(async ({ extension }) => finished(extension.context, worker));

/** One message from the page to the extension: its answer, or the error the browser gave. */
function send(page: Page, id: string, message: unknown): Promise<{ answer?: unknown; error?: string } | 'no-runtime'> {
  return page.evaluate(
    ({ id, message }) =>
      new Promise<{ answer?: unknown; error?: string } | 'no-runtime'>((resolve) => {
        const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
        if (runtime?.sendMessage === undefined) return resolve('no-runtime');
        runtime.sendMessage(id, message, (answer) => {
          const error = runtime.lastError?.message;
          resolve(error === undefined ? { answer } : { error });
        });
      }),
    { id, message },
  );
}

/**
 * The sessions the extension holds, by the address of their worker: the keys
 * `fruitback:session-run:<epoch>:<endpoint>` of `session-storage.ts`.
 */
async function sessionsOf(serviceWorker: import('@playwright/test').Worker): Promise<string[]> {
  return serviceWorker.evaluate(async () =>
    Object.keys(await chrome.storage.local.get(null))
      .filter((key) => key.startsWith('fruitback:session-run:'))
      .map((key) => {
        const rest = key.slice('fruitback:session-run:'.length);

        return rest.slice(rest.indexOf(':') + 1);
      }),
  );
}

test('the console of the Cloud connects the extension of this browser in place (FRU-487)', async ({ extension }) => {
  test.setTimeout(90_000);
  worker = await cloudWorker();
  const { context, id } = extension;
  await served(context, worker);
  // The extension of the build signs in to the second worker of the suite: here, to this one.
  const cloud = worker.origin;
  await context.route(`${AUTHENTICATED_WORKER_ORIGIN}/**`, async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({ url: `${cloud}${asked.pathname}${asked.search}`, maxRedirects: 0 });
    await route.fulfill({ response });
  });
  await context.route(`${CONSOLE}/config.js`, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `globalThis.__FRUITBACK__ = { extensionIds: [${JSON.stringify(id)}] };`,
    }),
  );

  // The manifest names the console of the build, one exact origin, and no other extension.
  const declared = await extension.worker.evaluate(() => chrome.runtime.getManifest().externally_connectable);
  expect(declared).toEqual({ matches: [`${CONSOLE}/*`] });

  // A page of another site has no way to the extension: Chrome gives it no `chrome.runtime` at all.
  const site = await context.newPage();
  await site.goto(`${PLAYGROUND_ORIGIN}/?widget=off`);
  expect(await send(site, id, { type: 'fruitback:hello', v: 1 })).toBe('no-runtime');
  await site.close();

  const setup = await context.newPage();
  await setup.goto(`${CONSOLE}/setup`);
  // The control: on the console, the same ask is answered.
  expect(await send(setup, id, { type: 'fruitback:hello', v: 1 })).toEqual({
    answer: { v: 1, ok: true, signedIn: false },
  });
  // A message of another shape is not answered: the page reads that nobody did.
  const forged = await send(setup, id, { type: 'fruitback:connect', v: 1, endpoint: 'https://evil.example' });
  expect(forged).not.toBe('no-runtime');
  expect((forged as { error?: string }).error).toBeTruthy();

  await setup.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
  await setup.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker!.sent()).length).toBe(1);
  const link = await context.newPage();
  await link.goto(await linkIn(worker));
  await expect(link.getByRole('heading', { name: 'You are signed in' })).toBeVisible({ timeout: 15_000 });
  await link.close();
  const siteField = setup.getByRole('textbox', { name: 'Site address' });
  await expect(siteField).toBeVisible({ timeout: 15_000 });
  await siteField.fill(PLAYGROUND_ORIGIN);
  await setup.getByRole('button', { name: 'Add site' }).click();
  await expect(setup.getByRole('heading', { name: /Put it on the site/ })).toBeVisible();

  // Step 3 sees the extension of this browser, and connects it with one click, in this tab.
  const card = setup.locator('.kit-option').filter({ has: setup.getByRole('heading', { name: 'Browser extension' }) });
  await expect(card.getByText('Fruitback is installed in this browser.', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await setup.screenshot({ path: test.info().outputPath('01-step-3-installed.png'), fullPage: true });
  const pagesBefore = context.pages().length;
  expect(await sessionsOf(extension.worker)).toEqual([]);
  await card.getByRole('button', { name: 'Connect this browser' }).click();
  await expect(card.getByText('Extension connected in this browser')).toBeVisible({ timeout: 30_000 });
  await setup.screenshot({ path: test.info().outputPath('02-step-3-connected.png'), fullPage: true });

  // No tab opened: no `/connect`, no word. The extension holds the session of the Cloud.
  expect(context.pages().length).toBe(pagesBefore);
  expect(context.pages().some((page) => page.url().includes('/connect'))).toBe(false);
  expect(await sessionsOf(extension.worker)).toEqual([AUTHENTICATED_WORKER_ORIGIN]);

  // Signed in, the extension starts no other request: a page cannot swap the account of this browser.
  expect(await send(setup, id, { type: 'fruitback:connect', v: 1 })).toEqual({
    answer: { v: 1, ok: false, reason: 'signed-in' },
  });
  // The worker lists this browser among those of the account.
  const browsers = await setup.evaluate(async (api) => {
    const answer = await fetch(`${api}/console/me/browsers`, { credentials: 'include' });

    return answer.ok ? ((await answer.json()) as unknown) : answer.status;
  }, WORKER_ORIGIN);
  expect(JSON.stringify(browsers)).toContain('Chrome');
});
