import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_EXCERPT_MAX_LENGTH } from '@fruitback/shared';
import { captureAnchor, captureBounds, readTextExcerpt } from './anchor.ts';
import { attachShadowHtml, mountPage, queryIn, setDocumentSize, setRect, setScroll } from './dom.fixture.ts';

describe('captureAnchor', () => {
  it('captures every independent way of finding the element again', () => {
    const page = mountPage(`
      <main>
        <section>
          <button id="cta" data-testid="checkout-cta" name="checkout" role="button" aria-label="Commander">
            Commander
          </button>
        </section>
      </main>
    `);
    const button = page.query('button');
    setDocumentSize(page.document, 1_440, 4_000);
    setRect(button, { left: 612, top: 450, width: 172.8, height: 180 });

    assert.deepEqual(captureAnchor(button), {
      selector: '[data-testid="checkout-cta"]',
      domPath: 'html > body > main > section > button',
      tag: 'button',
      text: 'Commander',
      attrs: { id: 'cta', testId: 'checkout-cta', name: 'checkout', role: 'button', ariaLabel: 'Commander' },
      bounds: { xPct: 42.5, yPct: 11.25, wPct: 12, hPct: 4.5 },
    });
  });

  it('writes no field it did not observe', () => {
    // The round-trip forbids inventing values: an absent excerpt must stay absent, not become `''`.
    const page = mountPage('<main><hr></main>');
    const rule = page.query('hr');

    const anchor = captureAnchor(rule);

    assert.deepEqual(Object.keys(anchor).sort(), ['bounds', 'domPath', 'selector', 'tag']);
  });
});

describe('captureAnchor, in a web component (FRU-580)', () => {
  it('names the host, then reads the selector and the path in its open shadow root', () => {
    // A button of the same class in the page itself: the selector is unique in the shadow root.
    const page = mountPage('<main><button class="buy">Acheter</button><acme-promo id="promo"></acme-promo></main>');
    const shadow = attachShadowHtml(page.query('#promo'), '<div><button class="buy">Acheter</button></div>');

    const anchor = captureAnchor(queryIn(shadow, 'button'));

    assert.deepEqual(anchor.hosts, ['#promo']);
    assert.equal(anchor.selector, 'button.buy');
    assert.equal(anchor.domPath, 'div > button');
    assert.equal(anchor.tag, 'button');
    assert.equal(anchor.text, 'Acheter');
  });

  it('names each host of two nested open shadow roots, outermost first', () => {
    const page = mountPage('<main><acme-shop id="shop"></acme-shop></main>');
    const shop = attachShadowHtml(
      page.query('#shop'),
      '<acme-price data-testid="price-espresso"></acme-price><acme-price data-testid="price-latte"></acme-price>',
    );
    const price = attachShadowHtml(
      queryIn(shop, '[data-testid="price-latte"]'),
      '<button aria-label="Acheter">19 €</button>',
    );

    const anchor = captureAnchor(queryIn(price, 'button'));

    assert.deepEqual(anchor.hosts, ['#shop', '[data-testid="price-latte"]']);
    assert.equal(anchor.selector, 'button[aria-label="Acheter"]');
    assert.equal(anchor.domPath, 'button');
  });

  it('tells two instances of one component apart by the selector of their host', () => {
    // Nothing names either host: the second one is told by its place, as a card is.
    const page = mountPage('<main><acme-promo></acme-promo><acme-promo></acme-promo></main>');
    const [first, second] = [...page.document.querySelectorAll('acme-promo')];
    attachShadowHtml(first as Element, '<button class="buy">Acheter</button>');
    const shadow = attachShadowHtml(second as Element, '<button class="buy">Acheter</button>');

    const anchor = captureAnchor(queryIn(shadow, 'button'));

    assert.deepEqual(anchor.hosts, ['html > body > main > acme-promo:nth-child(2)']);
    assert.equal(page.document.querySelectorAll(anchor.hosts?.[0] ?? '').length, 1);
  });

  it('measures the bounds in the document, wherever the element is', () => {
    const page = mountPage('<acme-promo id="promo"></acme-promo>', { width: 1_000, height: 1_000 });
    const button = queryIn(attachShadowHtml(page.query('#promo'), '<button>Acheter</button>'), 'button');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(button, { left: 100, top: 200, width: 50, height: 20 });

    assert.deepEqual(captureAnchor(button).bounds, { xPct: 10, yPct: 20, wPct: 5, hPct: 2 });
  });
});

describe('readTextExcerpt', () => {
  it('collapses the whitespace the markup left behind', () => {
    const page = mountPage('<main><button>\n  Commander\n  maintenant\n</button></main>');

    assert.equal(readTextExcerpt(page.query('button')), 'Commander maintenant');
  });

  it('truncates to the length the note schema accepts', () => {
    const page = mountPage(`<main><p>${'ab '.repeat(200)}</p></main>`);

    const text = readTextExcerpt(page.query('p'));

    assert.equal(text?.length, TEXT_EXCERPT_MAX_LENGTH);
  });

  it('falls back to a form control’s own content', () => {
    const page = mountPage(`
      <form>
        <input name="email" placeholder="vous@exemple.fr">
        <input name="city" value="Nantes">
      </form>
    `);

    assert.equal(readTextExcerpt(page.query('[name="email"]')), 'vous@exemple.fr');
    assert.equal(readTextExcerpt(page.query('[name="city"]')), 'Nantes');
  });

  it('is undefined when the element says nothing', () => {
    const page = mountPage('<main><div>   </div></main>');

    assert.equal(readTextExcerpt(page.query('div')), undefined);
  });
});

describe('captureBounds', () => {
  it('measures against the document, not the viewport', () => {
    // Same element, same box on screen, twice the page: the pin sits at half the percentage.
    const page = mountPage('<main><button>Commander</button></main>');
    const button = page.query('button');
    setRect(button, { left: 0, top: 500, width: 144, height: 40 });

    setDocumentSize(page.document, 1_440, 2_000);
    assert.equal(captureBounds(button).yPct, 25);

    setDocumentSize(page.document, 1_440, 4_000);
    assert.equal(captureBounds(button).yPct, 12.5);
  });

  it('adds the scroll offset, so a pin below the fold lands where the element is', () => {
    const page = mountPage('<main><button>Commander</button></main>', { width: 1_000, height: 800 });
    const button = page.query('button');
    setDocumentSize(page.document, 1_000, 5_000);
    setScroll(page.view, 0, 2_000);
    // On screen near the top, but 2 000 px down the document.
    setRect(button, { left: 100, top: 500, width: 100, height: 50 });

    assert.deepEqual(captureBounds(button), { xPct: 10, yPct: 50, wPct: 10, hPct: 1 });
  });

  it('degrades to zeroes rather than NaN on a document with no size', () => {
    // A pin at `NaN%` fails the schema and loses the reporter's note; a pin at 0 is merely wrong.
    const page = mountPage('<main><button>Commander</button></main>');
    const button = page.query('button');
    setDocumentSize(page.document, 0, 0);
    Object.defineProperty(page.view, 'innerWidth', { value: 0, configurable: true });
    Object.defineProperty(page.view, 'innerHeight', { value: 0, configurable: true });
    setRect(button, { left: 10, top: 10, width: 10, height: 10 });

    assert.deepEqual(captureBounds(button), { xPct: 0, yPct: 0, wPct: 0, hPct: 0 });
  });
});
