import { defineConfig } from 'vitest/config';

// The tests of the worker (FRU-346). docs/decisions/conventions.md says why each option is set.
const concurrency = process.env.FRUITBACK_TEST_CONCURRENCY;

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/vitest-setup.fixture.ts'],
    // One child process for each test file, as under `node --test`: a PGlite database, an
    // environment variable or a mock never passes from one file to the next (FRU-339).
    pool: 'forks',
    isolate: true,
    ...(concurrency ? { maxWorkers: Number(concurrency) } : {}),
    // `node --test` has no time limit on a test. Some cases start a server or a real PostgreSQL.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
