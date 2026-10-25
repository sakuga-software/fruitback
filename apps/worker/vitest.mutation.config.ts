import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import base from './vitest.config.ts';

/**
 * The tests of the worker under StrykerJS (FRU-451): the same tests as `vitest.config.ts`, in
 * another order. docs/decisions/conventions.md gives the measurements.
 *
 * vitest runs the largest test files first, then the longest. A mutant then runs the route tests on
 * PGlite before the unit test that kills it in some milliseconds. Here the test of the mutated file
 * runs first, then the other files, smallest first. `MUTATE` is the file of the job, as the workflow
 * gives it to `stryker run --mutate`.
 */
export function mutationOrder(files: { path: string; size: number }[], mutated: string | undefined): string[] {
  const own = mutated?.replace(/\.ts$/, '.test.ts');

  return [...files]
    .sort((a, b) => Number(b.path === own) - Number(a.path === own) || a.size - b.size || a.path.localeCompare(b.path))
    .map((file) => file.path);
}

class MutationSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const path = (file: TestSpecification) => relative(this.ctx.config.root, file.moduleId);
    const byPath = new Map(files.map((file) => [path(file), file]));
    const order = mutationOrder(
      files.map((file) => ({ path: path(file), size: statSync(file.moduleId).size })),
      process.env.MUTATE,
    );

    return order.map((file) => byPath.get(file)!);
  }
}

export default mergeConfig(base, defineConfig({ test: { sequence: { sequencer: MutationSequencer } } }));
