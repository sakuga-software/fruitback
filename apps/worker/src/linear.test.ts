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

  it('shows an unknown state as seeded rather than hiding the pin', () => {
    assert.equal(stageForLinearState('someCustomType'), 'seeded');
  });

  it('takes that fallback from the contract, not from a literal of its own', () => {
    // Every connector answers the same way for a state it does not recognise, so the rule is the
    // contract's. A connector spelling `'seeded'` itself is how the next one comes to disagree.
    assert.equal(stageForLinearState(''), DEFAULT_SEED_STAGE);
  });
});
