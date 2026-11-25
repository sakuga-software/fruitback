import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, viewAddress, viewOf, viewsFor } from './saved-views.ts';

const assigned = VIEWS.find((view) => view.id === 'assigned');

describe('the views of the bar (FRU-697)', () => {
  it('open the Notes screen with their filters in the address', () => {
    assert.ok(assigned);
    assert.equal(viewAddress('w1', assigned), '/w/w1/notes?assignee=me');
  });

  it('name only filters that the Notes screen keeps in its address', async () => {
    const { FILTERS } = await import('./parts/notes-model.ts');
    const unknown = VIEWS.flatMap((view) =>
      Object.keys(view.filters).filter((name) => !(FILTERS as readonly string[]).includes(name)),
    );
    assert.deepEqual(unknown, []);
  });

  it('are found from the address when its filters are exactly theirs', () => {
    assert.equal(viewOf(new URLSearchParams('assignee=me'))?.id, 'assigned');
    // The page, the board and a task opened are not filters: the list is the same.
    assert.equal(viewOf(new URLSearchParams('assignee=me&view=board&cursor=abc&from=26&task=n1'))?.id, 'assigned');
    assert.equal(viewOf({ assignee: 'me', site: '' })?.id, 'assigned');
  });

  it('are not found when a filter is more, less or another', () => {
    assert.equal(viewOf(new URLSearchParams('')), undefined);
    assert.equal(viewOf(new URLSearchParams('assignee=me&site=s1')), undefined);
    assert.equal(viewOf(new URLSearchParams('assignee=me&q=menu')), undefined);
    assert.equal(viewOf(new URLSearchParams('assignee=none')), undefined);
    assert.equal(viewOf({ assignee: 'a2' }), undefined);
  });

  it('give no view of the tasks to a guest, who is never given one (FRU-673)', () => {
    assert.deepEqual(
      viewsFor('guest').map((view) => view.id),
      [],
    );
    for (const role of ['owner', 'admin', 'member']) {
      assert.deepEqual(
        viewsFor(role).map((view) => view.id),
        ['assigned'],
      );
    }
  });
});
