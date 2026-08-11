import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedAnchor } from '@fruitback/shared';
import { overlap, resolveAnchor } from './resolve.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * happy-dom does no layout, so every box here is stated outright. That is the right level for this
 * file: what is under test is which claim of the anchor gets believed, not what a browser computes.
 */

const CARDS = `
  <ul>
    <li class="card" data-testid="card-espresso"><button class="add">Ajouter</button></li>
    <li class="card" data-testid="card-latte"><button class="add">Ajouter</button></li>
    <li class="card" data-testid="card-mocha"><button class="add">Ajouter</button></li>
  </ul>
`;

/** Three buttons side by side, each 20% wide, on a 1000×1000 document. */
function mountCards(): MountedPage {
  const page = mountPage(CARDS, { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);

  [...page.document.querySelectorAll('.add')].forEach((button, index) => {
    setRect(button, { left: index * 300, top: 100, width: 200, height: 40 });
  });

  return page;
}

function anchorFor(overrides: Partial<SeedAnchor> = {}): SeedAnchor {
  return {
    selector: '[data-testid="card-latte"] > button',
    domPath: 'html > body > ul > li:nth-child(2) > button',
    tag: 'button',
    text: 'Ajouter',
    attrs: { testId: 'card-latte' },
    // Where the middle button sits: 300–500 of 1000 across, 100–140 down.
    bounds: { xPct: 30, yPct: 10, wPct: 20, hPct: 4 },
    ...overrides,
  };
}

describe('resolveAnchor', () => {
  it('believes the selector when it still points at one element', () => {
    const page = mountCards();

    const resolved = resolveAnchor(anchorFor(), { document: page.document });

    assert.equal(resolved.strategy, 'selector');
    assert.equal(resolved.confident, true);
    assert.equal(resolved.element, page.query('[data-testid="card-latte"] .add'));
  });

  it('refuses a selector that now matches a different kind of element', () => {
    // The name survived a rewrite but is on a `<div>` now: a coincidence, not a match.
    const page = mountPage('<main><div id="cta">Commander</div></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('#cta'), { left: 0, top: 0, width: 100, height: 20 });

    const resolved = resolveAnchor(
      { selector: '#cta', tag: 'button', bounds: { xPct: 0, yPct: 0, wPct: 10, hPct: 2 } },
      { document: page.document },
    );

    assert.equal(resolved.strategy, 'orphan');
  });

  it('falls back to the test id when the selector around it broke', () => {
    // The button stopped being a direct child, so `… > button` misses — the id it hung off did not.
    const page = mountPage(
      '<ul><li data-testid="card-latte"><div class="body"><button data-testid="add-latte">Ajouter</button></div></li></ul>',
      { width: 1_000, height: 1_000 },
    );
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 300, top: 100, width: 200, height: 40 });

    const resolved = resolveAnchor(anchorFor({ attrs: { testId: 'add-latte' } }), { document: page.document });

    assert.equal(resolved.strategy, 'testId');
    assert.equal(resolved.element, page.query('[data-testid="add-latte"]'));
  });

  it('uses the text when it is the only element saying it', () => {
    const page = mountPage('<main><button>Commander</button><button>Annuler</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 0, top: 0, width: 100, height: 20 });

    const resolved = resolveAnchor(
      { selector: '#gone', tag: 'button', text: 'Commander', bounds: { xPct: 0, yPct: 0, wPct: 10, hPct: 2 } },
      { document: page.document },
    );

    assert.equal(resolved.strategy, 'text');
    assert.equal(resolved.element?.textContent, 'Commander');
  });

  it('does not treat a word three elements share as an identity', () => {
    const page = mountCards();

    const resolved = resolveAnchor(
      // No selector, no test id, no path: text is all that is left, and it is ambiguous.
      { selector: '#gone', tag: 'button', text: 'Ajouter', bounds: { xPct: 30, yPct: 10, wPct: 20, hPct: 4 } },
      { document: page.document },
    );

    // It lands on bounds instead — position can still tell the three apart, but it is a position
    // and the answer says so.
    assert.equal(resolved.strategy, 'bounds');
    assert.equal(resolved.confident, false);
    assert.equal(resolved.element, page.document.querySelectorAll('.add')[1]);
  });

  it('accepts the structural path when the element is still where it was', () => {
    const page = mountCards();

    const resolved = resolveAnchor(anchorFor({ selector: '#gone', attrs: undefined, text: undefined }), {
      document: page.document,
    });

    assert.equal(resolved.strategy, 'domPath');
    assert.equal(resolved.element, page.document.querySelectorAll('.add')[1]);
  });

  it('refuses the structural path when what it found has moved across the page', () => {
    // The trap, from the SKG-494 browser test and the SKG-511 suite: insert a card and
    // `li:nth-child(2)` matches exactly one element — the neighbour, with the same tag and the same
    // text, so neither of those can tell them apart. Where it *is* can.
    const page = mountCards();
    const inserted = page.document.createElement('li');
    inserted.className = 'card';
    page.document.querySelector('ul')?.prepend(inserted);
    // The redesign stacked the cards instead of laying them out in a row.
    [...page.document.querySelectorAll('.add')].forEach((button, index) => {
      setRect(button, { left: 0, top: 200 + index * 200, width: 200, height: 40 });
    });

    const resolved = resolveAnchor(anchorFor({ selector: '#gone', attrs: undefined, text: undefined }), {
      document: page.document,
    });

    assert.equal(resolved.strategy, 'orphan');
    assert.equal(resolved.element, null);
  });

  it('lands on the neighbour that took the slot — but never claims to be sure of it', () => {
    // The blind spot, written down rather than papered over. Insert a card in a grid and every card
    // shifts one slot: the element at the stale path is the neighbour, and it now occupies the very
    // box the pin was planted on. Same tag, same text, same position — nothing a seed stores can
    // separate them.
    //
    // So the answer is given with its provenance instead of being withheld: `confident: false`, and
    // the overlay draws it as a guess. That is the difference between a pin someone checks and a
    // pin someone believes.
    const page = mountCards();
    const inserted = page.document.createElement('li');
    inserted.className = 'card';
    page.document.querySelector('ul')?.prepend(inserted);
    [...page.document.querySelectorAll('.add')].forEach((button, index) => {
      setRect(button, { left: 300 + index * 300, top: 100, width: 200, height: 40 });
    });

    const resolved = resolveAnchor(anchorFor({ selector: '#gone', attrs: undefined, text: undefined }), {
      document: page.document,
    });

    assert.equal(resolved.strategy, 'domPath');
    assert.equal(resolved.confident, false);
    // The Espresso button, sitting where Latte used to be.
    assert.equal(resolved.element, page.document.querySelectorAll('.add')[0]);
  });

  it('gives up rather than guessing when nothing is where it was', () => {
    const page = mountCards();
    [...page.document.querySelectorAll('.add')].forEach((button) => {
      setRect(button, { left: 0, top: 800, width: 60, height: 20 });
    });

    const resolved = resolveAnchor(
      {
        selector: '#gone',
        domPath: 'html > body > ul > li:nth-child(9) > button',
        tag: 'button',
        bounds: { xPct: 30, yPct: 10, wPct: 20, hPct: 4 },
      },
      { document: page.document },
    );

    assert.equal(resolved.strategy, 'orphan');
    assert.equal(resolved.element, null);
  });

  it('survives a selector the engine will not parse', () => {
    const page = mountCards();

    const resolved = resolveAnchor(anchorFor({ selector: 'button[' }), { document: page.document });

    // Refused, not thrown, and the cascade carries on. It skips `testId` too: the id in this anchor
    // is the card's, and it is on the `<li>`, not on the `<button>` the anchor describes.
    assert.equal(resolved.strategy, 'domPath');
    assert.equal(resolved.element, page.document.querySelectorAll('.add')[1]);
  });
});

describe('overlap', () => {
  it('is 1 for the same box and 0 for disjoint ones', () => {
    const box = { xPct: 10, yPct: 10, wPct: 20, hPct: 10 };

    assert.equal(overlap(box, box), 1);
    assert.equal(overlap(box, { xPct: 50, yPct: 50, wPct: 20, hPct: 10 }), 0);
  });

  it('punishes a box that merely contains the other', () => {
    // A card shares its centre with the button inside it; "the pin is on the card" is the mistake
    // this measure exists to make expensive.
    const button = { xPct: 10, yPct: 10, wPct: 10, hPct: 4 };
    const card = { xPct: 5, yPct: 5, wPct: 30, hPct: 20 };

    assert.ok(overlap(button, card) < 0.1);
  });
});
