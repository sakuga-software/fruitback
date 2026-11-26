import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTES_KEPT,
  NOTES_PER_READ,
  NOTES_PER_READ_AGAIN,
  againLimit,
  appended,
  hasMore,
  wanted,
} from './notes-chunks.ts';
import type { IndexedNote, NotesAnswer } from './parts/notes-model.ts';

const note = (id: string, stage: IndexedNote['stage'] = 'new'): IndexedNote => ({
  id,
  excerpt: `Note ${id}`,
  page: { url: 'https://acme.dev/', host: 'acme.dev', path: '/' },
  site: { id: 's1' },
  stage,
  author: { kind: 'anonymous' },
  createdAt: '2026-11-26T09:00:00.000Z',
});

const list = (ids: string[], next?: string): NotesAnswer => ({
  notes: ids.map((id) => note(id)),
  total: 263,
  counts: { all: 263 },
  ...(next === undefined ? {} : { next }),
});

const ids = (answer: NotesAnswer) => answer.notes.map((each) => each.id);

describe('the notes read as the list scrolls (FRU-724)', () => {
  it('adds the next notes at the end, with the cursor of the chunk, and keeps the counts of the list', () => {
    const more = appended(list(['a', 'b'], 'c1'), { notes: [note('c'), note('d')], next: 'c2' });

    assert.deepEqual(ids(more), ['a', 'b', 'c', 'd']);
    assert.equal(more.next, 'c2');
    assert.equal(more.total, 263);
    assert.deepEqual(more.counts, { all: 263 });
  });

  it('has no cursor once the last chunk is added', () => {
    const last = appended(list(['a'], 'c1'), { notes: [note('b')] });

    assert.equal('next' in last, false);
    assert.equal(hasMore(last), false);
  });

  it('shows a note read twice once, where the later read put it', () => {
    // Its status changed between the two reads: the worker reads it again in its new group.
    const more = appended(list(['a', 'b', 'c'], 'c1'), { notes: [note('d'), note('b', 'done')] });

    assert.deepEqual(ids(more), ['a', 'c', 'd', 'b']);
    assert.equal(more.notes.at(-1)?.stage, 'done');
  });

  it('keeps the statuses of the sites of both reads', () => {
    const status = (key: string) => ({ key, name: key, stage: 'new' as const });
    const first = { ...list(['a'], 'c1'), statuses: { s1: [status('own:new')] } };
    const more = appended(first, { notes: [note('b')], statuses: { s2: [status('own:todo')] } });

    assert.deepEqual(Object.keys(more.statuses ?? {}), ['s1', 's2']);
    assert.equal('statuses' in appended(list(['a'], 'c1'), { notes: [] }), false);
  });

  it('reads no next notes past the notes it keeps: the bound', () => {
    const many = Array.from({ length: NOTES_KEPT - 1 }, (_, n) => `n${n}`);

    assert.equal(hasMore(list(many, 'c1')), true);
    assert.equal(hasMore(list([...many, 'last'], 'c1')), false);
    assert.equal(hasMore(list(['a'])), false);
  });

  it('reads again what the list showed, in reads of at most 50', () => {
    assert.equal(wanted(0), NOTES_PER_READ);
    assert.equal(wanted(10), NOTES_PER_READ);
    assert.equal(wanted(75), 75);
    assert.equal(wanted(NOTES_KEPT + 30), NOTES_KEPT);
    // 75 shown: a read of 50, then one of 25.
    assert.equal(againLimit(0, 75), NOTES_PER_READ_AGAIN);
    assert.equal(againLimit(50, 75), NOTES_PER_READ);
    // Never less than a chunk: the worker refuses fewer than 8, and a chunk is the step of the list.
    assert.equal(againLimit(70, 75), NOTES_PER_READ);
    assert.equal(againLimit(0, 25), NOTES_PER_READ);
  });
});
