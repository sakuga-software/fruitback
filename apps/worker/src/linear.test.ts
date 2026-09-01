import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED_STAGE } from '@fruitback/shared';
import { stageForLinearState } from './linear.ts';

/**
 * These tests moved here from `packages/shared` with the code they cover (SKG-516). The contract
 * package names the stages; this connector is what knows how Linear's own workflow reaches them.
 */

describe('stageForLinearState', () => {
  it('ripens the pin along the Linear workflow', () => {
    assert.equal(stageForLinearState('backlog'), 'seeded');
    assert.equal(stageForLinearState('triage'), 'seeded');
    assert.equal(stageForLinearState('unstarted'), 'green');
    assert.equal(stageForLinearState('started'), 'ripening');
    assert.equal(stageForLinearState('completed'), 'ripe');
    assert.equal(stageForLinearState('canceled'), 'composted');
    // The SKG team has a "Duplicate" state; a duplicated pin must not read as freshly seeded.
    assert.equal(stageForLinearState('duplicate'), 'composted');
  });

  it('draws an unrecognised state instead of hiding it, at the contract’s default', () => {
    // Both inputs happen: Linear can answer with a state type this connector has never seen, and
    // `toSeedIssue` passes '' for an issue that came back with no state at all.
    assert.equal(stageForLinearState('someCustomType'), DEFAULT_SEED_STAGE);
    assert.equal(stageForLinearState(''), DEFAULT_SEED_STAGE);

    // Asserted against the constant, not against `'seeded'`: every connector answers the same way
    // for a state it does not know, so the rule is the contract's and a connector spelling the
    // literal itself is how the next one comes to disagree. Which stage that is stays pinned in
    // `packages/shared/src/linear.test.ts`, where the constant is declared.
  });
});
