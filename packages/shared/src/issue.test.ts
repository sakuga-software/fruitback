import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED_STAGE, FRUITBACK_LABEL, SEED_STAGES, buildIssueLabels } from './issue.ts';
import { minimalSeedFixture, seedFixture } from './seed.fixture.ts';

describe('labels', () => {
  it('tags every issue, and the client when there is one', () => {
    assert.deepEqual(buildIssueLabels(seedFixture()), [FRUITBACK_LABEL, 'fruitback:acme']);
    assert.deepEqual(buildIssueLabels(minimalSeedFixture()), [FRUITBACK_LABEL]);
  });
});

describe('the stage vocabulary', () => {
  // The projection from a provider's own states lives with its connector since SKG-516 — this
  // package is installed by every consumer of the widget, and a `LinearStateType` here made all of
  // them depend on Linear. `apps/worker/src/linear.test.ts` owns that mapping's tests now. What is
  // still the contract's is the vocabulary itself and the fallback every connector uses.
  it('is the five stages the widget draws, in ripening order', () => {
    assert.deepEqual([...SEED_STAGES], ['seeded', 'green', 'ripening', 'ripe', 'composted']);
  });

  it('falls back to a stage that exists, and to that one', () => {
    assert.ok(SEED_STAGES.includes(DEFAULT_SEED_STAGE));
    // The value is pinned here rather than in a connector's tests, because every connector reads
    // this constant: this is the one place a change to it should be heard. Moving it silently
    // repaints every pin whose state a provider renamed.
    assert.equal(DEFAULT_SEED_STAGE, 'seeded');
  });
});
