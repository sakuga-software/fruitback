import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NOTE_STAGES } from '@fruitback/shared';
import { STAGES, STAGE_NAMES, isStage } from './stages.ts';

const APP = new URL('./', import.meta.url);

describe('the five stages of a note (FRU-508)', () => {
  it('are the stages of the contract, in its order', () => {
    assert.equal(STAGES, NOTE_STAGES);
    assert.deepEqual(Object.keys(STAGE_NAMES), [...NOTE_STAGES]);
  });

  it('each have a name of the widget', () => {
    assert.deepEqual(STAGE_NAMES, {
      new: 'New',
      todo: 'To do',
      progress: 'In progress',
      done: 'Done',
      closed: 'Closed',
    });
  });

  it('know a word of the worker, and refuse any other', () => {
    for (const stage of NOTE_STAGES) assert.equal(isStage(stage), true, stage);
    for (const word of ['', 'Done', 'own:waiting', 'constructor', 'toString']) assert.equal(isStage(word), false, word);
  });

  it('are listed in no other file of the console', () => {
    // `api.ts` and `ui.tsx` each wrote the five once more.
    const list = /\[\s*'new',\s*'todo',\s*'progress',\s*'done',\s*'closed'\s*\]/;
    const sources = [
      ...readdirSync(APP).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.')),
      ...readdirSync(new URL('routes/', APP)).map((name) => `routes/${name}`),
    ];
    const found = sources.filter((name) => list.test(readFileSync(new URL(name, APP), 'utf8')));

    assert.deepEqual(found, []);
    assert.ok(sources.length > 40, `only ${sources.length} files were read`);
    // The control: the list of before is found.
    assert.equal(list.test("export const STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;"), true);
  });
});
