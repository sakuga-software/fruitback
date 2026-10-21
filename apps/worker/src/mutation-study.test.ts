import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cost, inconsistent, killers } from '../../../tools/mutation-study/cost.ts';

/**
 * `tools/mutation-study/cost.ts` (FRU-342) replays a mutation run from its reports. Its test lives
 * here, as the one of `tools/mutation/` lives in `mutation.test.ts`: `tools/` has no `test` script
 * that `test-discovery.test.ts` would read. It imports no mutated file, so no mutant runs it.
 *
 * A run of the `tap` runner on four test files, `a` to `d`, in that order. Each mutant runs the files
 * that reach it, in order, and stops at the first that fails.
 */
const tests = ['a', 'b', 'c', 'd'];
const killedByC = { id: '1', status: 'Killed', coveredBy: ['a', 'b', 'c'], killedBy: ['c'], testsCompleted: 3 };
const killedByA = { id: '2', status: 'Killed', coveredBy: ['a', 'd'], killedBy: ['a'], testsCompleted: 1 };
const survivor = { id: '3', status: 'Survived', coveredBy: ['b', 'd'], testsCompleted: 2 };
const timeout = { id: '4', status: 'Timeout', coveredBy: ['a', 'b', 'c', 'd'] };
const unreached = { id: '5', status: 'NoCoverage', coveredBy: [] };
const mutants = [killedByC, killedByA, survivor, timeout, unreached];

describe('inconsistent', () => {
  it('accepts a run where each killed mutant stops at its killer and each survivor runs every file', () => {
    assert.deepEqual(inconsistent(mutants), []);
  });

  it('names a killed mutant that ran past its killer, and a survivor that skipped a file', () => {
    const pastKiller = { ...killedByA, testsCompleted: 2 };
    const skipped = { ...survivor, testsCompleted: 1 };

    assert.deepEqual(inconsistent([pastKiller, skipped, killedByC]), [pastKiller, skipped]);
  });
});

describe('killers', () => {
  it('counts the mutants each file killed first, and nothing for a timeout or a survivor', () => {
    assert.deepEqual(
      killers(mutants),
      new Map([
        ['c', 1],
        ['a', 1],
      ]),
    );
  });
});

describe('cost', () => {
  it('counts the files reached and run, as the bail of the tap runner runs them', () => {
    const all = cost(mutants, tests, undefined);

    // Reached: 3 + 2 + 2 + 4 + 0. Ran: 3 (up to c) + 1 (a) + 2 (all) + 4 (a timeout runs all) + 0.
    assert.equal(all.reached, 11 / 5);
    assert.equal(all.ran, 10 / 5);
    assert.equal(all.dryRun, 4);
    assert.equal(all.seconds, undefined);
  });

  it('keeps every killer when the run is cut to the killers, so a killed mutant meets its killer again', () => {
    const cut = cost(mutants, tests, new Set(['a', 'c']));

    // Ran: 2 (a, c) + 1 (a) + 0 (neither b nor d stays) + 2 (a, c) + 0.
    assert.equal(cut.ran, 5 / 5);
    assert.equal(cut.dryRun, 2);
  });

  it('prices a timeout at the budget of StrykerJS: 1.5 × the net time, + 5 s, + one start for each file', () => {
    const one = { id: '9', status: 'Timeout', coveredBy: ['a', 'b'] };
    const seconds = cost([one], tests, undefined, () => 2, 0.5).seconds;

    assert.deepEqual(seconds, { mutants: 0, timeouts: 1.5 * 4 + 5 + 0.5 * 4, dryRun: 4 * 2 + 0.5 * 4 });
  });

  it('prices a killed mutant at the files it ran, each with its start', () => {
    const seconds = cost([killedByC], tests, undefined, () => 2, 0.5).seconds;

    assert.equal(seconds?.mutants, 3 * (2 + 0.5));
  });
});
