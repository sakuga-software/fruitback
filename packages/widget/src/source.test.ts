import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBundleChunk, isMangledComponentName, readReactSource, sourceFromContext } from './source.ts';
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

describe('what a bundler minted, in what the engine says (FRU-113)', () => {
  it('refuses the minified name behind a bound prefix, the one a production build reported', () => {
    assert.equal(isMangledComponentName('bound qi'), true);
    assert.equal(isMangledComponentName('bound bound e2'), true);
    assert.equal(isMangledComponentName('bound $7230ffa83bc0c2cf$var$DOMElement'), true);
    assert.equal(isMangledComponentName('bound '), true);
  });

  it('keeps a name a person wrote, bound or not, and a component called Bound', () => {
    assert.equal(isMangledComponentName('Bound'), false);
    assert.equal(isMangledComponentName('BoundButton'), false);
    assert.equal(isMangledComponentName('bound PricingCard'), false);
    assert.equal(sourceFromContext({ componentName: 'bound PricingCard' })?.component, 'PricingCard');
  });

  it('sends nothing for the note a production build produced', () => {
    const reported = {
      componentName: 'bound qi',
      filePath: '/assets/site-state-Bgn4uEnK.js',
      lineNumber: 7,
      columnNumber: 6774,
    };

    assert.equal(sourceFromContext(reported), undefined);
  });

  it('knows a chunk by the hash before its extension, and leaves a source file alone', () => {
    for (const chunk of [
      '/assets/site-state-Bgn4uEnK.js',
      '/_next/static/chunks/main-0f3a9c1d2b.js',
      'https://cdn.acme.dev/app.5e8f21ab.mjs',
      '/assets/index-D4kq9XzP.js?v=2',
      '/assets/main-k3j9x0qz.js',
      '/static/js/vendor.a1b2c3d4e5.js',
    ]) {
      assert.equal(isBundleChunk(chunk), true, chunk);
    }
    for (const file of [
      '/src/site-state.tsx',
      '/Users/a/app/components/user-settings.js',
      '/src/checkout-form.jsx',
      '/src/pricing-calculator.js',
      '/src/Feedback.tsx',
      '/src/lib-sha256sum.js',
      '/src/step-2-checkout1.js',
      '/src/h264video.js',
      '/src/utils.base64v2.js',
    ]) {
      assert.equal(isBundleChunk(file), false, file);
    }
  });

  it('keeps the file when only the name is minted, and the name when only the file is a chunk', () => {
    assert.deepEqual(
      sourceFromContext({ componentName: 'bound qi', filePath: '/src/pricing.tsx', lineNumber: 12, columnNumber: 4 }),
      {
        file: '/src/pricing.tsx',
        line: 12,
        column: 4,
      },
    );
    assert.deepEqual(
      sourceFromContext({
        componentName: 'PricingCard',
        filePath: '/assets/index-D4kq9XzP.js',
        lineNumber: 1,
        columnNumber: 90210,
      }),
      {
        component: 'PricingCard',
      },
    );
  });
});
