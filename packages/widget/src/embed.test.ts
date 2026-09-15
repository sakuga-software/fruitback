import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { init, plant } from './embed.ts';
import type { TransportRequest } from './transport.ts';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { readFile } from 'node:fs/promises';

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
    //
    // This asserted `init === undefined` until SKG-595, which is the shape the old code happened to
    // pass rather than the promise being made: every call carries a method now, so the absence of
    // the header is what has to be checked.
    const page = mountWithCta();
    const seen = stubReads(() => ok([]));

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    const headers = (seen.at(-1)?.headers ?? {}) as Record<string, string>;
    assert.deepEqual(
      Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization'),
      [],
    );

    widget.destroy();
  });

  it('offers in the settings only the stages the worker reports (SKG-525)', async () => {
    const page = mountWithCta();
    stubReads(
      () => new Response(JSON.stringify({ issues: [], stages: ['seeded', 'ripe', 'composted'] }), { status: 200 }),
    );

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    const box = (stage: string) =>
      shadowOf(page).querySelector(`[name="stage-${stage}"]`)?.closest('label') as HTMLLabelElement;
    assert.equal(box('green').hidden, true);
    assert.equal(box('ripe').hidden, false);

    widget.destroy();
  });

  it('offers every stage to a worker that does not say which', async () => {
    const page = mountWithCta();
    stubReads(() => ok([]));

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    const box = shadowOf(page).querySelector('[name="stage-green"]')?.closest('label') as HTMLLabelElement;
    assert.equal(box.hidden, false);

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

describe('who carries the calls', () => {
  const ENDPOINT = 'https://worker.test';

  afterEach(() => {
    mock.restoreAll();
  });

  /** Fails the test if anything reaches the network while a transport was supposed to carry it. */
  function forbidFetch() {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('the widget went to the network instead of using the transport it was given');
    });
  }

  it('uses the transport it was given, and never the network', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    forbidFetch();

    const seen: string[] = [];
    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      transport: async (request) => {
        seen.push(`${request.method} ${request.url}`);

        return { ok: true, status: 200, body: JSON.stringify({ issues: [] }) };
      },
    });
    await widget.refresh();

    assert.equal(seen.length > 0, true, 'the transport was never called');
    assert.equal(
      seen.at(-1)?.startsWith(`GET ${ENDPOINT}/feedback?url=`),
      true,
      `the transport was handed ${String(seen.at(-1))}`,
    );

    widget.destroy();
  });

  it('hands the transport the identity token, so a relay can carry it or replace it', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    forbidFetch();

    const seen: Record<string, string>[] = [];
    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      identityToken: () => 'a-token',
      transport: async (request) => {
        seen.push(request.headers);

        return { ok: true, status: 200, body: JSON.stringify({ issues: [] }) };
      },
    });
    await widget.refresh();

    assert.equal(seen.at(-1)?.Authorization, 'Bearer a-token');

    widget.destroy();
  });

  it('leaves a failing transport to the same rule as a failing fetch', async () => {
    // Losing what is correctly on screen is the failure this widget cannot afford, and a transport
    // that rejects must not be the one exception to it.
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    forbidFetch();

    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      transport: async () => {
        throw new Error('the relay is gone');
      },
    });

    await widget.refresh();

    widget.destroy();
  });

  /**
   * The write path, reached without the popover.
   *
   * The composer is behind a hit test happy-dom cannot do, but `plant` only needs a target, and a
   * target is an element. So the request the transport is handed can be asserted in full — method,
   * URL, headers and body — where before this suite only covered reads. Raised in review.
   *
   * What it still does not cover is the composer calling `plant` at all; that stays `e2e`'s.
   */
  it('hands the transport the whole write request, not only the read', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    const seen: TransportRequest[] = [];
    const planted = await plant({
      note: 'the price is wrong',
      target: { element: page.query('button'), source: undefined },
      reporter: undefined,
      config: { endpoint: ENDPOINT, clientId: 'acme', hiddenStages: [], screenshot: false },
      options: {
        endpoint: ENDPOINT,
        clientId: 'acme',
        identityToken: () => 'a-token',
        transport: async (request) => {
          seen.push(request);

          return { ok: true, status: 201, body: '{}' };
        },
      },
    });

    assert.equal(planted, true);

    const request = seen.at(-1);
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, `${ENDPOINT}/feedback`);
    assert.equal(request?.headers['Content-Type'], 'application/json');
    assert.equal(request?.headers.Authorization, 'Bearer a-token');
    assert.equal((JSON.parse(request?.body ?? '{}') as { note: string }).note, 'the price is wrong');
  });

  it('reports a refused write as a failure, so the composer keeps the note', async () => {
    // Losing what someone just wrote is the failure this widget cannot afford, and a relay that
    // answers `ok: false` must read as a failure rather than as a note that landed.
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    const planted = await plant({
      note: 'the price is wrong',
      target: { element: page.query('button'), source: undefined },
      reporter: undefined,
      config: { endpoint: ENDPOINT, clientId: 'acme', hiddenStages: [], screenshot: false },
      options: {
        endpoint: ENDPOINT,
        clientId: 'acme',
        transport: async () => ({ ok: false, status: 502, body: '{"error":"store-unavailable"}' }),
      },
    });

    assert.equal(planted, false);
  });

  /**
   * Both paths, from the source. A call added later that goes straight to the network bypasses the
   * seam silently, and silently is exactly how the extension relay would stop relaying.
   */
  it('has no call in embed.ts that goes around the transport', async () => {
    const source = await readFile(new URL('./embed.ts', import.meta.url), 'utf8');

    assert.equal(
      /(?<!\w)fetch\(/.test(source),
      false,
      'embed.ts calls fetch directly; route it through transportFor(options)',
    );

    // The lookbehind excludes a preceding word character and **not** a dot, on purpose: a
    // `globalThis.fetch(` or a `view.fetch(` is a bypass like any other, and the first version of
    // this check excluded the dot and let both through. Raised in review.
    //
    // Twice and no more: the import, and the one line of `transportFor`. A third mention is a call
    // site that took the default instead of asking, which the check above cannot see.
    assert.equal(
      source.match(/fetchTransport/g)?.length,
      2,
      'fetchTransport is named outside transportFor; call transportFor(options) instead',
    );
  });
});

