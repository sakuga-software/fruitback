import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueDescription, canonicalizePageUrl, parseSeedFromDescription } from '@fruitback/shared';
import { captureSeed } from './capture.ts';
import { mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

const CREATED_AT = '2026-08-09T09:15:00.000Z';

function mountPricingPage(url = 'https://preview.acme.test/pricing?tab=annual') {
  const page = mountPage('<main><section><button data-testid="checkout-cta">Commander</button></section></main>', {
    url,
    title: 'Pricing — Acme',
    dpr: 2,
  });
  setDocumentSize(page.document, 1_440, 4_000);
  setRect(page.query('button'), { left: 612, top: 450, width: 172.8, height: 180 });

  return page;
}

describe('captureSeed', () => {
  it('builds the payload the worker stores', () => {
    const page = mountPricingPage();

    const seed = captureSeed({
      element: page.query('button'),
      note: 'Le bouton “Commander” est trop petit sur mobile.',
      client: { id: 'acme', name: 'Acme' },
      id: 'sd_2f8c1a90',
      createdAt: CREATED_AT,
      includeEnv: false,
    });

    assert.deepEqual(seed, {
      kind: 'fruitback.seed',
      v: 1,
      id: 'sd_2f8c1a90',
      createdAt: CREATED_AT,
      note: 'Le bouton “Commander” est trop petit sur mobile.',
      page: { url: 'https://preview.acme.test/pricing?tab=annual', path: '/pricing', title: 'Pricing — Acme' },
      viewport: { width: 1_440, height: 900, dpr: 2 },
      anchor: {
        selector: '[data-testid="checkout-cta"]',
        domPath: 'html > body > main > section > button',
        tag: 'button',
        text: 'Commander',
        attrs: { testId: 'checkout-cta' },
        bounds: { xPct: 42.5, yPct: 11.25, wPct: 12, hPct: 4.5 },
      },
      client: { id: 'acme', name: 'Acme' },
    });
  });

  it('survives the round trip through a Linear description', () => {
    // The invariant the whole product rests on: what the widget captures is what it reads back.
    const page = mountPricingPage();

    const seed = captureSeed({
      element: page.query('button'),
      note: 'Trop petit sur mobile',
      id: 'sd_round',
      createdAt: CREATED_AT,
    });

    assert.deepEqual(parseSeedFromDescription(buildIssueDescription(seed)), { ok: true, seed });
  });

  it('canonicalizes the page URL, so the pin is planted where the read path looks for it', () => {
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';
    const page = mountPricingPage(raw);

    const seed = captureSeed({ element: page.query('button'), note: '', id: 'sd_url', createdAt: CREATED_AT });

    assert.equal(seed.page.url, canonicalizePageUrl(raw));
    assert.equal(seed.page.url, 'https://preview.acme.test/pricing?tab=annual');
  });

  it('omits every optional the caller did not provide', () => {
    // Adding a default here is the easy way to break the round trip without noticing.
    const page = mountPricingPage();

    const seed = captureSeed({
      element: page.query('button'),
      note: 'Rien de plus',
      id: 'sd_bare',
      createdAt: CREATED_AT,
      includeEnv: false,
    });

    assert.deepEqual(Object.keys(seed).sort(), ['anchor', 'createdAt', 'id', 'kind', 'note', 'page', 'v', 'viewport']);
  });

  it('collects the environment when it is allowed to', () => {
    const page = mountPricingPage();

    const seed = captureSeed({
      element: page.query('button'),
      note: '',
      id: 'sd_env',
      createdAt: CREATED_AT,
    });

    assert.ok(seed.env?.userAgent);
    assert.equal(seed.env?.locale, page.view.navigator.language);
  });

  it('prefers the source react-grab resolved over anything read off the DOM', () => {
    const page = mountPricingPage();
    const source = { component: 'CheckoutCta', file: 'src/components/checkout-cta.tsx', line: 42 };

    const seed = captureSeed({
      element: page.query('button'),
      note: '',
      source,
      id: 'sd_source',
      createdAt: CREATED_AT,
    });

    assert.deepEqual(seed.source, source);
  });

  it('generates an id when none is given, and it is not the same one twice', () => {
    const page = mountPricingPage();
    const element = page.query('button');

    const first = captureSeed({ element, note: '' });
    const second = captureSeed({ element, note: '' });

    assert.match(first.id, /^sd_[0-9a-f]{12}$/);
    assert.notEqual(first.id, second.id);
  });

  it('keeps the id the same width on a page with no crypto at all', () => {
    // http staging sites have no secure context, so `crypto` may be missing entirely. The fallback
    // must still produce a full-width id — `Math.random().toString(16)` alone does not.
    const page = mountPricingPage();
    Object.defineProperty(page.view, 'crypto', { value: undefined, configurable: true });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const seed = captureSeed({ element: page.query('button'), note: '', view: page.view });

      assert.match(seed.id, /^sd_[0-9a-f]{12}$/);
    }
  });

  it('refuses an element with no window rather than sending half a seed', () => {
    const page = mountPricingPage();
    const orphan = page.document.implementation.createHTMLDocument().createElement('button');

    assert.throws(() => captureSeed({ element: orphan, note: 'nulle part' }), /no window/);
  });
});
