import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// The tests of the worker (FRU-346). docs/decisions/conventions.md says why each option is set.
const concurrency = process.env.FRUITBACK_TEST_CONCURRENCY;

/**
 * On CI, one test file for each core (FRU-479). vitest keeps one core for itself by default: 3 files
 * at a time on the 4 vCPU of a runner. Its own process waits most of the time, and the tests of the
 * worker are bound by the CPU of PGlite. Elsewhere the default stays: the machine runs other work.
 */
function workers(): number | undefined {
  if (concurrency) return Number(concurrency);

  return process.env.CI ? availableParallelism() : undefined;
}

const maxWorkers = workers();

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/vitest-setup.fixture.ts'],
    // One child process for each test file, as under `node --test`: a PGlite database, an
    // environment variable or a mock never passes from one file to the next (FRU-339).
    pool: 'forks',
    isolate: true,
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    // `node --test` has no time limit on a test. Some cases start a server or a real PostgreSQL.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
