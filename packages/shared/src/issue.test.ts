import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOTE_STAGE,
  FRUITBACK_LABEL,
  NOTE_STAGES,
  buildIssueLabels,
  MAX_STATUSES,
  offeredStages,
  offeredStatuses,
  noteCommentSchema,
  noteIssueSchema,
  statusOf,
} from './issue.ts';
import { minimalNoteFixture, noteFixture } from './note.fixture.ts';

describe('labels', () => {
  it('tags every issue, and the client when there is one', () => {
    assert.deepEqual(buildIssueLabels(noteFixture()), [FRUITBACK_LABEL, 'fruitback:acme']);
    assert.deepEqual(buildIssueLabels(minimalNoteFixture()), [FRUITBACK_LABEL]);
  });
});

describe('the stage vocabulary', () => {
  // The projection from a provider's own states lives with its connector since FRU-23 — this
  // package is installed by every consumer of the widget, and a `LinearStateType` here made all of
  // them depend on Linear. `apps/worker/src/linear.test.ts` owns that mapping's tests now. What is
  // still the contract's is the vocabulary itself and the fallback every connector uses.
  it('is the five stages the widget draws, in their order', () => {
    assert.deepEqual([...NOTE_STAGES], ['new', 'todo', 'progress', 'done', 'closed']);
  });

  it('falls back to a stage that exists, and to that one', () => {
    assert.ok(NOTE_STAGES.includes(DEFAULT_NOTE_STAGE));
    // The value is pinned here rather than in a connector's tests, because every connector reads
    // this constant: this is the one place a change to it should be heard. Moving it silently
    // repaints every pin whose state a provider renamed.
    assert.equal(DEFAULT_NOTE_STAGE, 'new');
  });
});

describe('offeredStages (FRU-32)', () => {
  it('keeps the stages a worker reports, in the order of the contract', () => {
    assert.deepEqual(offeredStages(['closed', 'new', 'done']), ['new', 'done', 'closed']);
  });

  it('drops a value that is not a stage, and a repeated one', () => {
    assert.deepEqual(offeredStages(['new', 'new', 'blue', 3]), ['new']);
  });

  it('offers every stage if the worker sends nothing usable', () => {
    // A worker from before FRU-32 sends no field. Its panel must not lose a box.
    for (const value of [undefined, null, 'new', [], ['blue']]) {
      assert.deepEqual(offeredStages(value), [...NOTE_STAGES], JSON.stringify(value));
    }
  });
});

describe('the read envelope (FRU-10, FRU-13)', () => {
  /** A planted note as a worker answers it, with one reply from the team. */
  function realisticIssue(overrides: Record<string, unknown> = {}) {
    return {
      id: '6f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5',
      identifier: 'FRU-2',
      url: 'https://linear.app/sakuga-software/issue/FRU-2/le-bouton-est-trop-petit',
      title: 'Le bouton est trop petit',
      stage: 'progress',
      stateName: 'In Progress',
      updatedAt: '2026-08-05T10:00:00.000Z',
      comments: [
        { id: 'c_1', body: 'Corrigé sur la preview.', createdAt: '2026-08-05T11:00:00.000Z', author: 'Mathieu' },
      ],
      note: noteFixture(),
      ...overrides,
    };
  }

  it('reads a realistic answer of a worker', () => {
    const issue = realisticIssue();

    assert.deepEqual(noteIssueSchema.parse(issue), issue);
  });

  it('reads checked and mine, and refuses a checked with no name or no instant, and a mine that is not true (FRU-294)', () => {
    const issue = realisticIssue({
      stage: 'done',
      checked: { by: 'Bob', at: '2026-10-20T10:00:00.000Z' },
      mine: true,
    });

    assert.deepEqual(noteIssueSchema.parse(issue), issue);
    for (const checked of [{ by: 'Bob' }, { at: '2026-10-20T10:00:00.000Z' }, {}, 'Bob']) {
      assert.equal(noteIssueSchema.safeParse({ ...issue, checked }).success, false, JSON.stringify(checked));
    }
    for (const mine of [false, 'true', 1]) {
      assert.equal(noteIssueSchema.safeParse({ ...issue, mine }).success, false, String(mine));
    }
  });

  it('reads an answer with no URL, as a store with no web interface gives it', () => {
    const { url: _none, ...issue } = realisticIssue();

    assert.deepEqual(noteIssueSchema.parse(issue), issue);
  });

  it('refuses an empty id, identifier or URL', () => {
    for (const field of ['id', 'identifier', 'url']) {
      assert.equal(noteIssueSchema.safeParse(realisticIssue({ [field]: '' })).success, false, field);
    }
  });

  it('reads a realistic comment, and refuses one with an empty id', () => {
    const comment = { id: 'c_42', body: 'On regarde ça demain.', createdAt: '2026-08-05T11:00:00.000Z' };

    assert.deepEqual(noteCommentSchema.parse(comment), comment);
    assert.equal(noteCommentSchema.safeParse({ ...comment, id: '' }).success, false);
  });
});

