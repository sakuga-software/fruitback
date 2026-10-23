import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePageUrl } from '@fruitback/shared';
import { init } from './embed.ts';
import { plainHead } from './host.ts';
import { createTypingStore } from './typing.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The selector in the head of the composer, on request (FRU-411). The extension asks for
 * `selectorInHead: 'with-selectors'`: the head writes the selector only while « Show CSS selectors »
 * is on, and what a person reads for the element otherwise. A site's own widget keeps it always.
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function mounted(): MountedPage {
  const page = mountPage('<main><button class="add" data-testid="cta">Commander</button></main>', {
    width: 1_000,
    height: 1_000,
  });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
  // The choice of the element reads its component with react-grab, which reads the global `window`.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: page.view, configurable: true, writable: true });
  cleanup.push(() =>
    had === undefined ? Reflect.deleteProperty(globalThis, 'window') : Object.defineProperty(globalThis, 'window', had),
  );

  return page;
}

/** The head of the composer opened again on a note left on the button (FRU-311). */
async function headOn(options: Partial<Parameters<typeof init>[0]>, then?: (widget: ReturnType<typeof init>) => void) {
  const page = mounted();
  createTypingStore({ storage: page.view.sessionStorage, key: 'fruitback:config:typing' }).write(
    {
      page: canonicalizePageUrl(page.view.location.href),
      anchor: {
        selector: '[data-testid="cta"]',
        tag: 'button',
        text: 'Commander',
        bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
      },
    },
    'Le prix est coupé.',
  );
  const widget = init({
    document: page.document,
    endpoint: 'https://worker.test',
    clientId: 'acme',
    transport: async () => ({ ok: true, status: 200, body: JSON.stringify({ issues: [] }) }),
    ...options,
  });
  cleanup.push(() => widget.destroy());
  then?.(widget);
  await widget.refresh();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

  return root.querySelector('[data-fruitback-about]')?.textContent ?? '';
}

describe('the selector in the head of the composer (FRU-411)', () => {
  it('is written always by default, as on a site that embeds the widget', async () => {
    assert.equal(await headOn({}), 'button.add');
  });

  it('is left out with « with-selectors » while the selectors are hidden, for the name of the element', async () => {
    assert.equal(await headOn({ selectorInHead: 'with-selectors' }), 'Commander');
  });

  it('comes back with the selectors, from the option or from showSelectors', async () => {
    assert.equal(await headOn({ selectorInHead: 'with-selectors', showSelectors: true }), 'button.add');
    assert.equal(
      await headOn({ selectorInHead: 'with-selectors' }, (widget) => widget.showSelectors(true)),
      'button.add',
    );
  });

  it('writes the component, and the tag when the element says nothing', () => {
    const page = mountPage('<main><i></i><b>Total</b></main>');
    assert.equal(plainHead(page.query('i'), undefined), 'i');
    assert.equal(plainHead(page.query('b'), { component: 'Price' }), 'Total · <Price>');
  });
});
