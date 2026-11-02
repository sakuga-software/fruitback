import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_INK, paintOfStatus, statusLabel } from './status-paint.ts';
import { readableTextColor } from './contrast.ts';

describe('the paint of a status (FRU-512)', () => {
  it('fills a status with its colour, and writes on it the text colour the team chose', () => {
    assert.deepEqual(paintOfStatus('#7dd3fc', '#000000'), { fill: '#7dd3fc', ink: '#000000' });
  });

  it('computes the text on the fill, the ink first, when the team chose none or one that is no colour', () => {
    // A light fill: the dark ink reads on it.
    assert.deepEqual(paintOfStatus('#7dd3fc', undefined), { fill: '#7dd3fc', ink: STATUS_INK });
    // A dark fill: white.
    assert.deepEqual(paintOfStatus('#1e3a8a', 'var(--x)'), { fill: '#1e3a8a', ink: '#ffffff' });
    assert.equal(paintOfStatus('#a52a3a', undefined)?.ink, readableTextColor('#a52a3a', STATUS_INK));
  });

  it('paints no status whose colour is not #rrggbb: its stage is drawn', () => {
    for (const color of ['', 'red', '#fff', 'var(--x)', 'url(x)', '#7dd3fc; x']) {
      assert.equal(paintOfStatus(color, '#000000'), undefined, String(color));
    }
  });
});

describe('the word of a state (FRU-512)', () => {
  it('says the name of the status, else of the state in the tracker, else of the stage', () => {
    assert.equal(statusLabel('Waiting for the client', 'In Review', 'Done'), 'Waiting for the client');
    assert.equal(statusLabel(undefined, 'In Review', 'Done'), 'In Review');
    assert.equal(statusLabel(undefined, undefined, 'Done'), 'Done');
  });

  it('takes an empty name for no name', () => {
    assert.equal(statusLabel('', '', 'To do'), 'To do');
    assert.equal(statusLabel('', 'Todo', 'To do'), 'Todo');
  });
});
