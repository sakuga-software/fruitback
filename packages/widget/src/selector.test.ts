import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDomPath, buildSelector, cssString, isStableClass, isStableId } from './selector.ts';
import { mountPage } from './dom.fixture.ts';

describe('buildSelector', () => {
  it('prefers a test id over everything else', () => {
    const page = mountPage(`
      <main>
        <button id="cta" class="btn primary" data-testid="checkout-cta" aria-label="Commander">Commander</button>
      </main>
    `);

    assert.equal(buildSelector(page.query('button')), '[data-testid="checkout-cta"]');
  });

  it('takes an author-written id when there is no test id', () => {
    const page = mountPage('<main><button id="checkout-cta" class="btn">Commander</button></main>');

    assert.equal(buildSelector(page.query('button')), '#checkout-cta');
  });

  it('refuses a framework-generated id and moves on to the next candidate', () => {
    // `useId` output is unique and changes on every render — the worst possible anchor.
    const page = mountPage('<main><button id=":r7:" name="checkout">Commander</button></main>');

    assert.equal(buildSelector(page.query('button')), 'button[name="checkout"]');
  });

  it('falls back to the aria-label when nothing else names the element', () => {
    const page = mountPage('<main><button aria-label="Fermer la modale">×</button></main>');

    assert.equal(buildSelector(page.query('button')), 'button[aria-label="Fermer la modale"]');
  });

  it('uses classes a human wrote, and ignores the ones a bundler emitted', () => {
    const page = mountPage('<main><button class="css-1x9f7ab checkout-cta button_3f2a1b">Commander</button></main>');

    assert.equal(buildSelector(page.query('button')), 'button.checkout-cta');
  });

  it('scopes under the nearest identifiable ancestor when the element repeats', () => {
    // Three identical cards: `button.add` matches all of them, so the card's test id anchors it.
    const page = mountPage(`
      <ul>
        <li data-testid="card-espresso"><button class="add">Ajouter</button></li>
        <li data-testid="card-latte"><button class="add">Ajouter</button></li>
        <li data-testid="card-mocha"><button class="add">Ajouter</button></li>
      </ul>
    `);

    const selector = buildSelector(page.query('[data-testid="card-latte"] button'));

    assert.equal(selector, '[data-testid="card-latte"] > button');
    assert.equal(page.document.querySelectorAll(selector).length, 1);
  });

  it('falls back to the structural path when nothing in the page has a name', () => {
    const page = mountPage('<div><div><span>Un</span><span>Deux</span></div></div>');

    const selector = buildSelector(page.query('span:nth-child(2)'));

    assert.equal(selector, 'html > body > div > div > span:nth-child(2)');
    assert.equal(page.document.querySelectorAll(selector).length, 1);
  });

  it('quotes an attribute value that would otherwise break the selector', () => {
    const page = mountPage('<main><button aria-label=\'Dire "bonjour"\'>Salut</button></main>');

    const selector = buildSelector(page.query('button'));

    assert.equal(selector, `button[aria-label='Dire "bonjour"']`);
    assert.equal(page.document.querySelectorAll(selector).length, 1);
  });

  it('always returns a selector that matches the element and only it', () => {
    const page = mountPage(`
      <section data-testid="pricing">
        <div class="row"><span>Gratuit</span><span>0€</span></div>
        <div class="row"><span>Pro</span><span>29€</span></div>
      </section>
    `);

    for (const element of [...page.document.querySelectorAll('*')]) {
      const selector = buildSelector(element);
      const found = page.document.querySelectorAll(selector);

      assert.equal(found.length, 1, `${selector} matched ${found.length} elements`);
      assert.equal(found[0], element, `${selector} matched the wrong element`);
    }
  });
});

describe('buildDomPath', () => {
  it('spells :nth-child only where it disambiguates', () => {
    const page = mountPage(`
      <div></div>
      <main><section>a</section><section><button>Commander</button></section></main>
    `);

    assert.equal(buildDomPath(page.query('button')), 'html > body > main > section:nth-child(2) > button');
  });

  it('starts at the document element, so the path is absolute', () => {
    const page = mountPage('<main><h1>Pricing</h1></main>');

    assert.equal(buildDomPath(page.query('h1')), 'html > body > main > h1');
  });
});

describe('stability heuristics', () => {
  it('accepts ids a human would type', () => {
    assert.ok(isStableId('checkout-cta'));
    assert.ok(isStableId('main_nav'));
  });

  it('rejects ids a framework minted', () => {
    for (const id of [':r7:', 'radix-42', 'headlessui-menu-1', 'a3f9c2e81b4d', 'item-20260809']) {
      assert.equal(isStableId(id), false, `${id} should not be trusted`);
    }
  });

  it('escapes an attribute value only when no quote style avoids it', () => {
    assert.equal(cssString('Commander'), '"Commander"');
    assert.equal(cssString('Dire "bonjour"'), `'Dire "bonjour"'`);
    assert.equal(cssString(`l'été "chaud"`), `"l'été \\"chaud\\""`);
  });

  it('rejects classes a bundler minted', () => {
    for (const className of ['css-1x9f7ab', 'sc-bdVaJa', 'button_3f2a1b', 'Header_nav__a1b2c3']) {
      assert.equal(isStableClass(className), false, `${className} should not be trusted`);
    }
    assert.ok(isStableClass('checkout-cta'));
  });
});
