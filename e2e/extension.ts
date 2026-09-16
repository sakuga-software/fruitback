import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, type Page, type Worker, test as base, chromium, expect } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN, WORKER_SESSION_ENV } from './worker-sessions.ts';

/**
 * The extension, loaded into a real Chromium, against the playground as an ordinary site (SKG-538).
 *
 * The site is `/?case=…&widget=off`: the playground with no widget of its own, so a widget on it
 * came from the extension or from what a spec mounts on purpose.
 */

/** The only `chrome.*` calls the specs make, from the service worker. */
declare const chrome: {
  scripting: { getRegisteredContentScripts(): Promise<unknown[]> };
  storage: Record<'local' | 'session', { get(keys: null): Promise<Record<string, unknown>> }>;
  tabs: { create(properties: { url: string; active: boolean }): Promise<unknown> };
};

const BUILT_EXTENSION = 'apps/extension/.output/chrome-mv3';
export const PLAYGROUND_ORIGIN = 'http://localhost:5177';

export type LoadedExtension = { context: BrowserContext; worker: Worker; id: string };

export const test = base.extend<{ extension: LoadedExtension }>({
  extension: async ({}, use, testInfo) => {
    const directory = copyWithLocalAccess(testInfo.outputPath('extension'));
    // Not under test-results: CI uploads that folder when the job fails, and after a pairing the profile
    // holds a refresh token.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitback-e2e-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
      // The full Chromium in its new headless mode. The headless shell, which Playwright uses by
      // default, loads no extension.
      channel: 'chromium',
      headless: true,
      baseURL: PLAYGROUND_ORIGIN,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    });

    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await use({ context, worker, id: new URL(worker.url()).host });
    } finally {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  },
});

/**
 * A copy of the built extension that holds host access to the local origins: the playground and both workers.
 *
 * A browser asks the person before it grants an optional host permission, and automation cannot
 * answer the prompt: `permissions.request` stays pending. A host permission in the manifest is
 * granted at load, so the request from the options page and the popup resolves at once. Only this
 * copy changes. The shipped manifest still asks for no host at install.
 */
