import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, type Locator, type Page, type Worker, chromium, expect } from '@playwright/test';
import {
  BUILT_EXTENSION,
  type LoadedExtension,
  PLAYGROUND_ORIGIN,
  addRule,
  copyWithLocalAccess,
  mintPairing,
  mountTheSiteWidget,
  pairFromPopup,
} from './extension.ts';

/**
 * The bench of the extension (FRU-426): what an agent needs to test the extension as a person uses
 * it, in team mode. See « The bench of the extension » in `docs/decisions/extension.md`.
 *
 * `startBench` starts a worker of development on a port of its own (a database in its process, a
 * site of the playground that members only read, its notes sent through a Linear connector to a
 * fake Linear), the playground if nothing serves it, and a Chromium with a profile of its own and a
 * copy of the built extension. The rule of the site is added and the extension is paired.
 *
 * Import it from a spec, or from a Node script at the root of the repository: it needs no runner
 * of Playwright. Run `pnpm ext:bench` to keep one open.
 */

/** What the fake Linear of the worker received: see `linear-fake.fixture.ts`. */
export type TrackerReceived = {
  issues: { id: string; identifier: string; title: string; description: string }[];
  uploads: { name: string; type: string; size: number }[];
  puts: { url: string; type: string; bytes: number; sha256: string }[];
  attachments: { issueId: string; title: string; url: string }[];
};

export type Attachment = 'page' | 'area' | { name: string; mimeType: string; buffer: Buffer };

export type BenchOptions = {
  /** A window on the screen. The default: headed for a person or an agent, `false` in the E2E suite. */
  headed?: boolean;
  /** Pair the extension with the worker, and add the rule of the site. The default is `true`. */
  paired?: boolean;
  /**
   * More unpacked extensions to load beside the copy of the build, for FRU-397: two copies of
   * Fruitback in one profile. `'copy'` loads a second copy of the same build.
   */
  moreCopies?: ('copy' | string)[];
  /** The name the worker gives the session, and so the notes. */
  reviewer?: string;
  /** Messages of the bench, for a person who watches it. */
  log?: (line: string) => void;
};

export type Bench = {
  context: BrowserContext;
  /** The copy of the build the bench drives. */
  extension: LoadedExtension;
  /** The ids of the other copies, in the order of `moreCopies`. */
  moreCopies: string[];
  /** The address of the worker of the bench. */
  worker: string;
  /** The site in a new tab, `/?case=<name>&widget=off`, with the dormant widget of a team-mode site. */
  openSite(name?: string): Promise<Page>;
  /** Pairs the extension with the worker, from the popup, as `pnpm ext:bench` does at its start. */
  signIn(site: Page): Promise<void>;
  /**
   * The click on the icon of the extension on `site`: `Extensions.triggerAction` of the DevTools
   * protocol. Chromium opens the popup and grants `activeTab`, as for a click of a person.
   */
  grantActiveTab(site: Page): Promise<void>;
  /** A note on `target` (the latte card by default), with its files, sent. Throws with the words of a file refused. */
  leaveNote(site: Page, note: { text: string; attach?: Attachment[]; target?: Locator }): Promise<void>;
  trackerReceived(): Promise<TrackerReceived>;
  screenshot(site: Page, file: string): Promise<void>;
  close(): Promise<void>;
};

/** Signs nothing outside this machine: the key that seals the key of the fake Linear connector. */
const BENCH_SECRETS_KEY = 'dev-only-secrets-key-of-the-bench-never-deployed';
const LAUNCHER = 'Team feedback';

