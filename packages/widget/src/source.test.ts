import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readReactSource } from './source.ts';
import { mountPage } from './dom.fixture.ts';

/**
 * The fibers here are hand-built rather than rendered: what is under test is how defensively this
 * reads React's internals, and a real React would only ever show one version's shape at a time.
 */
function attachFiber(element: Element, fiber: unknown): void {
  // Enumerable, the way React assigns it on the host node.
  Object.defineProperty(element, '__reactFiber$abc123', { value: fiber, configurable: true, enumerable: true });
}

function mountButton(): Element {
  return mountPage('<main><button>Commander</button></main>').query('button');
}

describe('readReactSource', () => {
  it('is undefined on a page React never touched', () => {
    assert.equal(readReactSource(mountButton()), undefined);
  });

  it('reads the component and the JSX location a dev build left behind', () => {
    const button = mountButton();
    function CheckoutCta() {}
    attachFiber(button, {
      type: 'button',
      _debugOwner: {
        type: CheckoutCta,
        _debugSource: { fileName: 'src/components/checkout-cta.tsx', lineNumber: 42, columnNumber: 7 },
      },
    });

    assert.deepEqual(readReactSource(button), {
      component: 'CheckoutCta',
      file: 'src/components/checkout-cta.tsx',
      line: 42,
      column: 7,
    });
  });

  it('unwraps memo and forwardRef rather than reporting an anonymous component', () => {
    const button = mountButton();
    function PriceRow() {}
    attachFiber(button, { type: 'button', _debugOwner: { type: { render: PriceRow } } });

    assert.partialDeepStrictEqual(readReactSource(button), { component: 'PriceRow' });
  });

  it('honours displayName over the function name', () => {
    const button = mountButton();
    const Card = Object.assign(function Anonymous() {}, { displayName: 'PricingCard' });
    attachFiber(button, { type: Card });

    assert.partialDeepStrictEqual(readReactSource(button), { component: 'PricingCard' });
  });

  it('reports the component alone when the build stripped the source location', () => {
    // React 19 dropped `_debugSource`; a component name is still worth having.
    const button = mountButton();
    function CheckoutCta() {}
    attachFiber(button, { type: 'button', _debugOwner: { type: CheckoutCta } });

    assert.deepEqual(readReactSource(button), { component: 'CheckoutCta' });
  });

  it('walks past a design system internal the bundler renamed', () => {
    // The shape a real HeroUI button has: react-aria renders the host node, Parcel scope-hoisted its
    // component into `$hash$var$DOMElement`, and the name worth putting in a Linear issue is two
    // owners further up. Found on the playground once it became a React app.
    const button = mountButton();
    const internal = Object.assign(function DOMElement() {}, { displayName: '$7230ffa83bc0c2cf$var$DOMElement' });
    function AddToCartButton() {}
    attachFiber(button, {
      type: 'button',
      _debugOwner: { type: internal, _debugOwner: { type: AddToCartButton } },
    });

    assert.deepEqual(readReactSource(button), { component: 'AddToCartButton' });
  });

  it('walks past a minified name rather than reporting a single letter', () => {
    const button = mountButton();
    const minified = Object.assign(function t() {}, { displayName: '' });
    function PlanCard() {}
    attachFiber(button, { type: 'button', _debugOwner: { type: minified, _debugOwner: { type: PlanCard } } });

    assert.deepEqual(readReactSource(button), { component: 'PlanCard' });
  });

  it('gives up rather than guessing when the internals are not what it expected', () => {
    const button = mountButton();
    attachFiber(button, { type: 'button', _debugSource: { fileName: 42 }, _debugOwner: { type: 'div' } });

    assert.equal(readReactSource(button), undefined);
  });

  it('stops at the root, which React marks with a null owner rather than by omission', () => {
    // The shape a real React tree ends in. A walk that only stops on `undefined` dereferences this
    // and throws out of `captureSeed` — which is how a click stopped planting anything at all.
    const button = mountButton();
    attachFiber(button, { type: 'button', _debugOwner: { type: 'div', _debugOwner: null } });

    assert.equal(readReactSource(button), undefined);
  });

  it('does not walk for ever up a self-referential owner chain', () => {
    const button = mountButton();
    const loop: Record<string, unknown> = { type: 'button' };
    loop._debugOwner = loop;
    attachFiber(button, loop);

    assert.equal(readReactSource(button), undefined);
  });
});
