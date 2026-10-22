import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_INK, notePaint, stateWord } from './note-status.ts';

/** The status of a note in the side panel (FRU-370), as the widget draws it. */

describe('notePaint', () => {
  it('draws the stage with no status, or a status with no colour', () => {
    assert.equal(notePaint({}), undefined);
    assert.equal(notePaint({ status: { stage: 'progress', name: 'Waiting' } }), undefined);
  });

  it('fills with the colour of the status, and writes the text colour chosen, or one computed', () => {
    assert.deepEqual(notePaint({ status: { stage: 'progress', name: 'x', color: '#7c3aed', textColor: '#000000' } }), {
      fill: '#7c3aed',
      ink: '#000000',
    });
    // White on this violet (5.70:1), the ink on a pale yellow (16.50:1).
    assert.equal(notePaint({ status: { stage: 'progress', name: 'x', color: '#7c3aed' } })?.ink, '#ffffff');
    assert.equal(notePaint({ status: { stage: 'progress', name: 'x', color: '#fef9c3' } })?.ink, '#18181b');
  });

  it('measures on the ink of the kit', () => {
    const css = readFileSync(fileURLToPath(new URL('../entrypoints/popup/style.css', import.meta.url)), 'utf8');

    assert.match(css, new RegExp(`--ink: ${STATUS_INK};`));
  });
});

describe('stateWord', () => {
  it('says the name of the status, then the word of the store, then the word of the stage', () => {
    assert.equal(
      stateWord({ status: { stage: 'progress', name: 'Waiting' }, stateName: 'In Review' }, 'In progress'),
      'Waiting',
    );
    assert.equal(
      stateWord({ status: { stage: 'progress', name: '' }, stateName: 'In Review' }, 'In progress'),
      'In Review',
    );
    assert.equal(stateWord({}, 'In progress'), 'In progress');
  });
});
