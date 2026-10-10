import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOfferedDestinations, destinationToSend, offeredDestinations } from './destinations.ts';

describe('the places a read offers (FRU-123)', () => {
  const WEB = { id: 'dst_web', label: 'Linear · Web' };
  const DESIGN = { id: 'dst_design', label: 'Linear · Design' };

  it('keeps the places in the order of the worker, because the first one is the default', () => {
    assert.deepEqual(offeredDestinations([DESIGN, WEB]), [DESIGN, WEB]);
  });

  it('offers no choice when the field is absent, which is every reader but a member', () => {
    assert.deepEqual(offeredDestinations(undefined), []);
    assert.deepEqual(offeredDestinations(null), []);
    assert.deepEqual(offeredDestinations('dst_web'), []);
    assert.deepEqual(offeredDestinations({ 0: WEB, 1: DESIGN, length: 2 }), []);
  });

  it('offers no choice with fewer than two places', () => {
    assert.deepEqual(offeredDestinations([]), []);
    assert.deepEqual(offeredDestinations([WEB]), []);
  });

  it('drops the whole list for one bad entry, so the default on screen is the default of the worker', () => {
    // With the bad entry alone removed, the list below would show Design as the default while the
    // worker sends a note that names no place to its own first one.
    assert.deepEqual(offeredDestinations([{ label: 'No id' }, DESIGN, WEB]), []);
    assert.deepEqual(offeredDestinations([WEB, null, DESIGN]), []);
    assert.deepEqual(offeredDestinations([WEB, 'dst_design']), []);
    assert.deepEqual(offeredDestinations([WEB, { id: '' }]), []);
    assert.deepEqual(offeredDestinations([WEB, { id: 7 }]), []);
    assert.deepEqual(offeredDestinations([WEB, { id: 'x'.repeat(201) }]), []);
    assert.deepEqual(offeredDestinations([WEB, { ...DESIGN, id: WEB.id }]), [], 'one id names two places');
  });

  it('keeps a place with no usable label, because a label is only a name', () => {
    assert.deepEqual(offeredDestinations([WEB, { id: 'dst_old' }]), [WEB, { id: 'dst_old' }]);
    assert.deepEqual(offeredDestinations([WEB, { id: 'dst_old', label: 42 }]), [WEB, { id: 'dst_old' }]);
    assert.deepEqual(offeredDestinations([WEB, { id: 'dst_old', label: '   ' }]), [WEB, { id: 'dst_old' }]);
    assert.deepEqual(offeredDestinations([WEB, { id: 'dst_old', label: '  Support ' }]), [
      WEB,
      { id: 'dst_old', label: 'Support' },
    ]);
    assert.equal(offeredDestinations([WEB, { id: 'dst_old', label: 'a'.repeat(5_000) }])[1]?.label?.length, 200);
  });

  it('keeps nothing of an entry but its id and its label', () => {
    assert.deepEqual(offeredDestinations([{ ...WEB, teamId: 'team_1' }, DESIGN]), [WEB, DESIGN]);
  });

  it('sends the id of a choice, and nothing for the first place or for a place that is not offered', () => {
    assert.equal(destinationToSend([WEB, DESIGN], DESIGN.id), DESIGN.id);
    // The request of a member who chose nothing is the request of everybody else.
    assert.equal(destinationToSend([WEB, DESIGN], WEB.id), undefined);
    assert.equal(destinationToSend([WEB, DESIGN], undefined), undefined);
    assert.equal(destinationToSend([WEB, DESIGN], 'dst_gone'), undefined);
    assert.equal(destinationToSend([], DESIGN.id), undefined);
    assert.equal(destinationToSend([], undefined), undefined);
  });

  it('tells its listeners of a list that changed, and not of the same list read again', () => {
    const offered = createOfferedDestinations();
    let told = 0;
    const stop = offered.subscribe(() => told++);
    assert.deepEqual(offered.get(), []);

    offered.set([WEB, DESIGN]);
    assert.equal(told, 1);
    assert.deepEqual(offered.get(), [WEB, DESIGN]);

    // Every return to the tab reads again. A redraw then would move the focus of who is choosing.
    offered.set([{ ...WEB }, { ...DESIGN }]);
    assert.equal(told, 1);

    offered.set([DESIGN, WEB]);
    assert.equal(told, 2, 'the order is the default, so a new order is a change');

    stop();
    offered.set([]);
    assert.equal(told, 2);
  });
});
