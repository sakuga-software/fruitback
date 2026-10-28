import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * The published code against the servers of this commit (FRU-460): the last npm packages and the
 * last released extension. `node e2e/published/fetch.ts` fetches them first. The servers are the
 * ones of `playwright.config.ts`. The workflow `published.yml` runs it; `dev-loop.md` says when.
 *
 * Its specs end in `.published.ts`, which the main suite does not match.
 */
export default defineConfig({
  ...base,
  testDir: './e2e/published',
  testMatch: '**/*.published.ts',
});
