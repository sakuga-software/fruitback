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

describe('where a second instance keeps its preferences', () => {
  afterEach(() => {
    mock.restoreAll();
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const mountable = () => mountPage('<main><button id="cta">Commander</button></main>');

  /**
   * The store reads `globalThis.localStorage`, not the mounted document's own window — so this is
   * where the config has to be planted for the widget to find it. Written down because the first
   * version of these tests seeded `page.view.localStorage` and passed while asserting nothing: under
   * Node there is no global storage, so no config was ever read and both keys behaved alike.
   */
  function storageHolding(entries: Record<string, string>): void {
    const store = new Map(Object.entries(entries));
    const fake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };

    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  }

  /** Which worker was actually asked, which is the thing that goes wrong when a key is shared. */
  function urlsFetched(): string[] {
    const urls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      urls.push(String(input));

      return new Response(JSON.stringify({ issues: [] }), { headers: { 'Content-Type': 'application/json' } });
    });

    return urls;
  }

  /**
   * The defect this seam exists for, written as the failure rather than as the fix.
   *
   * The store lets what is in `localStorage` **override** what `init` was passed, which is right for
   * one widget and wrong for two. The browser extension (SKG-534) mounts a second one on a site that
   * may embed its own, and without a key of its own it would inherit the site's `endpoint` and
   * `clientId` — the reviewer's notes going to a worker nobody chose, with nothing on screen to say
   * so.
   */
  it('reads from the worker it was given, not the one the page remembered', async () => {
    const page = mountable();
    storageHolding({
      'fruitback:config': JSON.stringify({ endpoint: 'https://the-sites-own-worker.test', clientId: 'somebody-else' }),
    });
    const urls = urlsFetched();

    const widget = init({
      document: page.document,
      endpoint: 'https://mine.test',
      clientId: 'mine',
      configKey: 'fruitback:config:extension',
    });
    await widget.refresh();

    assert.ok(
      urls.at(-1)?.startsWith('https://mine.test/'),
      `asked ${urls.at(-1)} instead of the endpoint it was given`,
    );
    assert.ok(urls.at(-1)?.includes('client=mine'), `asked for ${urls.at(-1)}`);

    widget.destroy();
  });

  it('still remembers under the default key when no other was named', async () => {
    // The seam must change nothing for one widget on one page, which is every embed that exists.
    const page = mountable();
    storageHolding({
      'fruitback:config': JSON.stringify({ endpoint: 'https://remembered.test', clientId: 'acme' }),
    });
    const urls = urlsFetched();

    const widget = init({ document: page.document, endpoint: 'https://fresh.test', clientId: 'acme' });
    await widget.refresh();

    assert.ok(urls.at(-1)?.startsWith('https://remembered.test/'), `asked ${urls.at(-1)}`);

    widget.destroy();
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
    assert.equal(
      shadowOf(page).querySelectorAll('[data-fruitback-pin]').length,
      1,
      'the first read should have drawn a pin',
    );

    await widget.refresh();

    assert.equal(shadowOf(page).querySelectorAll('[data-fruitback-pin]').length, 1, 'the 401 blanked the page');

    widget.destroy();
  });
});

describe('the theme a host passes in', () => {
  it('reaches the host element, where an inline property beats the :host declaration', () => {
    // Written on the element rather than into the stylesheet on purpose: an inline custom property
    // wins without anyone needing a more specific selector (SKG-528).
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      theme: { 'color-accent': '#0055ff' },
    });

    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;
    assert.equal(container.style.getPropertyValue('--fruitback-color-accent'), '#0055ff');

    widget.destroy();
  });

  it('mounts with no theme at all, following the viewer’s own scheme', () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });

    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;
    // The container carries its own positioning, so what is asserted is that no token was written.
    assert.equal(container.style.getPropertyValue('--fruitback-color-accent'), '');
    assert.match(
      page.document.querySelector('[data-fruitback-host]')?.shadowRoot?.textContent ?? '',
      /prefers-color-scheme: dark/,
    );

    widget.destroy();
  });
});
