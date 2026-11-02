import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteAnchor } from '@fruitback/shared';
import { type AnchorResolution, overlap, resolveAnchor } from './resolve.ts';
import { captureAnchor } from './anchor.ts';
import { type MountedPage, attachShadowHtml, mountPage, queryIn, setDocumentSize, setRect } from './dom.fixture.ts';

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

function anchorFor(overrides: Partial<NoteAnchor> = {}): NoteAnchor {
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

  it('finds a form control by its placeholder, the way the capture read it', () => {
    // The capture stores a form control's value, placeholder or label as its text — an `<input>` has
    // no text of its own. Resolution has to read it the same way, or the one identity-bearing
    // fallback an input has is silently unavailable and every input anchor degrades to a guess.
    const page = mountPage(
      '<form><input class="css-1x9f7ab" placeholder="Rechercher"><input placeholder="Votre e-mail"></form>',
      { width: 1_000, height: 1_000 },
    );
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('[placeholder="Rechercher"]'), { left: 0, top: 0, width: 200, height: 30 });

    const resolved = resolveAnchor(
      // The CSS-modules class was rehashed by the deploy, so the selector is gone.
      { selector: '.css-77aa31', tag: 'input', text: 'Rechercher', bounds: { xPct: 0, yPct: 0, wPct: 20, hPct: 3 } },
      { document: page.document },
    );

    assert.equal(resolved.strategy, 'text');
    assert.equal(resolved.confident, true);
    assert.equal(resolved.element, page.query('[placeholder="Rechercher"]'));
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
    // The trap, from the FRU-5 browser test and the FRU-19 suite: insert a card and
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
    // box the pin was planted on. Same tag, same text, same position — nothing a note stores can
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

  it('survives a tag that is not a selector at all', () => {
    // `tag` is a plain string in the contract and the description it came from is human-editable, so
    // it reaches the engine as untrusted input. It must come back as "no match", not as a crash that
    // takes every other pin on the page down with it.
    const page = mountCards();

    const resolved = resolveAnchor(
      { selector: '#gone', tag: 'butt on[', text: 'Ajouter', bounds: { xPct: 30, yPct: 10, wPct: 20, hPct: 4 } },
      { document: page.document },
    );

    assert.equal(resolved.strategy, 'orphan');
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

/**
 * The resolution as plain data. An assertion that prints a happy-dom element on failure walks its
 * whole tree and hangs the run for minutes, so the element is compared by identity and named.
 */
function outcome(resolved: AnchorResolution, expected: Element | null) {
  return {
    element: resolved.element === expected ? 'the expected one' : (resolved.element?.outerHTML ?? null),
    strategy: resolved.strategy,
    confident: resolved.confident,
  };
}

describe('resolveAnchor, in a web component (FRU-580)', () => {
  /** A button of the page and a button of the component, with one class, side by side. */
  function mountPromo(mode: ShadowRootMode = 'open') {
    const page = mountPage('<main><button class="buy">Acheter</button><acme-promo id="promo"></acme-promo></main>', {
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    const shadow = attachShadowHtml(page.query('#promo'), '<div><button class="buy">Acheter</button></div>', mode);
    const inside = queryIn(shadow, 'button');
    setRect(page.query('main > button'), { left: 0, top: 0, width: 100, height: 40 });
    setRect(inside, { left: 500, top: 500, width: 100, height: 40 });

    return { page, inside };
  }

  /** What a widget of FRU-580 stores for the button of the component. */
  const PROMO_ANCHOR: NoteAnchor = {
    hosts: ['#promo'],
    selector: 'button.buy',
    domPath: 'div > button',
    tag: 'button',
    text: 'Acheter',
    bounds: { xPct: 50, yPct: 50, wPct: 10, hPct: 4 },
  };

  it('follows the host into its open shadow root, and is sure', () => {
    const { page, inside } = mountPromo();

    const resolved = resolveAnchor(PROMO_ANCHOR, { document: page.document });

    assert.deepEqual(outcome(resolved, inside), {
      element: 'the expected one',
      strategy: 'selector',
      confident: true,
    });
  });

  it('follows two nested open shadow roots, from an anchor the capture wrote', () => {
    const page = mountPage('<main><acme-shop id="shop"></acme-shop></main>');
    const shop = attachShadowHtml(
      page.query('#shop'),
      '<acme-price data-testid="price-espresso"></acme-price><acme-price data-testid="price-latte"></acme-price>',
    );
    for (const host of shop.querySelectorAll('acme-price')) attachShadowHtml(host, '<button class="buy">19 €</button>');
    const latte = queryIn(queryIn(shop, '[data-testid="price-latte"]').shadowRoot as ShadowRoot, 'button');

    const resolved = resolveAnchor(captureAnchor(latte), { document: page.document });

    assert.deepEqual(outcome(resolved, latte), {
      element: 'the expected one',
      strategy: 'selector',
      confident: true,
    });
  });

  it('finds the element by its text in the shadow root when its selector broke', () => {
    const { page, inside } = mountPromo();

    const resolved = resolveAnchor({ ...PROMO_ANCHOR, selector: 'button.renamed' }, { document: page.document });

    assert.deepEqual(outcome(resolved, inside), {
      element: 'the expected one',
      strategy: 'text',
      confident: true,
    });
  });

  it('falls back to the position when the host is gone, and never to a stranger that has the selector', () => {
    // The component left. The page's own `button.buy`, of the same text, now sits where it was.
    const { page } = mountPromo();
    page.query('#promo').remove();
    const stranger = page.query('main > button');
    setRect(stranger, { left: 500, top: 500, width: 100, height: 40 });

    const resolved = resolveAnchor(PROMO_ANCHOR, { document: page.document });

    assert.deepEqual(outcome(resolved, stranger), {
      element: 'the expected one',
      strategy: 'bounds',
      confident: false,
    });
  });

  it('is an orphan when the host is gone and nothing holds its place', () => {
    const { page } = mountPromo();
    page.query('#promo').remove();

    const resolved = resolveAnchor(PROMO_ANCHOR, { document: page.document });

    assert.deepEqual(outcome(resolved, null), { element: 'the expected one', strategy: 'orphan', confident: false });
  });

  it('falls back to the coordinates when the shadow root is closed', () => {
    // The host is there, but `shadowRoot` is `null`: the path cannot be followed.
    const { page } = mountPromo('closed');

    const resolved = resolveAnchor(PROMO_ANCHOR, { document: page.document });

    assert.deepEqual(outcome(resolved, null), { element: 'the expected one', strategy: 'orphan', confident: false });
  });

  it('refuses a host that two elements match', () => {
    const { page } = mountPromo();
    page.query('main').insertAdjacentHTML('beforeend', '<acme-promo class="promo"></acme-promo>');
    attachShadowHtml(page.query('acme-promo.promo'), '<button class="buy">Acheter</button>');

    const resolved = resolveAnchor({ ...PROMO_ANCHOR, hosts: ['acme-promo'] }, { document: page.document });

    assert.equal(resolved.confident, false);
  });

  it('reads an anchor with no hosts in the document, as before', () => {
    // A note written before FRU-580 on the page's own button. The component's twin is not looked at.
    const { page } = mountPromo();
    const { hosts: _none, ...before } = PROMO_ANCHOR;

    const resolved = resolveAnchor(
      { ...before, domPath: 'html > body > main > button', bounds: { xPct: 0, yPct: 0, wPct: 10, hPct: 4 } },
      { document: page.document },
    );

    assert.deepEqual(outcome(resolved, page.query('main > button')), {
      element: 'the expected one',
      strategy: 'selector',
      confident: true,
    });
  });
});
