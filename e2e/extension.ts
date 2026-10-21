import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
  test as base,
  chromium,
  expect,
} from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The extension, loaded into a real Chromium, against the playground as an ordinary site (FRU-45).
 *
 * The site is `/?case=…&widget=off`: the playground with no widget of its own, so a widget on it
 * came from the extension or from what a spec mounts on purpose.
 */

/** The only `chrome.*` calls the specs make, from the service worker. */
declare const chrome: {
  scripting: { getRegisteredContentScripts(): Promise<{ matches?: string[] }[]> };
  storage: Record<'local' | 'session', { get(keys: null): Promise<Record<string, unknown>> }>;
  tabs: { create(properties: { url: string; active: boolean }): Promise<unknown> };
};

export const BUILT_EXTENSION = 'apps/extension/.output/chrome-mv3';
export const PLAYGROUND_ORIGIN = 'http://localhost:5177';

export type LoadedExtension = { context: BrowserContext; worker: Worker; id: string };

export const test = base.extend<{ extension: LoadedExtension; extraPermissions: string[]; keepWelcome: boolean }>({
  /**
   * Permissions the copy holds beyond the shipped manifest, for one spec (FRU-297). A popup opened in
   * a tab has no `activeTab`, which the click on the toolbar gives: with `tabs`, it reads the address
   * of a tab whose site the browser does not grant, as the real popup does after that click.
   */
  extraPermissions: [[], { option: true }],
  /** The welcome page that a first install opens (FRU-318) stays open, for the spec that reads it. */
  keepWelcome: [false, { option: true }],
  extension: async ({ extraPermissions, keepWelcome }, use, testInfo) => {
    const directory = copyWithLocalAccess(testInfo.outputPath('extension'), extraPermissions);
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
      const id = new URL(worker.url()).host;
      // A fresh profile is an install, so the background opens the welcome page (FRU-318). It opens
      // active, whenever the install event comes: after a spec brought its site to the front, it
      // would be the tab the popup reads. So it is waited for, and closed, before any spec runs.
      const welcome = `chrome-extension://${id}/welcome.html`;
      await expect.poll(() => context.pages().some((page) => page.url() === welcome), { timeout: 10_000 }).toBe(true);
      if (!keepWelcome) {
        for (const page of context.pages().filter((each) => each.url() === welcome)) await page.close();
      }
      await use({ context, worker, id });
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
function copyWithLocalAccess(directory: string, extraPermissions: string[] = []): string {
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
  // A host (`<all_urls>`, or a pattern with a scheme) is a host permission in MV3, not a permission.
  const hosts = extraPermissions.filter((each) => each === '<all_urls>' || each.includes('://'));
  const others = extraPermissions.filter((each) => !hosts.includes(each));
  if (hosts.length > 0) manifest.host_permissions = [...(manifest.host_permissions as string[]), ...hosts];
  if (others.length > 0) {
    manifest.permissions = [...((manifest.permissions as string[] | undefined) ?? []), ...others];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  return directory;
}

/**
 * The bare playground, on a page URL of its own.
 *
 * The parameters are in canonical order, so `seedsOn` can read the stored seeds with the raw URL.
 */
export async function openBareSite(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?case=${caseOf(testCase)}&widget=off`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await hydrated(page);
}

/** A rule for the playground origin, added through the options page, and registered by the background. */
export async function addRule(
  extension: LoadedExtension,
  rule: { endpoint: string } & ({ mode: 'private'; clientId: string } | { mode: 'team' }),
): Promise<void> {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  // The page of the extension (FRU-301): « Add a site » opens the form in the panel.
  await options.getByRole('button', { name: 'Add a site' }).click();
  await options.getByLabel('Sites', { exact: true }).fill(PLAYGROUND_ORIGIN);
  // The name of a select in a label includes the chosen option, so it only starts with the label.
  await options.getByLabel(/^Mode/).selectOption(rule.mode);
  await options.getByLabel('Worker endpoint', { exact: true }).fill(rule.endpoint);
  if (rule.mode === 'private') await options.getByLabel('Client id', { exact: true }).fill(rule.clientId);
  await options.getByRole('button', { name: 'Add rule' }).click();
  await expect(options.locator(`tr.rule-row[data-pattern="${PLAYGROUND_ORIGIN}"]`)).toContainText('Granted');
  await options.close();

  // The background registers the two scripts of the origin after the storage change (FRU-74: a
  // pair for each origin). A page loaded before that gets neither.
  await expect
    .poll(() =>
      extension.worker.evaluate(
        async (pattern) =>
          (await chrome.scripting.getRegisteredContentScripts()).filter((script) => script.matches?.includes(pattern))
            .length,
        `${PLAYGROUND_ORIGIN}/*`,
      ),
    )
    .toBe(2);
}

/**
 * The popup, for the site in `site`.
 *
 * The popup acts on the active tab of its window. It opens behind the site, so the site stays that tab.
 */
export async function openPopup(extension: LoadedExtension, site: Page, _origin = PLAYGROUND_ORIGIN): Promise<Page> {
  await site.bringToFront();
  const url = `chrome-extension://${extension.id}/popup.html`;
  await extension.worker.evaluate(async (popupUrl) => {
    await chrome.tabs.create({ url: popupUrl, active: false });
  }, url);

  let popup: Page | undefined;
  await expect.poll(() => (popup = extension.context.pages().find((page) => page.url() === url))).toBeDefined();
  if (popup === undefined) throw new Error('the popup did not open');

  // A screen is drawn: the shell, past the screen that says it is loading. Screen 1 of the mock-up
  // of 2026-10-20 names no host (FRU-297), so the host is no longer what says the popup is ready.
  await expect(popup.locator('.popup .popup-body')).toBeVisible();
  await expect(popup.getByRole('status').filter({ hasText: /^(Loading…|Chargement…)$/ })).toHaveCount(0);

  return popup;
}

/**
 * A click in the popup that closes it (FRU-375): the side panel, « Leave feedback ».
 *
 * The popup calls `window.close()` when the click is done. When that is fast (the side panel is
 * already open, so `sidePanel.open` answers at once), the popup closes before Playwright has the
 * answer to its click, and `click()` rejects with « Target page, context or browser has been
 * closed ». That error is the expected end here. Any other error, or a popup that stays open, fails.
 */
export async function clickThatClosesPopup(popup: Page, target: Locator): Promise<void> {
  const closed = popup.waitForEvent('close');
  await target.click().catch((error: unknown) => {
    if (!popup.isClosed()) throw error;
  });
  await closed;
}

/** A pairing code for the workspace of the worker of the suite: see `mintPairing`. */
export async function mintPairingCode(name: string): Promise<string> {
  return (await mintPairing(name)).code;
}

/**
 * A code and the link that carries it (FRU-92), from the worker that will take the code.
 *
 * The worker of the suite keeps its sessions in a database that lives in its process (FRU-223), so
 * the `pair` command, which is another process, cannot write there. `dev-worker.fixture.ts` answers
 * `POST /__dev/pair` with what the command prints: the code, and the link of `pairingLink`. The
 * command itself is tested in `cli.test.ts`.
 */
export async function mintPairing(
  name: string,
  endpoint = AUTHENTICATED_WORKER_ORIGIN,
): Promise<{ code: string; link: string }> {
  const answer = await fetch(`${endpoint}/__dev/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, endpoint }),
  });
  if (!answer.ok) throw new Error(`the worker minted no pairing code: ${answer.status} ${await answer.text()}`);

  return (await answer.json()) as { code: string; link: string };
}

/** Pair from the popup, for the site in `site`. */
export async function pairFromPopup(extension: LoadedExtension, site: Page, code: string, name: string): Promise<void> {
  const popup = await openPopup(extension, site);

  // The field is one step away since FRU-92: a link is the first way in.
  await popup.getByRole('button', { name: 'I have a code' }).click();
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
        // The prefix without its colon, so a session key per endpoint and one per run (FRU-65) both match.
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
