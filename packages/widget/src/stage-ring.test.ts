import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_STAGES } from '@fruitback/shared';
import { mountPage } from './dom.fixture.ts';
import { createStageRing } from './stage-ring.ts';

describe('the round of a stage, which fills as a note moves on (FRU-606)', () => {
  const page = mountPage('<main></main>');
  const shapes = NOTE_STAGES.map((stage) => {
    const ring = createStageRing(page.document, stage);

    return {
      stage: ring.dataset.stage,
      dashed: ring.querySelector('circle')?.hasAttribute('stroke-dasharray') ?? false,
      full: ring.querySelector('circle')?.getAttribute('fill') === 'currentColor',
      half: ring.querySelector('path[fill="currentColor"]') !== null,
      mark: ring.querySelector('path[fill="none"]') !== null,
    };
  });

  it('is a dashed ring for New, an empty ring for To do, half full for In progress, full for Done and Closed', () => {
    assert.deepEqual(shapes, [
      { stage: 'new', dashed: true, full: false, half: false, mark: false },
      { stage: 'todo', dashed: false, full: false, half: false, mark: false },
      { stage: 'progress', dashed: false, full: false, half: true, mark: false },
      { stage: 'done', dashed: false, full: true, half: false, mark: true },
      { stage: 'closed', dashed: false, full: true, half: false, mark: true },
    ]);
  });

  it('draws a tick on Done and a cross on Closed, so the two full rounds differ by their shape', () => {
    const mark = (stage: 'done' | 'closed') =>
      createStageRing(page.document, stage).querySelector('path[fill="none"]')?.getAttribute('d');

    assert.notEqual(mark('done'), mark('closed'));
  });

  it('is hidden from a screen reader and takes no focus: the word of the stage is beside it', () => {
    const ring = createStageRing(page.document, 'todo');

    assert.equal(ring.getAttribute('aria-hidden'), 'true');
    assert.equal(ring.getAttribute('focusable'), 'false');
    assert.equal(ring.getAttribute('class'), 'fruitback-stage-ring');
  });
});
