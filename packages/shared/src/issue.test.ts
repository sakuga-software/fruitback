import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED_STAGE,
  FRUITBACK_LABEL,
  SEED_STAGES,
  buildIssueLabels,
  offeredStages,
  seedCommentSchema,
  seedIssueSchema,
} from './issue.ts';
import { minimalSeedFixture, seedFixture } from './seed.fixture.ts';

describe('labels', () => {
  it('tags every issue, and the client when there is one', () => {
    assert.deepEqual(buildIssueLabels(seedFixture()), [FRUITBACK_LABEL, 'fruitback:acme']);
    assert.deepEqual(buildIssueLabels(minimalSeedFixture()), [FRUITBACK_LABEL]);
  });
});

describe('the stage vocabulary', () => {
  // The projection from a provider's own states lives with its connector since FRU-23 — this
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

describe('offeredStages (FRU-32)', () => {
  it('keeps the stages a worker reports, in the order of the contract', () => {
    assert.deepEqual(offeredStages(['composted', 'seeded', 'ripe']), ['seeded', 'ripe', 'composted']);
  });

  it('drops a value that is not a stage, and a repeated one', () => {
    assert.deepEqual(offeredStages(['seeded', 'seeded', 'blue', 3]), ['seeded']);
  });

  it('offers every stage if the worker sends nothing usable', () => {
    // A worker from before FRU-32 sends no field. Its panel must not lose a box.
    for (const value of [undefined, null, 'seeded', [], ['blue']]) {
      assert.deepEqual(offeredStages(value), [...SEED_STAGES], JSON.stringify(value));
    }
  });
});

describe('the read envelope (FRU-10, FRU-13)', () => {
  /** A planted seed as a worker answers it, with one reply from the team. */
  function realisticIssue(overrides: Record<string, unknown> = {}) {
    return {
      id: '6f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5',
      identifier: 'FRU-2',
      url: 'https://linear.app/sakuga-software/issue/FRU-2/le-bouton-est-trop-petit',
      title: 'Le bouton est trop petit',
      stage: 'ripening',
      stateName: 'In Progress',
      updatedAt: '2026-08-05T10:00:00.000Z',
      comments: [
        { id: 'c_1', body: 'Corrigé sur la preview.', createdAt: '2026-08-05T11:00:00.000Z', author: 'Mathieu' },
      ],
      seed: seedFixture(),
      ...overrides,
    };
  }

  it('reads a realistic answer of a worker', () => {
    const issue = realisticIssue();

    assert.deepEqual(seedIssueSchema.parse(issue), issue);
  });

  it('reads checked and mine, and refuses a checked with no name or no instant, and a mine that is not true (FRU-294)', () => {
    const issue = realisticIssue({
      stage: 'ripe',
      checked: { by: 'Bob', at: '2026-10-20T10:00:00.000Z' },
      mine: true,
    });

    assert.deepEqual(seedIssueSchema.parse(issue), issue);
    for (const checked of [{ by: 'Bob' }, { at: '2026-10-20T10:00:00.000Z' }, {}, 'Bob']) {
      assert.equal(seedIssueSchema.safeParse({ ...issue, checked }).success, false, JSON.stringify(checked));
    }
    for (const mine of [false, 'true', 1]) {
      assert.equal(seedIssueSchema.safeParse({ ...issue, mine }).success, false, String(mine));
    }
  });

  it('reads an answer with no URL, as a store with no web interface gives it', () => {
    const { url: _none, ...issue } = realisticIssue();

    assert.deepEqual(seedIssueSchema.parse(issue), issue);
  });

  it('refuses an empty id, identifier or URL', () => {
    for (const field of ['id', 'identifier', 'url']) {
      assert.equal(seedIssueSchema.safeParse(realisticIssue({ [field]: '' })).success, false, field);
    }
  });

  it('reads a realistic comment, and refuses one with an empty id', () => {
    const comment = { id: 'c_42', body: 'On regarde ça demain.', createdAt: '2026-08-05T11:00:00.000Z' };

    assert.deepEqual(seedCommentSchema.parse(comment), comment);
    assert.equal(seedCommentSchema.safeParse({ ...comment, id: '' }).success, false);
  });
});
