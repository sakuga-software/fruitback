import { type ChildProcess, spawn } from 'node:child_process';
import { type BrowserContext, type Page, expect } from '@playwright/test';
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

/**
 * Starts a worker of the Cloud on PGlite, in a process of its own: `cloud-worker.fixture.ts` says
 * why it is not imported here.
 */
export async function cloudWorker(options: { mail?: boolean } = {}): Promise<Worker> {
  const child: ChildProcess = spawn(process.execPath, ['src/cloud-worker.fixture.ts'], {
    // Relative to the root of the repository, where Playwright runs: a spec has no `import.meta.url`.
    cwd: 'apps/worker',
    env: {
      ...process.env,
      CLOUD_WORKER: JSON.stringify({ consoleUrl: CONSOLE, publicUrl: WORKER_ORIGIN, ...options }),
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let said = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      const found = /cloud-worker listening on (\d+)/.exec(said)?.[1];
      if (found !== undefined) resolve(found);
    });
    child.once('exit', (code) => reject(new Error(`the worker of the test stopped with ${code}: ${said}`)));
  });
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
