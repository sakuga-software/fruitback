import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E suite (SKG-511).
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

export default defineConfig({
  testDir: './e2e',
  // Runs after the servers are up and before the first spec: see `warm-up.ts` for what it absorbs.
  globalSetup: './e2e/warm-up.ts',
  // The worker's fake Linear is one process-wide store, so the specs share state. They stay apart by
  // capturing on a different page URL each — the seed's page identity — rather than by locking.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: PLAYGROUND,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
    video: process.env.CI ? 'off' : 'retain-on-failure',
  },
  webServer: [
    {
      // Not the `--watch` variants: Playwright kills the process it spawned, and a watcher would
      // leave its child behind on CI.
      command: 'pnpm --filter @fruitback/worker serve:fake',
      url: `${WORKER}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        ALLOWED_ORIGINS: PLAYGROUND,
        // Every request comes from the same loopback address, so the production ceiling of 20/min
        // would be hit mid-suite and report itself as a mystery 429.
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
  ],
});
