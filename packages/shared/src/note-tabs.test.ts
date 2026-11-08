import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_STAGES } from './issue.ts';
import { NOTE_TABS, firstTab, noteTab, shortCount } from './note-tabs.ts';

describe('the tabs of the list of the notes (FRU-606)', () => {
  it('are To check, Open and Done, in the order of the loop', () => {
    assert.deepEqual(NOTE_TABS, ['check', 'open', 'done']);
  });

  it('puts a done note of the reader that nobody checked in « To check », and in no other tab', () => {
    assert.equal(noteTab({ stage: 'done', mine: true }), 'check');
    assert.equal(noteTab({ stage: 'done', mine: true, checked: { by: 'Camille', at: '2026-11-06' } }), 'done');
    assert.equal(noteTab({ stage: 'done' }), 'done');
  });

  it('puts new, to do and in progress in « Open », done and closed in « Done », whoever wrote them', () => {
    const tabs = NOTE_STAGES.map((stage) => [stage, noteTab({ stage }), noteTab({ stage, mine: true })]);

    assert.deepEqual(tabs, [
      ['new', 'open', 'open'],
      ['todo', 'open', 'open'],
      ['progress', 'open', 'open'],
      ['done', 'done', 'check'],
      ['closed', 'done', 'done'],
    ]);
  });

  it('opens on « To check » while a note waits for a verdict, else on « Open »', () => {
    assert.equal(firstTab([{ stage: 'new' }, { stage: 'done', mine: true }]), 'check');
    assert.equal(firstTab([{ stage: 'new' }, { stage: 'done' }]), 'open');
    assert.equal(firstTab([]), 'open');
  });
});

describe('a count in a list (FRU-611)', () => {
  it('says « 99+ » above 99, and the number up to it', () => {
    assert.deepEqual([0, 1, 99, 100, 1234].map(shortCount), ['0', '1', '99', '99+', '99+']);
  });
});
