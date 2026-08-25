import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { init } from './embed.ts';
import { mountPage } from './dom.fixture.ts';

/**
 * `init` is the published entry point, so the way it fails is part of the contract.
 *
 * What it does when it succeeds is covered where it can be seen: `package.spec.ts` loads the built
 * bundle onto a real page and plants a note through it.
 */

describe('init', () => {
  it('says what is wrong when there is no document to mount into', () => {
    // The first mistake anyone makes with a browser-only package is calling it while server
    // rendering. Left alone that reads as `Cannot read properties of undefined`, from inside a
    // bundle, in someone else's app.
    assert.throws(
      () => init({ endpoint: 'https://worker.test', clientId: 'acme', document: undefined as never }),
      /browser-only/,
    );
  });
});

describe('the optional picture', () => {
  const mountable = () => mountPage('<main><button id="cta">Commander</button></main>');

  it('is off until the reporter turns it on', () => {
    // An image of the page someone is looking at is not something to start sending because a default
    // said so. Read off the panel rather than the store, because the panel is what a reporter sees.
    const page = mountable();
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      captureScreenshot: async () => ({ url: 'https://cdn.test/shot.png' }),
    });
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

    assert.equal((root.querySelector('[name="screenshot"]') as HTMLInputElement).checked, false);

    widget.destroy();
  });

  it('offers the setting only when the host gave it something to capture with', () => {
    // The reason this toggle was left out of SKG-503: a switch that controls nothing.
    const bare = mountable();
    const widgetWithout = init({ document: bare.document, endpoint: 'https://worker.test', clientId: 'acme' });
    const withoutRoot = bare.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    assert.equal(withoutRoot.querySelector('[name="screenshot"]'), null);
    widgetWithout.destroy();

    const able = mountable();
    const widgetWith = init({
      document: able.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      captureScreenshot: async () => undefined,
    });
    const withRoot = able.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    assert.notEqual(withRoot.querySelector('[name="screenshot"]'), null);
    widgetWith.destroy();
  });

  // What happens once it is on — the capture throwing, returning a picture, returning nothing — needs
  // a real hit test to reach the popover, which happy-dom cannot do. It lives in `e2e/screenshot.spec.ts`.
});
