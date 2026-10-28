import { defineConfig, devices } from '@playwright/test';
import { filesOfShard } from './e2e/shards.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './e2e/worker-sessions.ts';

/**
 * The E2E suite (FRU-19).
 *
 * It exists for the two things a DOM emulator cannot vouch for and that this product happens to rest
 * on: a real selector engine (`CSS.escape`, attribute quoting) and real layout (`getBoundingClientRect`,
 * scroll, reflow). Everything else is already covered by `node --test`, and stays there — this suite
 * is deliberately small, because a slow E2E suite is one nobody runs.
 *
 * Both servers are started here, the worker on its in-memory Linear, so a run needs no API key and
 * writes to nobody's workspace.
 */

const PLAYGROUND = 'http://localhost:5177';
/** The dev port, not the container's 8080 — see `DEFAULT_WORKER_ORIGIN`. */
const WORKER = 'http://localhost:8788';

/** Workers of one run. Locally, one: the machine runs other work too. */
const WORKERS = process.env.CI ? 4 : 1;

export default defineConfig({
  testDir: './e2e',
  // One part of the suite on CI, chosen by the duration of its files and not by the count of its
  // tests (`e2e/shards.ts`). Not `--shard`: it gave one part twice the time of another.
  ...(process.env.E2E_SHARD === undefined
    ? {}
    : { testMatch: filesOfShard(process.env.E2E_SHARD, 'e2e').map((file) => `**/e2e/${file}`) }),
  // Runs after the servers are up and before the first spec: see `warm-up.ts` for what it absorbs.
  globalSetup: './e2e/warm-up.ts',
  // The worker's fake Linear is one process-wide store, so the specs share state. They stay apart by
  // capturing on a different page URL each — the note's page identity — rather than by locking. So
  // files run side by side on CI (FRU-268); the tests of one file still run in order, in one worker.
  workers: WORKERS,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: PLAYGROUND,
    ...devices['Desktop Chrome'],
    // The widget follows the browser's language (FRU-37), and the specs find its chrome by English names.
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
    video: process.env.CI ? 'off' : 'retain-on-failure',
  },
  webServer: [
    {
      // Not the `--watch` variant: Playwright kills the process it spawned, and a watcher would
      // leave its child behind on CI.
      command: 'pnpm --filter @fruitback/worker serve:pglite',
      url: `${WORKER}/health`,
      // Never reused. A worker already on this port holds the notes and the sessions of whoever
      // started it, and maybe not the rate limit below.
      reuseExistingServer: false,
      env: {
        // Every request comes from the same loopback address, so the production ceiling of 20/min
        // would be hit mid-suite and report itself as a mystery 429.
        RATE_LIMIT_PER_MINUTE: '2000',
        TRUSTED_PROXY_HOPS: '0',
      },
    },
    {
      // The team mode's worker. On a site that everyone reads, a pin read back proves nothing about
      // the relay, because the page could read it with no credential: the site of this worker is
      // read by a session of its workspace only. It has a database of its own, so a spec pairs with
      // the worker it is about to ask.
      command: 'pnpm --filter @fruitback/worker serve:pglite',
      url: `${AUTHENTICATED_WORKER_ORIGIN}/health`,
      reuseExistingServer: false,
      env: {
        PORT: new URL(AUTHENTICATED_WORKER_ORIGIN).port,
        FRUITBACK_DEV_VISIBILITY: 'members',
        // The notes of this worker are in its database, where the first one keeps them on the Linear
        // in memory: the specs of the widget read the states and the replies that only it gives.
        FRUITBACK_STORE: 'postgres',
        RATE_LIMIT_PER_MINUTE: '2000',
        TRUSTED_PROXY_HOPS: '0',
      },
    },
    {
      // Vite, not a `node --watch` process: HMR replaces modules instead of restarting the server,
      // which is what stopped a source edit from killing the suite mid-run.
      command: 'pnpm --filter @fruitback/playground dev',
      url: PLAYGROUND,
      reuseExistingServer: !process.env.CI,
      env: { VITE_FRUITBACK_WORKER: WORKER },
    },
    {
      // The console of the Cloud, on its own fixed port (FRU-159). Its specs measure layout and answer
      // the worker's calls with stubs, so it needs no worker with accounts.
      command: 'pnpm --filter @fruitback/console dev',
      url: 'http://localhost:5178',
      reuseExistingServer: !process.env.CI,
      env: { VITE_FRUITBACK_API: WORKER },
    },
  ],
});
