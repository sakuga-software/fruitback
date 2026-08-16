import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_EXCERPT_MAX_LENGTH } from '@sakuga/fruitback-shared';
import { captureAnchor, captureBounds, readTextExcerpt } from './anchor.ts';
import { mountPage, setDocumentSize, setRect, setScroll } from './dom.fixture.ts';

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

describe('readTextExcerpt', () => {
  it('collapses the whitespace the markup left behind', () => {
    const page = mountPage('<main><button>\n  Commander\n  maintenant\n</button></main>');

    assert.equal(readTextExcerpt(page.query('button')), 'Commander maintenant');
  });

  it('truncates to the length the seed schema accepts', () => {
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