describe('the language a mount speaks (SKG-530)', () => {
  const catalog = { fr: { 'launch.label': 'Laisser un feedback', 'settings.open': 'Ouvrir les réglages Fruitback' } };
  const shadow = (page: MountedPage) =>
    (page.document.querySelector('[data-fruitback-host]') as HTMLElement).shadowRoot;

  function pageInFrench(): MountedPage {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    Object.defineProperty(page.view.navigator, 'language', { value: 'fr-FR', configurable: true });
    // The global navigator is Node's. If it also said French, a binding that read it would pass.
    assert.notEqual(globalThis.navigator?.language, 'fr-FR');

    return page;
  }

  it('reads the language of the page it is mounted on, not the global one', () => {
    const page = pageInFrench();
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      messages: catalog,
    });

    try {
      assert.equal(shadow(page)?.querySelector('[data-fruitback-host-launch]')?.textContent, 'Laisser un feedback');
      assert.equal(
        shadow(page)?.querySelector('[data-fruitback-host-configure]')?.getAttribute('aria-label'),
        'Ouvrir les réglages Fruitback',
      );
    } finally {
      widget.destroy();
    }
  });

  it('speaks the bundled French on a French page, with no catalog passed (SKG-531)', () => {
    const page = pageInFrench();
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });

    try {
      assert.equal(shadow(page)?.querySelector('[data-fruitback-host-launch]')?.textContent, 'Laisser un feedback');
      assert.equal((page.document.querySelector('[data-fruitback-host]') as HTMLElement).lang, 'fr');
    } finally {
      widget.destroy();
    }
  });

  it('lets `locale` win over the page language, and `label` win over the catalog', () => {
    const page = pageInFrench();
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      messages: catalog,
      locale: 'en',
    });

    try {
      assert.equal(shadow(page)?.querySelector('[data-fruitback-host-launch]')?.textContent, 'Leave feedback');
    } finally {
      widget.destroy();
    }

    const labelled = pageInFrench();
    const second = init({
      document: labelled.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      messages: catalog,
      label: 'Feedback',
    });

    try {
      assert.equal(shadow(labelled)?.querySelector('[data-fruitback-host-launch]')?.textContent, 'Feedback');
    } finally {
      second.destroy();
    }
  });
});
