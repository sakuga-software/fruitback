import { type ChildProcess, spawn } from 'node:child_process';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A worker of the Cloud for a spec of the console (FRU-148, FRU-104): a process of its own, on PGlite,
 * that answers each request the browser sends to the address of the worker. No stub decides an answer.
 */
export const CONSOLE = 'http://localhost:5178';
export const SESSION_COOKIE = 'fruitback.session_token';

export type Received = { method: string; path: string; authorization: boolean; cookie: boolean };
export type Worker = {
  /** Where the process of the worker listens. The console asks `WORKER_ORIGIN`: see `served`. */
  origin: string;
  /** The text of each message the worker was asked to send, in order. */
  sent(): Promise<string[]>;
  /** Each message the worker was asked to send, with its address, in order. */
  mail(): Promise<{ to: string; subject: string; text: string }[]>;
  received(): Promise<Received[]>;
  /** What the worker writes in its log for its first administrator when it starts (FRU-221). */
  firstAdminLines(email: string): Promise<string[]>;
  /** Stops the process, and answers when it is gone. */
  close(): Promise<void>;
};

type Started = { child: ChildProcess; port: string };

/** Spawns the process of a worker of the Cloud, and answers when it listens. */
function spawnWorker(options: { mail?: boolean }): Promise<Started> {
  const child: ChildProcess = spawn(process.execPath, ['src/cloud-worker.fixture.ts'], {
    // Relative to the root of the repository, where Playwright runs: a spec has no `import.meta.url`.
    cwd: 'apps/worker',
    env: {
      ...process.env,
      CLOUD_WORKER: JSON.stringify({ consoleUrl: CONSOLE, publicUrl: WORKER_ORIGIN, ...options }),
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  // A spare that no test takes must not keep the Playwright worker alive. It stops with its parent.
  child.unref();
  child.channel?.unref();
  (child.stdout as { unref?: () => void } | null)?.unref?.();

  return new Promise<Started>((resolve, reject) => {
    let said = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      const found = /cloud-worker listening on (\d+)/.exec(said)?.[1];
      if (found !== undefined) resolve({ child, port: found });
    });
    child.once('exit', (code) => reject(new Error(`the worker of the test stopped with ${code}: ${said}`)));
  });
}

/**
 * One process that starts before a test asks for it, per set of options, in each Playwright worker.
 *
 * A worker starts in 2 to 3 s on this machine, and in 8 s on a CI runner where four browsers and four
 * servers share four cores (trace of run 40718203870). That was a quarter of the 30 s of a test, and
 * two tests that sign in three browsers, or wait out the 5 s interval of a claim twice, went over it.
 * Each test still gets a new process with an empty database: only the time of its start moves.
 */
const spares = new Map<string, Promise<Started>>();

function spareOf(options: { mail?: boolean }): Promise<Started> {
  const started = spawnWorker(options);
  // A spare that fails is reported to the test that takes it, not as an unhandled rejection.
  started.catch(() => {});

  return started;
}

/**
 * Starts a worker of the Cloud on PGlite, in a process of its own: `cloud-worker.fixture.ts` says
 * why it is not imported here.
 *
 * The time the test waits for the process is added to its timeout: the timeout is for the steps of
 * the test, not for the start of its worker. With a spare that is ready, that time is about 0.
 */
export async function cloudWorker(options: { mail?: boolean } = {}): Promise<Worker> {
  const key = JSON.stringify(options);
  const spare = spares.get(key);
  spares.delete(key);
  const asked = performance.now();
  let started = spare === undefined ? undefined : await spare.catch(() => undefined);
  // A spare that stopped before a test took it is replaced by a new one.
  if (started === undefined || started.child.exitCode !== null || started.child.signalCode !== null) {
    started = await spawnWorker(options);
  }
  const info = test.info();
  info.setTimeout(info.timeout + Math.ceil(performance.now() - asked));
  spares.set(key, spareOf(options));
  const { child, port } = started;
  const origin = `http://127.0.0.1:${port}`;
  // A worker that stops while its spec runs leaves every request of its pages without an answer: say
  // it, so the log of a failed run has the cause, not only « Loading… » (FRU-275).
  let closing = false;
  child.once('exit', (code, signal) => {
    if (!closing) console.error(`[e2e] the worker of the test at ${origin} stopped: code ${code}, signal ${signal}`);
  });
  const read = async <T>(path: string): Promise<T> => (await (await fetch(`${origin}${path}`)).json()) as T;

  return {
    origin,
    sent: async () => (await read<{ text: string }[]>('/__test/sent')).map((each) => each.text),
    mail: () => read<{ to: string; subject: string; text: string }[]>('/__test/sent'),
    received: () => read<Received[]>('/__test/received'),
    firstAdminLines: (email) => read<string[]>(`/__test/first-admin?email=${encodeURIComponent(email)}`),
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        closing = true;
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** Hands each request for the worker to `worker`, and its answer back to the browser, cookies included. */
export async function served(on: Page | BrowserContext, worker: Worker): Promise<void> {
  const context = 'context' in on ? on.context() : on;
  await context.route(`${WORKER_ORIGIN}/**`, async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({ url: `${worker.origin}${asked.pathname}${asked.search}`, maxRedirects: 0 });

    await route.fulfill({ response });
  });
}

/**
 * Ends a test: the routes first, then the worker.
 *
 * WARNING: a screen of the console goes on asking after the element a test waited for is there (the
 * title of « Sites » is drawn before its list is read). A request that is still in the handler of
 * `served` when Playwright closes the context makes the handler throw « Target page, context or
 * browser has been closed », and Playwright fails a test whose every assertion passed: one run in
 * four of the last test of this file, measured with `--repeat-each 20`. `ignoreErrors` takes the
 * routes away and lets such a request fail in silence. The worker stops after: a request must not be
 * handed to a process that is gone.
 */
export async function finished(on: Page | BrowserContext, worker: Worker | undefined): Promise<void> {
  const context = 'context' in on ? on.context() : on;
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await worker?.close();
}

/** The link of the last mail, as the person finds it in the message. */
export async function linkIn(worker: Worker): Promise<string> {
  const link = /http:\/\/\S+/.exec((await worker.sent()).at(-1) ?? '')?.[0];
  expect(link, 'no link in the mail').toMatch(new RegExp(`^${CONSOLE}/sign-in#`));

  return link as string;
}
