import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_INK, paintOfStatus, stageFirstLabel, statusLabel, trackerOf } from './status-paint.ts';
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

describe('the state of a note in a list, the stage first (FRU-606)', () => {
  it('says the stage, then the tracker and its word', () => {
    assert.equal(stageFirstLabel('In progress', 'In Review', 'Linear'), 'In progress · Linear: In Review');
    assert.equal(stageFirstLabel('En cours', 'Waiting for the client', undefined), 'En cours · Waiting for the client');
  });

  it('says the stage alone with no name, a blank one, or one that says the stage again', () => {
    assert.equal(stageFirstLabel('Done', undefined, 'Linear'), 'Done');
    assert.equal(stageFirstLabel('Done', '  ', 'Linear'), 'Done');
    assert.equal(stageFirstLabel('Done', 'done', 'GitHub'), 'Done');
  });

  it('names Linear and GitHub by the address of the issue, and no other', () => {
    assert.equal(trackerOf('https://linear.app/acme/issue/ACME-12/title'), 'Linear');
    assert.equal(trackerOf('https://github.com/acme/web/issues/4'), 'GitHub');
    assert.equal(trackerOf('https://linear.app.evil.test/x'), undefined);
    assert.equal(trackerOf('https://console.fruitback.com/notes/1'), undefined);
    assert.equal(trackerOf('not an address'), undefined);
    assert.equal(trackerOf(undefined), undefined);
  });
});
