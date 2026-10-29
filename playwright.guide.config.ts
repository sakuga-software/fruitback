import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * The captures of the guide (FRU-486): `pnpm guide:captures`, on a Mac of the `sakuga-mac` pool.
 *
 * The suite's own configuration, for `first-note.spec.ts` alone, in capture mode (`e2e/guide.ts`):
 * a capture that changed is written to `docs/assets/guide/`, one that did not is left alone. No
 * retry: a second attempt would see the captures of the first as the ones of the repository.
 */
process.env.FRUITBACK_GUIDE_CAPTURE = '1';

export default defineConfig({
  ...base,
  testMatch: '**/e2e/first-note.spec.ts',
  snapshotPathTemplate: '{testDir}/../docs/assets/guide/{arg}{ext}',
  updateSnapshots: 'changed',
  retries: 0,
  workers: 1,
});
