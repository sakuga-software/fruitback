import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isElement } from './dom.ts';
import { mountPage } from './dom.fixture.ts';

describe('isElement', () => {
  it('recognises an element without asking which realm it came from', () => {
    // The reason this exists: an element from a same-origin iframe fails `instanceof Element` in the
    // parent realm, and react-grab's hit testing crosses iframes on purpose. A bare object with the
    // right `nodeType` stands in for one here.
    const page = mountPage('<main><button>Commander</button></main>');

    assert.equal(isElement(page.query('button')), true);
    // Stands in for an element from another realm, which is exactly what `instanceof` would refuse.
    assert.equal(isElement({ nodeType: 1, tagName: 'BUTTON' }), true, 'an element from another realm was refused');
  });

  it('refuses everything else, including what would have thrown', () => {
    const page = mountPage('<main><button>Commander</button></main>');

    assert.equal(isElement(page.document), false);
    assert.equal(isElement(page.view), false);
    assert.equal(isElement(null), false);
    assert.equal(isElement(undefined), false);
    assert.equal(isElement('button'), false);
    // Tightened after review: a bare node-shaped object is not enough to claim it is an element.
    assert.equal(isElement({ nodeType: 1 }), false);
  });
});
