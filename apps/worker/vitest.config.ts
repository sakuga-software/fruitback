import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/node';

// The tests of the worker (FRU-346). docs/decisions/conventions.md says why each option is set.
const concurrency = process.env.FRUITBACK_TEST_CONCURRENCY;

// FRU-480. CI runs these files in two parts, on two runners. `FRUITBACK_TEST_SHARD` is the part,
// `1/2` or `2/2`, and `FRUITBACK_TEST_FILES` is where the part writes the files it ran.
// `tools/ci/test-parts.ts` then checks that each file ran in one part exactly.
const shard = process.env.FRUITBACK_TEST_SHARD;
const filesRun = process.env.FRUITBACK_TEST_FILES;
const here = fileURLToPath(new URL('.', import.meta.url));

/** Writes each test file of the run, one per line, relative to this package. */
function writeFilesRun(path: string): Reporter {
  return {
    onTestRunEnd(testModules) {
      const files = testModules.map((testModule) => relative(here, testModule.moduleId)).sort();
      writeFileSync(path, files.map((file) => `${file}\n`).join(''));
    },
  };
}

export default defineConfig({
  test: {
    // `tools/ci/test-parts.ts` lists the files with the same pattern.
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/vitest-setup.fixture.ts'],
    // One child process for each test file, as under `node --test`: a PGlite database, an
    // environment variable or a mock never passes from one file to the next (FRU-339).
    pool: 'forks',
    isolate: true,
    ...(concurrency ? { maxWorkers: Number(concurrency) } : {}),
    // vitest cuts by the count of files, in the order of a hash of their path.
    ...(shard ? { shard } : {}),
    ...(filesRun ? { reporters: [...configDefaults.reporters, writeFilesRun(filesRun)] } : {}),
    // `node --test` has no time limit on a test. Some cases start a server or a real PostgreSQL.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
