import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepElementAt, overShadowHost } from './shadow-hit.ts';
import { attachShadowHtml, mountPage, queryIn } from './dom.fixture.ts';

/**
 * happy-dom does no layout, so each root says what is under the point, in the order Chromium gives:
 * the inner root lists the outer host too, retargeted. That is the cycle react-grab 0.2.0 loops on.
 */
function mountNested() {
  const page = mountPage('<main><acme-promo id="promo"></acme-promo></main>');
  const promo = page.query('#promo');
  const outer = attachShadowHtml(promo, '<acme-price></acme-price>');
  const price = queryIn(outer, 'acme-price');
  const inner = attachShadowHtml(price, '<button>Acheter</button>');
  const button = queryIn(inner, 'button');
  const main = page.query('main');
  const at = (root: Document | ShadowRoot, elements: Element[]) =>
    Object.defineProperty(root, 'elementsFromPoint', { value: () => elements, configurable: true });
  at(page.document, [promo, main, page.document.body]);
  at(outer, [price, promo, main]);
  at(inner, [button, price, promo, main]);
  Object.defineProperty(page.document, 'elementFromPoint', { value: () => promo, configurable: true });

  return { page, promo, price, button };
}

describe('hit testing through nested shadow roots (FRU-580)', () => {
  it('reaches the element of the inner shadow root, and enters each root once', () => {
    const { page, button } = mountNested();

    assert.ok(deepElementAt(page.document, 10, 10, () => true) === button);
  });

  it('gives the host when the caller refuses what is inside', () => {
    const { page, price } = mountNested();

    const found = deepElementAt(page.document, 10, 10, (element) => element.localName !== 'button');

    assert.ok(found === price, found?.localName ?? 'null');
  });

  it('answers null when nothing is accepted', () => {
    const { page } = mountNested();

    assert.equal(
      deepElementAt(page.document, 10, 10, () => false),
      null,
    );
  });

  it('says when the point is over a shadow host, and not over a plain element', () => {
    const { page } = mountNested();
    assert.equal(overShadowHost(page.document, 10, 10), true);

    Object.defineProperty(page.document, 'elementFromPoint', { value: () => page.query('main'), configurable: true });
    assert.equal(overShadowHost(page.document, 10, 10), false);
  });
});