export async function startBench(options: BenchOptions = {}): Promise<Bench> {
  const log = options.log ?? (() => undefined);
  if (!fs.existsSync(path.join(BUILT_EXTENSION, 'manifest.json'))) {
    throw new Error(`${BUILT_EXTENSION} is not built. Run pnpm ext:bench, which builds it first.`);
  }
  const stops: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      for (const stop of [...stops].reverse()) await stop().catch(() => undefined);
    })());

  try {
    const worker = await startWorker(await freePort());
    stops.push(worker.stop);
    log(
      `worker: ${worker.origin} (a database in its process, the site « playground » for members only, a fake Linear)`,
    );
    const playground = await ensurePlayground();
    if (playground !== undefined) stops.push(playground);
    log(`site: ${PLAYGROUND_ORIGIN}`);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitback-bench-'));
    stops.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const main = copyWithLocalAccess(path.join(root, 'extension'), [], [worker.origin]);
    const others = (options.moreCopies ?? []).map((each, index) =>
      each === 'copy' ? copyWithLocalAccess(path.join(root, `copy-${index + 2}`), [], [worker.origin]) : each,
    );
    const directories = [main, ...others];
    const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      channel: 'chromium',
      headless: !(options.headed ?? true),
      // Playwright stops the browser and the process on these signals, before `close` stops the
      // worker and the playground. The bench stops all of it itself.
      handleSIGINT: false,
      handleSIGTERM: false,
      baseURL: PLAYGROUND_ORIGIN,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      args: [`--disable-extensions-except=${directories.join(',')}`, `--load-extension=${directories.join(',')}`],
    });
    stops.push(() => context.close());

    const [id, ...moreIds] = directories.map(unpackedId);
    const serviceWorker = await serviceWorkerOf(context, id as string);
    for (const other of moreIds) await serviceWorkerOf(context, other);
    // A first install opens the welcome page of each copy (FRU-318). Closed, so the site is the active tab.
    await expect
      .poll(() => context.pages().filter((page) => page.url().endsWith('/welcome.html')).length, { timeout: 10_000 })
      .toBe(directories.length);
    for (const page of context.pages().filter((each) => each.url().endsWith('/welcome.html'))) await page.close();
    const extension: LoadedExtension = { context, worker: serviceWorker, id: id as string };
    log(`extension: ${id}${moreIds.length > 0 ? `, more copies: ${moreIds.join(', ')}` : ''}`);

    const reviewer = options.reviewer ?? 'Bench Reviewer';
    let cases = 0;
    const bench: Bench = {
      context,
      extension,
      moreCopies: moreIds,
      worker: worker.origin,
      async openSite(name) {
        cases += 1;
        const page = await context.newPage();
        await page.goto(`/?case=${name ?? `bench-${Date.now()}-${cases}`}&widget=off`);
        await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
        await mountTheSiteWidget(page, worker.origin);

        return page;
      },
      async signIn(site) {
        await pairFromPopup(extension, site, (await mintPairing(reviewer, worker.origin)).code, reviewer);
        await site.bringToFront();
        await site.reload();
        await expect(site.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
        await mountTheSiteWidget(site, worker.origin);
        await expect(site.getByRole('button', { name: LAUNCHER })).toBeVisible();
      },
      async grantActiveTab(site) {
        await site.bringToFront();
        await triggerAction(context, extension, site);
        // The popup that the click opens takes the focus. The grant stays with the tab.
        await site.bringToFront();
      },
      async leaveNote(site, note) {
        await site.getByRole('button', { name: LAUNCHER }).click();
        await (note.target ?? site.locator('[data-testid="card-latte"] .add')).click();
        for (const file of note.attach ?? []) await attach(site, file);
        const pins = await site.locator('[data-fruitback-pin]').count();
        await site.getByPlaceholder('What should change?').fill(note.text);
        await site.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(site.locator('[data-fruitback-pin]')).toHaveCount(pins + 1);
      },
      trackerReceived: async () => (await (await fetch(`${worker.origin}/__dev/tracker`)).json()) as TrackerReceived,
      async screenshot(site, file) {
        await site.screenshot({ path: file });
      },
      close,
    };

    if (options.paired ?? true) {
      await addRule(extension, { mode: 'team', endpoint: worker.origin });
      const site = await bench.openSite('bench-sign-in');
      await bench.signIn(site);
      await site.close();
      log(`paired as ${reviewer}`);
    }

    return bench;
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The id Chromium gives an unpacked extension: the first 32 hex digits of the SHA-256 of its
 * absolute path, each digit written `a` to `p`.
 */
function unpackedId(directory: string): string {
  const digest = createHash('sha256').update(fs.realpathSync(directory)).digest('hex').slice(0, 32);

  return [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

async function serviceWorkerOf(context: BrowserContext, id: string): Promise<Worker> {
  const prefix = `chrome-extension://${id}/`;
  const found = (): Worker | undefined => context.serviceWorkers().find((each) => each.url().startsWith(prefix));
  await expect.poll(found, { message: `no service worker of the extension ${id}`, timeout: 10_000 }).toBeDefined();

  return found() as Worker;
}

/**
 * `Extensions.triggerAction` runs the action of the extension on a tab, as the click on its icon
 * does. Chromium wants the id of the *tab* target, which differs from the target of the page.
 * Playwright 1.58 does not type the method, so the call is typed here.
 */
async function triggerAction(context: BrowserContext, extension: LoadedExtension, site: Page): Promise<void> {
  const browser = context.browser();
  if (browser === null) throw new Error('this context gives no browser, so no session of the DevTools protocol');
  const session = (await browser.newBrowserCDPSession()) as unknown as {
    send(
      method: 'Target.getTargets',
      params: { filter: { type: string }[] },
    ): Promise<{
      targetInfos: { targetId: string; url: string }[];
    }>;
    send(method: 'Extensions.triggerAction', params: { id: string; targetId: string }): Promise<void>;
    detach(): Promise<void>;
  };
  try {
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tabs = targetInfos.filter((each) => each.url === site.url());
    if (tabs.length !== 1) {
      throw new Error(`${tabs.length} tabs show ${site.url()}: give the site a page of its own (openSite names one)`);
    }
    await session.send('Extensions.triggerAction', {
      id: extension.id,
      targetId: (tabs[0] as { targetId: string }).targetId,
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function attach(site: Page, file: Attachment): Promise<void> {
  const files = site.getByRole('group', { name: 'Attachments' });
  const items = site.locator('.fruitback-composer-file');
  const before = await items.count();
  if (file === 'page' || file === 'area') {
    await files.getByRole('button', { name: 'Attach' }).click();
    await files.getByRole('menuitem', { name: file === 'page' ? 'Capture the whole page' : 'Capture an area' }).click();
    if (file === 'area') {
      // The area of the keyboard: drawn in the middle, moved, made larger, taken.
      await expect(site.getByRole('dialog', { name: 'Choose an area of the page' })).toBeVisible();
      await site.keyboard.press('ArrowRight');
      await site.keyboard.press('Shift+ArrowDown');
      await site.keyboard.press('Enter');
    }
  } else {
    await site.locator('[data-fruitback-attach-file-input]').setInputFiles(file);
  }
  await expect(items).toHaveCount(before + 1);
  const added = items.nth(before);
  await expect(added).not.toHaveAttribute('data-fruitback-file', /^(?:reading|sending|uploading)$/);
  const state = await added.getAttribute('data-fruitback-file');
  if (state !== 'ready') throw new Error(`the file was not joined (${state}): ${await added.textContent()}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));

  return port;
}

async function answers(url: string): Promise<boolean> {
  return fetch(url).then(
    (response) => response.ok,
    () => false,
  );
}

async function startWorker(port: number): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['src/dev-worker.fixture.ts'], {
    // Relative to the root of the repository: a spec has no `import.meta.url`.
    cwd: 'apps/worker',
    env: {
      ...process.env,
      PORT: String(port),
      FRUITBACK_DEV_VISIBILITY: 'members',
      FRUITBACK_STORE: 'postgres',
      FRUITBACK_DEV_LINEAR: 'fake',
      FRUITBACK_SECRETS_KEY: BENCH_SECRETS_KEY,
      RATE_LIMIT_PER_MINUTE: '2000',
      TRUSTED_PROXY_HOPS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  child.stdout?.on('data', (chunk: Buffer) => (said += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (said += chunk.toString()));
  const stop = (): Promise<void> => stopProcess(child);
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null) throw new Error(`the worker of the bench stopped with ${child.exitCode}: ${said}`);

        return answers(`${origin}/health`);
      },
      { timeout: 30_000 },
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      await stop();
      throw error;
    });

  return { origin, stop };
}

/** Starts the playground when nothing answers on its port, and answers how to stop it. */
async function ensurePlayground(): Promise<(() => Promise<void>) | undefined> {
  if (await answers(PLAYGROUND_ORIGIN)) return undefined;
  // A group of its own: pnpm starts React Router, which starts Vite, and the stop reaches all three.
  const child = spawn('pnpm', ['--filter', '@fruitback/playground', 'dev'], { stdio: 'ignore', detached: true });
  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await answers(PLAYGROUND_ORIGIN))) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  await expect
    .poll(() => answers(PLAYGROUND_ORIGIN), { timeout: 60_000 })
    .toBe(true)
    .catch(async (error: unknown) => {
      await stop();
      throw error;
    });

  return stop;
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
}

async function main(): Promise<void> {
  const bench = await startBench({ log: (line) => console.log(`[bench] ${line}`) });
  const site = await bench.openSite('bench');
  await site.bringToFront();
  console.log(`[bench] ready: ${site.url()}. The tracker: ${bench.worker}/__dev/tracker. Ctrl-C stops the bench.`);
  const stop = async (): Promise<void> => {
    await bench.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  bench.context.once('close', () => void stop());
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve('e2e/bench.ts')) {
  main().catch((error: unknown) => {
    console.error('[bench]', error);
    process.exit(1);
  });
}
