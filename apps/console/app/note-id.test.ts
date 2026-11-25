import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { siteOfId } from './note-id.ts';

const idOf = (site: string, note: string) => Buffer.from(JSON.stringify([site, note])).toString('base64url');

describe('the site of a note from its id in the console (FRU-658)', () => {
  it('reads the site of an id the worker made, base64url included', () => {
    assert.equal(siteOfId(idOf('site_f96505d0', 'task_46ff')), 'site_f96505d0');
    // A note id that makes `-` and `_` in base64url.
    assert.equal(siteOfId(idOf('s1', 'sd_~~~???>>>')), 's1');
  });

  it('answers nothing for an id that is not one', () => {
    for (const id of ['', 'not base64', idOf('s1', 'n').slice(3), Buffer.from('{"a":1}').toString('base64url')]) {
      assert.equal(siteOfId(id), '', id);
    }
    assert.equal(siteOfId(Buffer.from(JSON.stringify([1, 'n'])).toString('base64url')), '');
  });
});
