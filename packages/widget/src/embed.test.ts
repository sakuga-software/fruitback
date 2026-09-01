import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { init } from './embed.ts';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

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

describe('reading pins', () => {
  const PAGE = '<main><section><button data-testid="checkout-cta">Commander</button></section></main>';
  const ENDPOINT = 'https://worker.test';

  afterEach(() => {
    mock.restoreAll();
  });

  function mountWithCta(): MountedPage {
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

    return page;
  }

  function onCta() {
    return seedIssueFixture({
      seed: seedFixture({
        anchor: {
          selector: '[data-testid="checkout-cta"]',
          tag: 'button',
          text: 'Commander',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
    });
  }

  function shadowOf(page: MountedPage): ShadowRoot {
    return page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
  }

  /** Answers each read in turn, so a test can make the second one fail. */
  function stubReads(...responses: (() => Response)[]) {
    const seen: (RequestInit | undefined)[] = [];
    let call = 0;
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      seen.push(init);

      return (responses[Math.min(call++, responses.length - 1)] ?? (() => ok([])))();
    });

    return seen;
  }

  const ok = (issues: unknown[]) => new Response(JSON.stringify({ issues }), { status: 200 });

  it('sends the identity token on a read, not only on a write', async () => {
    // A client configured `read: "authenticated"` (SKG-533) answers 401 without one, so the reader
    // has to carry the same token the write path already did.
    const page = mountWithCta();
    const seen = stubReads(() => ok([]));

    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      identityToken: () => 'a-token',
    });
    await widget.refresh();

    const headers = seen.at(-1)?.headers as Record<string, string> | undefined;
    assert.equal(headers?.Authorization, 'Bearer a-token');

    widget.destroy();
  });

  it('sends no Authorization header when the host mints no token', async () => {
    // The anonymous case stays the default, and an empty header is not the same as none.
    const page = mountWithCta();
    const seen = stubReads(() => ok([]));

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    assert.equal(seen.at(-1), undefined);

    widget.destroy();
  });

  it('keeps the pins already on screen when a read comes back 401', async () => {
    // Losing what is correctly displayed is the failure this widget cannot afford. A token that
    // expired mid-session must not read as "my notes are gone" — same rule as an unreachable worker.
    const page = mountWithCta();
    stubReads(
      () => ok([onCta()]),
      () => new Response(JSON.stringify({ error: 'identity-required' }), { status: 401 }),
    );

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();
    assert.equal(shadowOf(page).querySelectorAll('[data-fb-pin]').length, 1, 'the first read should have drawn a pin');

    await widget.refresh();

    assert.equal(shadowOf(page).querySelectorAll('[data-fb-pin]').length, 1, 'the 401 blanked the page');

    widget.destroy();
  });
});
