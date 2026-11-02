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

  it('reaches the third level, where each root lists every host above it', () => {
    // Three nested roots, listed as Chromium does: each inner root names every outer host again.
    // Each root is entered once, and a host already explored is not entered a second time.
    const page = mountPage('<main><acme-shop id="shop"></acme-shop></main>');
    const shop = page.query('#shop');
    const shopRoot = attachShadowHtml(shop, '<acme-promo></acme-promo>');
    const promo = queryIn(shopRoot, 'acme-promo');
    const promoRoot = attachShadowHtml(promo, '<acme-price></acme-price>');
    const price = queryIn(promoRoot, 'acme-price');
    const priceRoot = attachShadowHtml(price, '<button>Acheter</button>');
    const button = queryIn(priceRoot, 'button');
    const calls = new Map<unknown, number>();
    const at = (root: Document | ShadowRoot, elements: Element[]) =>
      Object.defineProperty(root, 'elementsFromPoint', {
        value: () => {
          calls.set(root, (calls.get(root) ?? 0) + 1);
          return elements;
        },
        configurable: true,
      });
    at(page.document, [shop, page.query('main')]);
    at(shopRoot, [promo, shop]);
    at(promoRoot, [price, promo, shop]);
    at(priceRoot, [button, price, promo, shop]);

    assert.ok(deepElementAt(page.document, 10, 10, () => true) === button);
    assert.deepEqual([...calls.values()], [1, 1, 1, 1]);

    // Nothing inside is accepted: the walk ends, each root read once, and the outermost host answers.
    calls.clear();
    assert.ok(deepElementAt(page.document, 10, 10, (element) => element === shop) === shop);
    assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
  });

  it('says when the point is over a shadow host, and not over a plain element', () => {
    const { page } = mountNested();
    assert.equal(overShadowHost(page.document, 10, 10), true);

    Object.defineProperty(page.document, 'elementFromPoint', { value: () => page.query('main'), configurable: true });
    assert.equal(overShadowHost(page.document, 10, 10), false);
  });
});