function copyWithLocalAccess(directory: string): string {
  const builtPath = path.join(BUILT_EXTENSION, 'manifest.json');
  if (!fs.existsSync(builtPath)) {
    throw new Error(`${BUILT_EXTENSION} is not built. Run pnpm e2e, which builds it first.`);
  }
  // The copy gets host access, so no spec can see a shipped manifest that asks for it at install. A
  // static content script asks for its matches at install too.
  const built = JSON.parse(fs.readFileSync(builtPath, 'utf8')) as {
    host_permissions?: string[];
    content_scripts?: { matches?: string[] }[];
  };
  const installTimeHosts = [
    ...(built.host_permissions ?? []),
    ...(built.content_scripts ?? []).flatMap((script) => script.matches ?? []),
  ];
  if (installTimeHosts.length > 0) {
    throw new Error(`the built manifest asks for host access at install: ${installTimeHosts.join(', ')}`);
  }

  const manifestPath = path.join(directory, 'manifest.json');
  fs.cpSync(BUILT_EXTENSION, directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = [`${PLAYGROUND_ORIGIN}/*`, `${WORKER_ORIGIN}/*`, `${AUTHENTICATED_WORKER_ORIGIN}/*`];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  return directory;
}

/**
 * The bare playground, on a page URL of its own.
 *
 * The parameters are in canonical order, so `seedsOn` can read the stored seeds with the raw URL.
 */
export async function openBareSite(page: Page, testCase: string): Promise<void> {
  const attempt = test.info().retry;
  await page.goto(`/?case=${attempt === 0 ? testCase : `${testCase}-retry${attempt}`}&widget=off`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
}

/** A rule for the playground origin, added through the options page, and registered by the background. */
export async function addRule(
  extension: LoadedExtension,
  rule: { endpoint: string } & ({ mode: 'private'; clientId: string } | { mode: 'team' }),
): Promise<void> {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await options.getByLabel('Sites', { exact: true }).fill(PLAYGROUND_ORIGIN);
  // The name of a select in a label includes the chosen option, so it only starts with the label.
  await options.getByLabel(/^Mode/).selectOption(rule.mode);
  await options.getByLabel('Worker endpoint', { exact: true }).fill(rule.endpoint);
  if (rule.mode === 'private') await options.getByLabel('Client id', { exact: true }).fill(rule.clientId);
  await options.getByRole('button', { name: 'Add rule' }).click();
  await expect(options.locator('.rules li').filter({ hasText: PLAYGROUND_ORIGIN })).toContainText('Access granted');
  await options.close();

  // The background registers the two scripts after the storage change. A page loaded before that
  // gets neither.
  await expect
    .poll(() => extension.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
    .toBe(2);
}

/** A pairing code, minted the way an operator mints one: the worker's own `pair` command. */
export function mintPairingCode(name: string): string {
  const output = execFileSync(process.execPath, ['src/main.ts', 'pair', '--subject', 'e2e-reviewer', '--name', name], {
    cwd: 'apps/worker',
    encoding: 'utf8',
    env: { ...process.env, FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: PLAYGROUND_ORIGIN, ...WORKER_SESSION_ENV },
  });
  const code = /^ {4}(\S+)$/m.exec(output)?.[1];
  if (code === undefined) throw new Error(`the pair command printed no code:\n${output}`);

  return code;
}

/**
 * Pair from the popup, for the site in `site`.
 *
 * The popup acts on the active tab of its window. It opens behind the site, so the site stays that tab.
 */
export async function pairFromPopup(extension: LoadedExtension, site: Page, code: string, name: string): Promise<void> {
  await site.bringToFront();
  const url = `chrome-extension://${extension.id}/popup.html`;
  await extension.worker.evaluate(async (popupUrl) => {
    await chrome.tabs.create({ url: popupUrl, active: false });
  }, url);

  let popup: Page | undefined;
  await expect.poll(() => (popup = extension.context.pages().find((page) => page.url() === url))).toBeDefined();
  if (popup === undefined) return;

  await expect(popup.getByText(PLAYGROUND_ORIGIN, { exact: true })).toBeVisible();
  await popup.getByLabel('Pairing code').fill(code);
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText(`Paired as ${name}`)).toBeVisible();
  await popup.close();
}

type StoredSeed = { note: string; source?: Record<string, unknown>; reporter?: Record<string, unknown> };

/** A read of the seeds of a page, from this process, so the page makes no call of its own. */
export function readSeeds(page: Page, origin: string, accessToken?: string): Promise<Response> {
  return fetch(`${origin}/feedback?url=${encodeURIComponent(page.url())}&client=playground`, {
    headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
  });
}

export async function seedsOn(page: Page, origin = WORKER_ORIGIN, accessToken?: string): Promise<StoredSeed[]> {
  const response = await readSeeds(page, origin, accessToken);
  expect(response.status).toBe(200);
  const { issues } = (await response.json()) as { issues: { seed: StoredSeed }[] };

  return issues.map((issue) => issue.seed);
}

export type StoredToken = { area: 'local' | 'session'; value: string };

/** Every string the extension stores under a key named like a token, in its sessions and its grants. */
export async function storedTokens(worker: Worker): Promise<StoredToken[]> {
  return worker.evaluate(async () => {
    const tokens: StoredToken[] = [];
    const walk = (area: StoredToken['area'], value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === 'string' && /token/i.test(key)) tokens.push({ area, value: inner });
        else walk(area, inner);
      }
    };
    for (const area of ['local', 'session'] as const) {
      for (const [key, value] of Object.entries(await chrome.storage[area].get(null))) {
        // The prefix without its colon, so a session key per endpoint and one per run (SKG-604) both match.
        if (key.startsWith('fruitback:session') || key.startsWith('fruitback:grant:')) walk(area, value);
      }
    }

    return tokens;
  });
}

/** Records every `message` event the page's own scripts can see. Call it before the page loads. */
export async function recordPageMessages(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __seenMessages: seen });
    window.addEventListener('message', (event) => seen.push(JSON.stringify(event.data)));
  });
}

/** What the page's own JavaScript can read: the messages it saw, its DOM, its storage and the extension's global. */
export async function readableByThePage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scope = globalThis as {
      __seenMessages?: string[];
      fruitbackExtension?: object;
      chrome?: { storage?: unknown; runtime?: unknown };
    };

    return JSON.stringify({
      messages: scope.__seenMessages ?? [],
      html: document.documentElement.outerHTML,
      widget: document.querySelector('[data-fruitback-host]')?.shadowRoot?.innerHTML ?? '',
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      cookie: document.cookie,
      api: Object.entries(scope.fruitbackExtension ?? {}).map(([key, value]) => [key, String(value)]),
      chromeStorage: typeof scope.chrome?.storage,
    });
  });
}