describe('the statuses of a read (FRU-364)', () => {
  const doing = { key: 'linear:st_1', name: 'In Review', stage: 'progress', color: '#7dd3fc', textColor: '#18181b' };

  it('reads an issue with no status, as every worker before FRU-364 sends it', () => {
    const issue = { ...noteIssueFixtureLike(), stage: 'done', stateName: 'Done' };
    const parsed = noteIssueSchema.parse(issue);

    assert.deepEqual(parsed, issue);
    assert.equal('status' in parsed, false, 'no default fills the field in');
  });

  it('reads an issue that names its status, and refuses an empty key', () => {
    const issue = { ...noteIssueFixtureLike(), status: 'linear:st_1' };

    assert.deepEqual(noteIssueSchema.parse(issue), issue);
    assert.equal(noteIssueSchema.safeParse({ ...issue, status: '' }).success, false);
  });

  it('gives no status for a read with no list, or with something else than a list', () => {
    for (const value of [undefined, null, 'linear:st_1', {}, 3]) {
      assert.deepEqual(offeredStatuses(value), [], JSON.stringify(value));
    }
  });

  it('keeps a status as the worker sent it', () => {
    assert.deepEqual(offeredStatuses([doing]), [doing]);
    assert.deepEqual(offeredStatuses([{ key: 'own:new', name: '', stage: 'new' }]), [
      { key: 'own:new', name: '', stage: 'new' },
    ]);
  });

  it('drops an entry with no key, a stage outside the five, or a key already seen', () => {
    const kept = offeredStatuses([
      null,
      'linear:st_1',
      { name: 'No key', stage: 'new' },
      { key: '', name: 'Empty key', stage: 'new' },
      { key: 'x', name: 'Blue', stage: 'blue' },
      doing,
      { ...doing, name: 'Second with the same key' },
    ]);

    assert.deepEqual(kept, [doing]);
  });

  it('drops a colour that is not #rrggbb, and keeps the rest of its entry', () => {
    for (const color of [
      'red',
      '#fff',
      'var(--fruitback-stage-done)',
      'url(https://x.test/a.png)',
      '#7dd3fcff',
      '#7dd3fc;',
      'red#7dd3fc',
      ['#7dd3fc'],
      7,
    ]) {
      assert.deepEqual(
        offeredStatuses([{ ...doing, color }]),
        [{ key: doing.key, name: doing.name, stage: doing.stage }],
        String(color),
      );
    }
    assert.deepEqual(offeredStatuses([{ ...doing, textColor: 'black' }]), [
      { key: doing.key, name: doing.name, stage: doing.stage, color: doing.color },
    ]);
  });

  it('drops a text colour that has no background colour to be read on', () => {
    const { color: _none, ...noBackground } = doing;

    assert.deepEqual(offeredStatuses([noBackground]), [{ key: doing.key, name: doing.name, stage: doing.stage }]);
  });

  it(`keeps the first ${MAX_STATUSES} statuses of a read`, () => {
    const many = Array.from({ length: MAX_STATUSES + 5 }, (_, index) => ({
      key: `k${index}`,
      name: '',
      stage: 'new',
    }));
    const kept = offeredStatuses(many);

    assert.equal(kept.length, MAX_STATUSES);
    assert.equal(kept.at(-1)?.key, `k${MAX_STATUSES - 1}`);
  });

  it('counts only the statuses it keeps against that bound', () => {
    // Found in review: a bound taken on the raw list let dropped entries push a valid one out.
    const dropped = Array.from({ length: MAX_STATUSES }, () => ({ key: '', name: '', stage: 'new' }));
    const kept = offeredStatuses([...dropped, { key: 'after', name: '', stage: 'done' }]);

    assert.deepEqual(kept, [{ key: 'after', name: '', stage: 'done' }]);
  });

  it('gives the status of an issue only when it is in the list and of the same stage', () => {
    const statuses = offeredStatuses([doing]);

    assert.deepEqual(statusOf({ stage: 'progress', status: doing.key }, statuses), doing);
    assert.equal(statusOf({ stage: 'progress' }, statuses), undefined, 'no status: the stage');
    assert.equal(statusOf({ stage: 'progress', status: 'linear:gone' }, statuses), undefined, 'unknown key: the stage');
    // The stage is what an old widget draws. A new one must not draw another stage from the same answer.
    assert.equal(statusOf({ stage: 'done', status: doing.key }, statuses), undefined, 'other stage: the stage');
  });
});

/** A valid issue with no field of FRU-364. */
function noteIssueFixtureLike() {
  return {
    id: '6f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5',
    identifier: 'FRU-2',
    title: 'Le bouton est trop petit',
    stage: 'progress',
    stateName: 'In Review',
    updatedAt: '2026-10-21T10:00:00.000Z',
    note: noteFixture(),
  };
}
