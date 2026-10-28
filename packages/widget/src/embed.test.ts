import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '@fruitback/shared';
import { failureOf, init, plant, sendDrafts } from './embed.ts';
import { capturePlace } from './capture.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type MountedPage, globalNavigatorSpeaks, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
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
   * The store used to let what is in `localStorage` **override** the `endpoint` and the `clientId`
   * that `init` was passed. The browser extension (FRU-41) mounts a second widget on a site that
   * may embed its own: the notes of the reviewer went to a worker nobody chose, with nothing on
   * screen to say so. A key of its own was the first fix. Since FRU-89 no key holds them.
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

  it('reads from the worker it was given under the default key too (FRU-89)', async () => {
    // The page can write this key. A stored endpoint used to win here, for every ordinary embed.
    const page = mountable();
    storageHolding({
      'fruitback:config': JSON.stringify({ endpoint: 'https://remembered.test', clientId: 'acme' }),
    });
    const urls = urlsFetched();

    const widget = init({ document: page.document, endpoint: 'https://fresh.test', clientId: 'acme' });
    await widget.refresh();

    assert.ok(urls.at(-1)?.startsWith('https://fresh.test/'), `asked ${urls.at(-1)}`);

    widget.destroy();
  });
});

describe('the corner a reporter chooses in the settings (FRU-472)', () => {
  afterEach(() => {
    mock.restoreAll();
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  function storageHolding(entries: Record<string, string>): Map<string, string> {
    const store = new Map(Object.entries(entries));
    const fake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });

    return store;
  }

  function mounted(position?: 'top-right' | 'top-left') {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      ...(position !== undefined ? { position } : {}),
    });
    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;
    const root = container.shadowRoot as ShadowRoot;
    const radio = (corner: string) =>
      root.querySelector(`input[name="dock-position"][value="${corner}"]`) as HTMLInputElement;
    const choose = (corner: string) => {
      radio(corner).checked = true;
      radio(corner).dispatchEvent(new page.document.defaultView!.Event('change', { bubbles: true }));
    };

    return { widget, corner: () => container.dataset.fruitbackPosition, radio, choose };
  }

  it('offers the corner the dock stands in, and moves the dock to the one chosen', () => {
    storageHolding({});
    const { widget, corner, radio, choose } = mounted('top-right');
    assert.equal(radio('top-right').checked, true, 'the host corner is not the one offered as chosen');

    choose('bottom-left');
    assert.equal(corner(), 'bottom-left');
    assert.equal(radio('top-right').checked, false);

    widget.destroy();
  });

  it('keeps the choice for this site, and it beats the position of init', () => {
    storageHolding({ 'fruitback:config': JSON.stringify({ position: 'bottom-left' }) });
    const { widget, corner, radio } = mounted('top-right');

    assert.equal(corner(), 'bottom-left');
    assert.equal(radio('bottom-left').checked, true);

    widget.destroy();
  });

  it('is forgotten by a later moveDock of the host, which is the newer word', () => {
    const stored = storageHolding({});
    const { widget, corner, radio, choose } = mounted();
    assert.equal(radio('bottom-right').checked, true, 'left out, the dock is at the bottom right');

    choose('top-left');
    assert.equal(corner(), 'top-left');
    widget.moveDock('top-right');
    assert.equal(corner(), 'top-right');
    assert.equal(radio('top-right').checked, true);
    assert.equal(stored.get('fruitback:config')?.includes('position'), false, 'the old choice is still stored');

    widget.moveDock(undefined);
    assert.equal(corner(), undefined);

    widget.destroy();
  });
});

describe('« All pages » of the list (FRU-470)', () => {
  it('is offered when the host gives siteNotes, and knows the note of the page open now', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const asked: unknown[] = [];
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      siteNotes: async (query) => {
        asked.push(query);

        return {
          ok: true,
          notes: [
            {
              note: 'n1',
              excerpt: 'Here',
              // The address of the page with a fragment and a query in another order: the same page.
              page: { url: 'https://preview.acme.test/pricing#top', path: '/pricing' },
              stage: 'new',
              createdAt: '2026-10-09T10:00:00.000Z',
            },
          ],
          total: 1,
        };
      },
    });
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    widget.showEveryNote();
    (root.querySelector('[data-fruitback-scope="site"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(asked, [{}]);
    const row = root.querySelector('[data-fruitback-site-note="n1"]');
    assert.match(row?.querySelector('.fruitback-sidebar-meta')?.textContent ?? '', /^this page/);
    widget.destroy();
  });

  it('is not offered without it', () => {
    const page = mountPage('<main></main>');
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    widget.showEveryNote();

    assert.equal(root.querySelector('[data-fruitback-scope]'), null);
    widget.destroy();
  });
});

describe('the button of the list and the side panel of a host (FRU-469)', () => {
  function mounted(openSidebar?: () => Promise<boolean>) {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      ...(openSidebar === undefined ? {} : { openSidebar }),
    });
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    const button = root.querySelector('[aria-label="Show every note in a sidebar"]') as HTMLButtonElement;
    const listOpen = () => (root.querySelector('[data-fruitback-sidebar]') as HTMLElement).hidden === false;

    return { widget, button, listOpen };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('opens the side panel of the host, in the click, and not the list of the page', async () => {
    let asked = 0;
    const { widget, button, listOpen } = mounted(async () => {
      asked += 1;

      return true;
    });
    button.click();
    assert.equal(asked, 1, 'not asked in the click');
    await settle();
    assert.equal(listOpen(), false);
    widget.destroy();
  });

  it('opens the list of the page when the host could not open its panel, or failed', async () => {
    for (const openSidebar of [
      async () => false,
      async () => {
        throw new Error('no gesture');
      },
      () => {
        throw new Error('sync');
      },
    ]) {
      const { widget, button, listOpen } = mounted(openSidebar as () => Promise<boolean>);
      button.click();
      await settle();
      assert.equal(listOpen(), true);
      widget.destroy();
    }
  });

  it('opens the list of the page with no host panel, as before', () => {
    const { widget, button, listOpen } = mounted();
    button.click();
    assert.equal(listOpen(), true);
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
    // The reason this toggle was left out of FRU-14: a switch that controls nothing.
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
    return noteIssueFixture({
      note: noteFixture({
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
    // A client configured `read: "authenticated"` (FRU-40) answers 401 without one, so the reader
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

  it('asks for no name when the host mints identity tokens (FRU-91)', () => {
    // The worker replaces a typed name by the identity of the token, so the field would lie.
    const named = mountWithCta();
    stubReads(() => ok([]));
    const withToken = init({
      document: named.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      identityToken: () => 't',
    });
    assert.equal((shadowOf(named).querySelector('[data-fruitback-who]') as HTMLElement).hidden, true);
    withToken.destroy();

    const anonymous = mountWithCta();
    const without = init({ document: anonymous.document, endpoint: ENDPOINT, clientId: 'acme' });
    assert.equal((shadowOf(anonymous).querySelector('[data-fruitback-who]') as HTMLElement).hidden, false);
    without.destroy();
  });

  it('sends no Authorization header when the host mints no token', async () => {
    // The anonymous case stays the default, and an empty header is not the same as none.
    //
    // This asserted `init === undefined` until FRU-56, which is the shape the old code happened to
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

  it('offers in the settings only the stages the worker reports (FRU-32)', async () => {
    const page = mountWithCta();
    stubReads(() => new Response(JSON.stringify({ issues: [], stages: ['new', 'done', 'closed'] }), { status: 200 }));

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    const box = (stage: string) =>
      shadowOf(page).querySelector(`[name="stage-${stage}"]`)?.closest('label') as HTMLLabelElement;
    assert.equal(box('todo').hidden, true);
    assert.equal(box('done').hidden, false);

    widget.destroy();
  });

  it('offers every stage to a worker that does not say which', async () => {
    const page = mountWithCta();
    stubReads(() => ok([]));

    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();

    const box = shadowOf(page).querySelector('[name="stage-todo"]')?.closest('label') as HTMLLabelElement;
    assert.equal(box.hidden, false);

    widget.destroy();
  });

  it('shows where a note goes only while the worker offers this reader two places or more (FRU-123)', async () => {
    const page = mountWithCta();
    const places = [
      { id: 'dst_web', label: 'Linear · Web' },
      { id: 'dst_design', label: 'Linear · Design' },
    ];
    const answer = (more: object) => () => new Response(JSON.stringify({ issues: [], ...more }), { status: 200 });
    stubReads(
      // A worker older than the list, or any reader who is not a member: the composer of FRU-89.
      answer({}),
      answer({ destinations: places }),
      // One bad entry costs the list: the default on screen must be the default of the worker.
      answer({ destinations: [{ label: 'No id' }, ...places] }),
      answer({ destinations: places }),
      // A site that kept one place.
      answer({ destinations: places.slice(0, 1) }),
      answer({ destinations: places }),
      // The reader left the team: the field is gone, and the names with it.
      answer({}),
    );
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    const line = () => shadowOf(page).querySelector('[data-fruitback-destination]') as HTMLButtonElement;
    const radios = () => shadowOf(page).querySelectorAll('[data-fruitback-destinations] input').length;
    const shown = async () => {
      await widget.refresh();

      return { line: !line().hidden, radios: radios() };
    };

    assert.deepEqual(await shown(), { line: false, radios: 0 });
    assert.deepEqual(await shown(), { line: true, radios: 2 });
    assert.equal(line().textContent, 'Send to: Linear · Web');
    assert.deepEqual(await shown(), { line: false, radios: 0 });
    assert.deepEqual(await shown(), { line: true, radios: 2 });
    assert.deepEqual(await shown(), { line: false, radios: 0 });
    assert.deepEqual(await shown(), { line: true, radios: 2 });
    assert.deepEqual(await shown(), { line: false, radios: 0 });

    widget.destroy();
  });

  it('asks for no name while the worker says it would sign the notes of this reader (FRU-112)', async () => {
    // Team mode: the widget holds a transport and no token, so only a read can tell it.
    const page = mountWithCta();
    const answer = (more: object) => () => new Response(JSON.stringify({ issues: [], ...more }), { status: 200 });
    stubReads(
      answer({}),
      answer({ identified: true }),
      // Only `true` is the word of the worker.
      answer({ identified: 'yes' }),
      answer({ identified: true }),
      // A read that fails says nothing: the reviewer is still who they were.
      () => new Response('{}', { status: 502 }),
      // The session ended: the field comes back.
      answer({}),
    );
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    const asked = async () => {
      await widget.refresh();

      return !(shadowOf(page).querySelector('[data-fruitback-who]') as HTMLElement).hidden;
    };

    assert.deepEqual(
      [await asked(), await asked(), await asked(), await asked(), await asked(), await asked()],
      [true, false, true, false, false, true],
    );

    widget.destroy();
  });

  it('keeps the places on screen when a read fails, like the pins', async () => {
    const page = mountWithCta();
    stubReads(
      () =>
        new Response(JSON.stringify({ issues: [], destinations: [{ id: 'dst_web' }, { id: 'dst_design' }] }), {
          status: 200,
        }),
      () => new Response('{"error":"invalid-token"}', { status: 401 }),
    );
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme' });
    await widget.refresh();
    await widget.refresh();

    const line = shadowOf(page).querySelector('[data-fruitback-destination]') as HTMLButtonElement;
    assert.equal(line.hidden, false);

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

  it('gives the notes on screen as text, without the stages the reporter hid (FRU-109)', async () => {
    const page = mountWithCta();
    const closed = noteIssueFixture({
      ...onCta(),
      id: 'closed',
      identifier: 'FB-2',
      stage: 'closed',
      stateName: 'Closed',
    });
    const reads = stubReads(() => ok([{ ...onCta(), identifier: 'FB-1' }, closed]));
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', locale: 'en' });
    await widget.refresh();
    const before = reads.length;

    const both = widget.feedbackAsText();
    assert.match(both, /^## 1\. FB-1 — /m);
    assert.match(both, /^## 2\. FB-2 — Closed$/m);
    assert.match(both, /^# Feedback on /m);

    (shadowOf(page).querySelector('[name="stage-closed"]') as HTMLInputElement).click();

    assert.doesNotMatch(widget.feedbackAsText(), /FB-2/);
    assert.match(widget.feedbackAsText(), /^## 1\. FB-1 — /m);
    assert.equal(reads.length, before, 'the text cost a request');

    widget.destroy();
  });

  it('counts the notes the page shows by stage, from the last read, and nothing before one (FRU-254)', async () => {
    const page = mountWithCta();
    const closed = noteIssueFixture({ ...onCta(), id: 'closed', identifier: 'FB-2', stage: 'closed' });
    const fresh = noteIssueFixture({ ...onCta(), id: 'fresh', identifier: 'FB-3', stage: 'new' });
    const reads = stubReads(() => ok([{ ...onCta(), identifier: 'FB-1', stage: 'progress' }, closed, fresh]));
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', locale: 'en' });

    assert.equal(widget.pageCounts(), undefined, 'a count before any read says there is no note');
    await widget.refresh();
    const before = reads.length;
    assert.deepEqual(widget.pageCounts(), { new: 1, todo: 0, progress: 1, done: 0, closed: 1 });

    // A stage the reporter hid is not on the page, so it is not counted.
    (shadowOf(page).querySelector('[name="stage-closed"]') as HTMLInputElement).click();
    assert.deepEqual(widget.pageCounts(), { new: 1, todo: 0, progress: 1, done: 0, closed: 0 });
    assert.equal(reads.length, before, 'a count cost a request');

    widget.destroy();
  });

  it('starts choosing an element, and opens the list, when the host asks (FRU-254)', async () => {
    const page = mountWithCta();
    stubReads(() => ok([onCta()]));
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', locale: 'en' });
    await widget.refresh();
    const list = () => shadowOf(page).querySelector('[data-fruitback-sidebar]') as HTMLElement | null;

    widget.showEveryNote();
    assert.equal(list()?.hidden, false, 'the list did not open');

    // Choosing an element closes the list: the dock and the frame are what the page shows then.
    assert.equal(widget.leaveFeedback(), true);
    assert.equal(list()?.hidden ?? true, true, 'the list stayed open over the choice');
    // Asked again while choosing: the choice is on, so it is done, and nothing starts over. Only a
    // note being written makes the widget say no (raised in review).
    assert.equal(widget.leaveFeedback(), true);
    assert.equal(page.document.querySelectorAll('[data-fruitback-capturing]').length, 1);

    // Somebody writes: nothing takes the place of the note.
    // (A composer that only says « sent » closes instead: `popup-workspace.spec.ts` sends one.)
    // The launch button stops the choice it started.
    (shadowOf(page).querySelector('button[aria-pressed="true"]') as HTMLElement).click();
    assert.equal(
      page.document.querySelector('[data-fruitback-capturing]'),
      null,
      'the launch button did not stop the choice',
    );
    const composer = shadowOf(page).querySelector('[data-fruitback-composer]') as HTMLElement;
    composer.hidden = false;
    assert.equal(widget.leaveFeedback(), false);
    assert.equal(composer.hidden, false);

    widget.destroy();
  });

  it('ignores the answer of a read that a newer read replaced', async () => {
    // Two reads can be in flight, and nothing makes them answer in the order they were sent.
    const page = mountWithCta();
    const answers: ((response: TransportResponse) => void)[] = [];
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const answerWith = (issues: unknown[]): TransportResponse => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ issues }),
    });

    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      transport: () => new Promise((resolve) => answers.push(resolve)),
    });
    await settle();
    const newer = widget.refresh();
    await settle();
    assert.equal(answers.length, 2, 'the two reads are not both in flight');

    answers[1]?.(answerWith([onCta()]));
    await newer;
    assert.equal(shadowOf(page).querySelectorAll('[data-fruitback-pin]').length, 1);

    answers[0]?.(answerWith([]));
    await settle();

    assert.equal(shadowOf(page).querySelectorAll('[data-fruitback-pin]').length, 1, 'the old read drew last');

    widget.destroy();
  });
});

describe('coming back to the tab (FRU-87)', () => {
  const PAGE = '<main><section><button data-testid="checkout-cta">Commander</button></section></main>';
  const ENDPOINT = 'https://worker.test';

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  function onCta() {
    return noteIssueFixture({
      note: noteFixture({
        anchor: {
          selector: '[data-testid="checkout-cta"]',
          tag: 'button',
          text: 'Commander',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
    });
  }

  /** A widget that counts its reads, on a clock the test moves. */
  async function mounted(issues = [onCta()]) {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

    let reads = 0;
    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      transport: async () => {
        reads += 1;

        return { ok: true, status: 200, body: JSON.stringify({ issues }) };
      },
    });
    await widget.refresh();
    const before = reads;

    const comeBack = async (state: 'visible' | 'hidden' = 'visible'): Promise<void> => {
      Object.defineProperty(page.document, 'visibilityState', { value: state, configurable: true });
      const EventCtor = (page.view as unknown as { Event: typeof Event }).Event;
      page.document.dispatchEvent(new EventCtor('visibilitychange'));
      // The read is started and not awaited by the listener, so its turns are let through here.
      await new Promise((resolve) => setImmediate(resolve));
    };

    return { page, widget, comeBack, readsSince: () => reads - before };
  }

  it('reads again when the tab is visible again and the last read is old', async () => {
    const { widget, comeBack, readsSince } = await mounted();

    mock.timers.tick(15_000);
    await comeBack();

    assert.equal(readsSince(), 1);
    widget.destroy();
  });

  it('does not read while the worker would still answer from its cache', async () => {
    const { widget, comeBack, readsSince } = await mounted();

    mock.timers.tick(14_999);
    await comeBack();

    assert.equal(readsSince(), 0);
    widget.destroy();
  });

  it('does not read when the tab goes to the background', async () => {
    const { widget, comeBack, readsSince } = await mounted();

    mock.timers.tick(60_000);
    await comeBack('hidden');

    assert.equal(readsSince(), 0);
    widget.destroy();
  });

  it('leaves an open thread alone, because a read would close it', async () => {
    const { page, widget, comeBack, readsSince } = await mounted();
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    (root.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.ok(root.querySelector('.fruitback-thread'), 'the thread did not open');

    mock.timers.tick(60_000);
    await comeBack();

    assert.equal(readsSince(), 0);
    assert.ok(root.querySelector('.fruitback-thread'), 'the thread was closed');
    widget.destroy();
  });

  it('stops listening when the widget is destroyed', async () => {
    const { widget, comeBack, readsSince } = await mounted();
    widget.destroy();

    mock.timers.tick(60_000);
    await comeBack();

    assert.equal(readsSince(), 0);
  });
});

describe('the theme a host passes in', () => {
  it('reaches the host element, where an inline property beats the :host declaration', () => {
    // Written on the element rather than into the stylesheet on purpose: an inline custom property
    // wins without anyone needing a more specific selector (FRU-35).
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
      config: { hiddenStages: [], screenshot: false },
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
    assert.equal((JSON.parse(request?.body ?? '{}') as { text: string }).text, 'the price is wrong');
  });

  it('sends the note to the page where the element was chosen, after a navigation (FRU-152)', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>', {
      url: 'https://preview.acme.test/pricing',
    });
    setDocumentSize(page.document, 1_000, 1_000);
    const button = page.query('button');
    setRect(button, { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    // The click reads the place. The page then moves on without a reload, and its content goes.
    const place = capturePlace(button);
    page.view.history.pushState(null, '', '/checkout');
    page.document.body.innerHTML = '<main><h2>Votre commande</h2></main>';

    const seen: TransportRequest[] = [];
    const send = (withPlace: boolean) =>
      plant({
        note: 'the price is wrong',
        target: { element: button, source: undefined },
        ...(withPlace ? { place } : {}),
        reporter: undefined,
        config: { hiddenStages: [], screenshot: false },
        options: {
          endpoint: ENDPOINT,
          clientId: 'acme',
          transport: async (request) => {
            seen.push(request);

            return { ok: true, status: 201, body: '{}' };
          },
        },
      });

    assert.equal(await send(true), true);
    // The control: read at the send, the place is the page of now. This is the defect.
    assert.equal(await send(false), true);

    const [kept, late] = seen.map(
      (request) =>
        JSON.parse(request.body ?? '{}') as { page: { url: string }; anchor: { selector: string; text?: string } },
    );
    assert.equal(kept?.page.url, 'https://preview.acme.test/pricing');
    assert.equal(kept?.anchor.text, 'Commander');
    assert.equal(kept?.anchor.selector, '#cta');
    assert.equal(late?.page.url, 'https://preview.acme.test/checkout');
    assert.equal(parseNote(kept).ok, true);
  });

  it('sends no picture of the page of now beside a place of the page before (FRU-152)', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>', {
      url: 'https://preview.acme.test/pricing',
    });
    setDocumentSize(page.document, 1_000, 1_000);
    const button = page.query('button');
    setRect(button, { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    const pictures: Element[] = [];
    const send = () =>
      plant({
        note: 'the price is wrong',
        target: { element: button, source: undefined },
        place,
        reporter: undefined,
        config: { hiddenStages: [], screenshot: true },
        options: {
          endpoint: ENDPOINT,
          clientId: 'acme',
          captureScreenshot: async (element) => {
            pictures.push(element);

            return { url: 'https://cdn.test/shot.png', width: 200, height: 40 };
          },
          transport: async (request) => {
            bodies.push(JSON.parse(request.body ?? '{}') as { screenshot?: unknown });

            return { ok: true, status: 201, body: '{}' };
          },
        },
      });
    const bodies: { screenshot?: unknown }[] = [];
    const place = capturePlace(button);

    // The control: on the same page, the picture goes with the note.
    assert.equal(await send(), true);
    assert.equal(pictures.length, 1);
    assert.notEqual(bodies[0]?.screenshot, undefined);

    // Another address, the element still in the page: no picture.
    page.view.history.pushState(null, '', '/checkout');
    assert.equal(await send(), true);
    assert.equal(pictures.length, 1);
    assert.equal(bodies[1]?.screenshot, undefined);

    // Back on the address, the element gone: no picture either.
    page.view.history.pushState(null, '', '/pricing');
    page.document.body.innerHTML = '<main></main>';
    assert.equal(await send(), true);
    assert.equal(pictures.length, 1);
    assert.equal(bodies[2]?.screenshot, undefined);
  });

  it('says a picture that was asked for and did not come, and the note goes without it (FRU-238)', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    const button = page.query('button');
    setRect(button, { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();
    const bodies: { screenshot?: unknown }[] = [];
    const send = (screenshot: boolean, captureScreenshot: () => Promise<{ url: string } | undefined>) =>
      plant({
        note: 'the price is wrong',
        target: { element: button, source: undefined },
        reporter: undefined,
        config: { hiddenStages: [], screenshot },
        options: {
          endpoint: ENDPOINT,
          clientId: 'acme',
          captureScreenshot,
          transport: async (request) => {
            bodies.push(JSON.parse(request.body ?? '{}') as { screenshot?: unknown });

            return { ok: true, status: 201, body: '{}' };
          },
        },
      });

    // Refused by the extension, or thrown: the note goes, and the answer says the picture is missing.
    assert.deepEqual(await send(true, async () => undefined), { picture: 'missed' });
    assert.deepEqual(
      await send(true, async () => {
        throw new Error('refused');
      }),
      { picture: 'missed' },
    );
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.screenshot, undefined);
    // The control: a picture that came, and a picture nobody asked for, say nothing more.
    assert.equal(await send(true, async () => ({ url: 'https://cdn.test/shot.png' })), true);
    assert.equal(await send(false, async () => undefined), true);
  });

  it('names the place a member chose in the query, and leaves the body the note it was (FRU-123)', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    const seen: TransportRequest[] = [];
    const send = (destination?: string) =>
      plant({
        note: 'the price is wrong',
        target: { element: page.query('button'), source: undefined },
        reporter: undefined,
        ...(destination === undefined ? {} : { destination }),
        config: { hiddenStages: [], screenshot: false },
        options: {
          endpoint: ENDPOINT,
          clientId: 'acme',
          transport: async (request) => {
            seen.push(request);

            return { ok: true, status: 201, body: '{}' };
          },
        },
      });

    assert.equal(await send(), true);
    // An id is opaque: whatever it holds, it stays one value of one parameter.
    assert.equal(await send('dst_1a2b&client=other#x'), true);

    const [plain, chosen] = seen;
    assert.equal(plain?.url, `${ENDPOINT}/feedback`);
    assert.equal(chosen?.url, `${ENDPOINT}/feedback?destination=dst_1a2b%26client%3Dother%23x`);
    assert.equal(new URL(chosen?.url ?? '').searchParams.get('destination'), 'dst_1a2b&client=other#x');
    // The choice adds no header: the relay of the extension would drop one in silence.
    assert.deepEqual(Object.keys(chosen?.headers ?? {}), ['Content-Type']);

    // The body is the note and nothing more. Two captures differ by their id and their time only.
    const fields = (request: TransportRequest | undefined) => {
      const { id: _id, createdAt: _createdAt, ...rest } = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;

      return rest;
    };
    assert.deepEqual(fields(chosen), fields(plain));
    assert.equal(chosen?.body?.includes('destination'), false);
    assert.equal(parseNote(JSON.parse(chosen?.body ?? '{}')).ok, true);
  });

  it('keeps the note when the worker refuses the place with a 403, like any other refusal (FRU-123)', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    forbidFetch();

    const planted = await plant({
      note: 'the price is wrong',
      target: { element: page.query('button'), source: undefined },
      reporter: undefined,
      destination: 'dst_gone',
      config: { hiddenStages: [], screenshot: false },
      options: {
        endpoint: ENDPOINT,
        clientId: 'acme',
        transport: async () => ({ ok: false, status: 403, body: '{"error":"destination-not-allowed"}' }),
      },
    });

    assert.equal(planted, 'retry');
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
      config: { hiddenStages: [], screenshot: false },
      options: {
        endpoint: ENDPOINT,
        clientId: 'acme',
        transport: async () => ({ ok: false, status: 502, body: '{"error":"store-unavailable"}' }),
      },
    });

    assert.equal(planted, 'retry');
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

describe('the language a mount speaks (FRU-37)', () => {
  const catalog = { fr: { 'launch.label': 'Laisser un feedback', 'settings.open': 'Ouvrir les réglages Fruitback' } };
  const shadow = (page: MountedPage) =>
    (page.document.querySelector('[data-fruitback-host]') as HTMLElement).shadowRoot;

  afterEach(() => {
    mock.restoreAll();
  });

  function pageInFrench(): MountedPage {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    Object.defineProperty(page.view.navigator, 'language', { value: 'fr-FR', configurable: true });
    // The global navigator is Node's, and it speaks the language of the shell. If it also said
    // French, a binding that read it would pass. So the test gives it English, on every machine.
    globalNavigatorSpeaks('en-US');
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

  it('speaks the bundled French on a French page, with no catalog passed (FRU-38)', () => {
    const page = pageInFrench();
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });

    try {
      assert.equal(shadow(page)?.querySelector('[data-fruitback-host-launch]')?.textContent, 'Laisser une note');
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

/**
 * The list when no read answered (FRU-153).
 *
 * A worker that does not answer the first read leaves no pin, and the list used to say « No note on
 * this page yet ». A reviewer who comes back during an outage then believes the notes are gone.
 */
describe('the list after a failed read (FRU-153)', () => {
  afterEach(() => mock.restoreAll());

  function mountWith(answers: TransportResponse[]) {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    mock.method(globalThis, 'fetch', () => {
      throw new Error('this test goes through the transport');
    });
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      locale: 'en',
      transport: async () => answers.shift() ?? { ok: false, status: 503, body: '' },
    });
    const shadow = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    const sidebar = shadow.querySelector('[data-fruitback-sidebar]') as HTMLElement;
    const visible = (selector: string) => {
      const element = sidebar.querySelector<HTMLElement>(selector);

      return element !== null && !element.hidden;
    };
    const text = (selector: string) => sidebar.querySelector(selector)?.textContent ?? '';
    // Opened once the read settled, as a reviewer who opens the list after the page loaded.
    const open = () => (shadow.querySelector('[data-fruitback-host-list]') as HTMLElement).click();

    return { widget, shadow, sidebar, visible, text, open };
  }

  const empty: TransportResponse = { ok: true, status: 200, body: JSON.stringify({ issues: [] }) };
  const refused: TransportResponse = { ok: false, status: 503, body: '{"error":"store-unavailable"}' };

  it('says the notes could not be read, and neither « 0 notes » nor that there is none', async () => {
    const { widget, visible, text, shadow, open } = mountWith([refused]);
    await widget.refresh();
    open();

    assert.equal(visible('.fruitback-sidebar-empty'), false);
    // The scope and the chips carry no number: zero notes would be a guess.
    assert.equal(text('.fruitback-sidebar-scope'), 'This page');
    assert.equal(text('[data-fruitback-chip="all"]'), 'All');
    assert.equal(visible('.fruitback-sidebar-failed'), true);
    assert.match(text('[role="status"]'), /could not be read/);
    assert.equal(shadow.activeElement?.textContent, 'Try again');

    widget.destroy();
  });

  it('says the same when the worker cannot be reached at all', async () => {
    const page = mountPage('<main></main>');
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      locale: 'en',
      transport: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await widget.refresh();
    const shadow = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    (shadow.querySelector('[data-fruitback-host-list]') as HTMLElement).click();

    assert.equal((shadow.querySelector('.fruitback-sidebar-failed') as HTMLElement).hidden, false);
    assert.equal((shadow.querySelector('.fruitback-sidebar-empty') as HTMLElement).hidden, true);

    widget.destroy();
  });

  it('shows the empty state when the worker answers an empty list: the control', async () => {
    const { widget, visible, text, open } = mountWith([empty]);
    await widget.refresh();
    open();

    assert.equal(visible('.fruitback-sidebar-failed'), false);
    assert.equal(visible('.fruitback-sidebar-empty'), true);
    assert.equal(text('.fruitback-sidebar-empty'), 'No note on this page yet.');
    assert.equal(text('.fruitback-sidebar-scope'), 'This page · 0');
    assert.equal(text('[data-fruitback-chip="all"]'), 'All 0');

    widget.destroy();
  });

  it('reads again on « Try again », and a good answer replaces the message', async () => {
    // A read that a newer one replaced never reaches the transport: one answer for each read that does.
    const answers = [refused];
    const { widget, visible, text, sidebar, open } = mountWith(answers);
    await widget.refresh();
    open();
    assert.equal(visible('.fruitback-sidebar-failed'), true);

    answers.push(empty);
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => (settled = resolve));
    const observer = new (sidebar.ownerDocument.defaultView as unknown as typeof globalThis).MutationObserver(() => {
      if (text('.fruitback-sidebar-empty') === 'No note on this page yet.') settled();
    });
    observer.observe(sidebar, { subtree: true, childList: true, characterData: true });
    (sidebar.querySelector('.fruitback-sidebar-retry') as HTMLElement).click();
    // The button stays, busy, while the read runs: focus does not move.
    assert.equal(visible('.fruitback-sidebar-failed'), true);
    assert.equal(text('[role="status"]'), 'Reading the notes of this page…');
    await done;
    observer.disconnect();

    assert.equal(visible('.fruitback-sidebar-failed'), false);
    assert.equal(text('.fruitback-sidebar-empty'), 'No note on this page yet.');

    widget.destroy();
  });

  it('keeps what a good read said when a later read fails', async () => {
    const { widget, visible, text, open } = mountWith([empty, refused]);
    await widget.refresh();
    await widget.refresh();
    open();

    assert.equal(visible('.fruitback-sidebar-failed'), false);
    assert.equal(text('.fruitback-sidebar-empty'), 'No note on this page yet.');

    widget.destroy();
  });
});

/**
 * What a refused write says to the reporter (FRU-156). One sentence for six causes told the reporter
 * to try again where trying again could never work.
 */
describe('why a send failed', () => {
  const answer = (status: number, error?: string) => ({
    status,
    body: error === undefined ? '' : JSON.stringify({ error }),
  });

  it('says to try again when the worker failed or could not keep the note', () => {
    assert.equal(failureOf(answer(503, 'store-unavailable')), 'retry');
    assert.equal(failureOf(answer(502)), 'retry');
    assert.equal(failureOf(answer(500, 'internal')), 'retry');
  });

  it('says to wait on a 429', () => {
    assert.equal(failureOf(answer(429, 'rate-limited')), 'wait');
  });

  it('says to sign in again on a 401 (FRU-193), and that the site is for members when no session came (FRU-394)', () => {
    // The team of the site can do nothing about a session that ended: the reporter can.
    assert.equal(failureOf(answer(401, 'invalid-identity')), 'signed-out');
    assert.equal(failureOf(answer(401)), 'signed-out');
    // No session at all, on a site whose notes are « Members only »: nothing ended.
    assert.equal(failureOf(answer(401, 'identity-required')), 'members-only');
    // A place cannot be gone on a 401: the worker did not get as far as the places.
    assert.equal(failureOf(answer(401, 'destination-not-allowed')), 'signed-out');
  });

  it('says a second try will not work on a 403, and on a note too large', () => {
    assert.equal(failureOf(answer(403, 'origin-not-allowed')), 'refused');
    assert.equal(failureOf(answer(403)), 'refused');
    assert.equal(failureOf(answer(413, 'too-large')), 'too-large');
  });

  it('leaves a place that is gone to a second try, which the read after it makes right (FRU-123)', () => {
    assert.equal(failureOf(answer(403, 'destination-not-allowed')), 'retry');
  });
});

/**
 * Sending the notes kept for later (FRU-124). The worker half is on main (#171): it answers each
 * note of a batch, and protects a kept one against a second copy for ten minutes only.
 */
describe('sending the drafts', () => {
  const ENDPOINT = 'https://worker.test';
  const draftOf = (id: string, destination?: string) => ({
    note: noteFixture({ id, client: { id: 'acme' } }),
    ...(destination === undefined ? {} : { destination }),
  });

  function transportAnswering(...answers: ((request: TransportRequest) => TransportResponse)[]) {
    const requests: TransportRequest[] = [];
    const transport = async (request: TransportRequest): Promise<TransportResponse> => {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error('one request more than the test planned');

      return next(request);
    };

    return { requests, options: { endpoint: ENDPOINT, clientId: 'acme', transport } };
  }

  const results =
    (status: number, kept: string[], refused: string[] = []) =>
    (): TransportResponse => ({
      ok: status < 300,
      status,
      body: JSON.stringify({
        results: [
          ...kept.map((id) => ({ id, issue: { id: `i_${id}`, identifier: `DEV-${id}` } })),
          ...refused.map((id) => ({ id, error: 'store-unavailable' })),
        ],
      }),
    });

  it('sends one array for a batch, and says every note was kept', async () => {
    const { requests, options } = transportAnswering(results(201, ['sd_a', 'sd_b']));

    const outcome = await sendDrafts({
      drafts: [draftOf('sd_a'), draftOf('sd_b')],
      offer: { max: 10, maxBytes: 65_536 },
      options,
    });

    assert.deepEqual(outcome, { kept: ['sd_a', 'sd_b'] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, `${ENDPOINT}/feedback`);
    const body = JSON.parse(requests[0]?.body ?? '') as unknown[];
    assert.deepEqual(
      body.map((note) => (parseNote(note).ok ? (note as { id: string }).id : 'not a note')),
      ['sd_a', 'sd_b'],
    );
  });

  it('after a 207 keeps only the notes answered « not kept », and sends only those again', async () => {
    const { requests, options } = transportAnswering(results(207, ['sd_a'], ['sd_b']), results(201, ['sd_b']));
    const drafts = [draftOf('sd_a'), draftOf('sd_b')];
    const offer = { max: 10, maxBytes: 65_536 };

    const first = await sendDrafts({ drafts, offer, options });
    assert.deepEqual(first, { kept: ['sd_a'], failure: 'retry' });

    const second = await sendDrafts({
      drafts: drafts.filter((each) => !first.kept.includes(each.note.id)),
      offer,
      options,
    });
    assert.deepEqual(second, { kept: ['sd_b'] });
    assert.deepEqual(
      (JSON.parse(requests[1]?.body ?? '') as { id: string }[]).map((note) => note.id),
      ['sd_b'],
      'the second attempt sent a note that was already kept',
    );
  });

  it('takes a 201 at its word when its body says nothing the widget can read', async () => {
    // The worker holds the notes. Left in the drafts, the next click would plant them a second time.
    for (const body of ['', '{}', '{"results":"all"}', '{"results":[{"id":"sd_other","issue":{}}]}']) {
      const { options } = transportAnswering(() => ({ ok: true, status: 201, body }));

      assert.deepEqual(
        await sendDrafts({ drafts: [draftOf('sd_a'), draftOf('sd_b')], offer: { max: 10, maxBytes: 65_536 }, options }),
        { kept: ['sd_a', 'sd_b'] },
        body,
      );
    }
  });

  it('keeps every note of a batch the worker answers 502, its answer for each note included', async () => {
    // The worker answers `502` when it kept none, with one result for each note.
    const { options } = transportAnswering(results(502, [], ['sd_a', 'sd_b']));

    assert.deepEqual(
      await sendDrafts({ drafts: [draftOf('sd_a'), draftOf('sd_b')], offer: { max: 10, maxBytes: 65_536 }, options }),
      { kept: [], failure: 'retry' },
    );
  });

  it('keeps a note that a 207 does not name, and takes out only the ones it answers « kept »', async () => {
    const { options } = transportAnswering(() => ({ ok: true, status: 207, body: '{"results":[]}' }));

    assert.deepEqual(await sendDrafts({ drafts: [draftOf('sd_a')], offer: { max: 10, maxBytes: 65_536 }, options }), {
      kept: [],
      failure: 'retry',
    });
  });

  it('stops at a request the worker refuses, and keeps every note it did not answer', async () => {
    const { requests, options } = transportAnswering(results(201, ['sd_a', 'sd_b']), () => ({
      ok: false,
      status: 429,
      body: '{"error":"rate-limited"}',
    }));

    const outcome = await sendDrafts({
      drafts: ['sd_a', 'sd_b', 'sd_c', 'sd_d', 'sd_e'].map((id) => draftOf(id)),
      offer: { max: 2, maxBytes: 65_536 },
      options,
    });

    assert.deepEqual(outcome, { kept: ['sd_a', 'sd_b'], failure: 'wait' });
    assert.equal(requests.length, 2, 'a request was sent after a 429');
  });

  it('sends a note and not an array to a worker that offers no batch, and the place in the query', async () => {
    const { requests, options } = transportAnswering(
      () => ({ ok: true, status: 201, body: '{}' }),
      () => ({ ok: false, status: 502, body: '{"error":"store-unavailable"}' }),
    );

    const outcome = await sendDrafts({
      drafts: [draftOf('sd_a', 'dst_design'), draftOf('sd_b')],
      offer: undefined,
      options,
    });

    assert.deepEqual(outcome, { kept: ['sd_a'], failure: 'retry' });
    assert.equal(requests[0]?.url, `${ENDPOINT}/feedback?destination=dst_design`);
    assert.equal(parseNote(JSON.parse(requests[0]?.body ?? '')).ok, true, 'the body of a single note is not a note');
  });

  it('keeps every note when the worker cannot be reached', async () => {
    const { options } = transportAnswering(() => {
      throw new Error('offline');
    });

    assert.deepEqual(await sendDrafts({ drafts: [draftOf('sd_a')], offer: { max: 10, maxBytes: 65_536 }, options }), {
      kept: [],
      failure: 'retry',
    });
  });
});

describe('a link that opens a note on its page (FRU-253)', () => {
  const PAGE_URL = 'https://preview.acme.test/pricing';

  function linked(hash: string, answers: (() => TransportResponse)[]) {
    const page = mountPage('<main><button data-testid="checkout-cta">Commander</button></main>', {
      url: `${PAGE_URL}${hash}`,
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    mock.method(globalThis, 'fetch', () => {
      throw new Error('this test goes through the transport');
    });
    let reads = 0;
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      locale: 'en',
      transport: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)] as () => TransportResponse;
        reads += 1;

        return answer();
      },
    });
    const shadow = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    const thread = () => shadow.querySelector('[data-fruitback-thread]');

    return { page, widget, shadow, thread, reads: () => reads };
  }

  const note = (overrides: Parameters<typeof noteIssueFixture>[0] = {}) =>
    noteIssueFixture({
      id: 'issue_linked',
      identifier: 'ACM-142',
      note: noteFixture({
        id: 'sd_linked',
        text: 'The linked note',
        anchor: {
          selector: '[data-testid="checkout-cta"]',
          tag: 'button',
          text: 'Commander',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
      ...overrides,
    });
  const answering = (issues: unknown[]) => (): TransportResponse => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ issues }),
  });

  it('opens the thread of the note once the notes are read, and takes its part out of the address', async () => {
    const { page, widget, thread, reads } = linked('#fruitback-note=sd_linked', [answering([note()])]);
    // Not before the read: the notes are not in hand, and nothing says the reader may see them.
    assert.equal(thread() === null, true);

    await widget.refresh();

    assert.match(thread()?.textContent ?? '', /The linked note/);
    assert.equal(page.view.location.href, PAGE_URL);
    // Taking the fragment out is our own edit of the address: it asks for no read, which would
    // draw the pins again and close the thread that just opened.
    const before = reads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads(), before);
    assert.equal(thread() !== null, true);

    widget.destroy();
  });

  it('keeps the fragment of the site, before and after its own part', async () => {
    const { page, widget, thread } = linked('#pricing&fruitback-note=sd_linked&tab=2', [answering([note()])]);

    await widget.refresh();

    assert.equal(thread() !== null, true);
    assert.equal(page.view.location.hash, '#pricing&tab=2');

    widget.destroy();
  });

  it('neither reads nor erases a fragment that is the site’s: the control', async () => {
    const { page, widget, thread } = linked('#pricing', [answering([note()])]);

    await widget.refresh();

    assert.equal(thread() === null, true);
    assert.equal(page.view.location.hash, '#pricing');

    widget.destroy();
  });

  it('opens the list on « Could not be placed » for a note whose element is gone, and its thread', async () => {
    const gone = note({
      note: noteFixture({
        id: 'sd_linked',
        text: 'The linked note',
        anchor: { selector: '#gone', tag: 'input', text: 'Gone', bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 } },
      }),
    });
    const { widget, shadow, thread } = linked('#fruitback-note=sd_linked', [answering([gone])]);

    await widget.refresh();

    const list = shadow.querySelector('[data-fruitback-sidebar]') as HTMLElement;
    assert.equal(list.hidden, false, 'the list did not open');
    const unplaced = list.querySelector('[data-fruitback-unplaced]') as HTMLElement;
    assert.equal(unplaced.hidden, false);
    assert.match(unplaced.textContent ?? '', /The linked note/);
    assert.equal(thread() !== null, true);

    widget.destroy();
  });

  it('leaves the list closed for a note that is on its element: the control', async () => {
    const { widget, shadow, thread } = linked('#fruitback-note=sd_linked', [answering([note()])]);

    await widget.refresh();

    assert.equal((shadow.querySelector('[data-fruitback-sidebar]') as HTMLElement).hidden, true);
    assert.equal(thread() !== null, true);

    widget.destroy();
  });

  it('finds the note by its id, by the id of its issue, or by its identifier', async () => {
    for (const id of ['sd_linked', 'issue_linked', 'ACM-142']) {
      const { widget, thread } = linked(`#fruitback-note=${encodeURIComponent(id)}`, [answering([note()])]);
      await widget.refresh();

      assert.equal(thread() !== null, true, `${id} opened nothing`);
      widget.destroy();
    }
  });

  it('opens nothing for a note this page does not have, says nothing, and still clears the address', async () => {
    const errors = mock.method(console, 'error', () => {});
    const warnings = mock.method(console, 'warn', () => {});
    const { page, widget, thread } = linked('#fruitback-note=sd_elsewhere', [answering([note()])]);

    await widget.refresh();

    assert.equal(thread() === null, true);
    assert.equal(page.view.location.href, PAGE_URL);
    assert.equal(errors.mock.callCount() + warnings.mock.callCount(), 0);

    widget.destroy();
  });

  it('opens nothing when the worker refuses the read, and opens the note once a read answers', async () => {
    const { page, widget, thread } = linked('#fruitback-note=sd_linked', [
      () => ({ ok: false, status: 401, body: '{"error":"unauthorized"}' }),
      answering([note()]),
    ]);

    await widget.refresh();
    // Refused: nothing is shown to somebody the worker does not answer, and the link waits.
    assert.equal(thread() === null, true);
    assert.equal(page.view.location.hash, '#fruitback-note=sd_linked');

    await widget.refresh();
    assert.equal(thread() !== null, true);
    assert.equal(page.view.location.hash, '');

    widget.destroy();
  });

  it('keeps a link that waited for a note through a read that fails, and opens it at the read that answers', async () => {
    // The composer closes while the page has no read that answered: the link is not followed then,
    // and it is not lost. Each read that answers looks at the address again.
    let answers = false;
    const { page, widget, shadow, thread } = linked('#fruitback-note=sd_linked', [
      () => (answers ? answering([note()])() : { ok: false, status: 503, body: '{"error":"store-unavailable"}' }),
    ]);
    const composer = shadow.querySelector('[data-fruitback-composer]') as HTMLElement;
    composer.hidden = false;
    await widget.refresh();
    composer.hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thread() === null, true);
    assert.equal(page.view.location.hash, '#fruitback-note=sd_linked');

    await widget.refresh();
    assert.equal(thread() === null, true, 'a read that failed opened a note');
    answers = true;
    await widget.refresh();
    assert.equal(thread() !== null, true);
    assert.equal(page.view.location.hash, '');

    widget.destroy();
  });

  it('follows a fragment that arrives later, with no read and no second mount', async () => {
    const { page, widget, shadow, thread, reads } = linked('', [answering([note()])]);
    await widget.refresh();
    const host = page.document.querySelector('[data-fruitback-host]');
    const before = reads();

    page.view.location.hash = '#fruitback-note=sd_linked';
    page.view.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('hashchange'));

    assert.equal(thread() !== null, true);
    assert.equal(page.view.location.hash, '');
    assert.equal(reads(), before, 'the notes were in hand: a read would only close the thread');
    assert.ok(page.document.querySelector('[data-fruitback-host]') === host, 'the widget was mounted again');
    // Focus is in the thread, as after a click on the pin.
    assert.ok(shadow.activeElement?.classList.contains('fruitback-thread-close'), 'focus is not in the thread');

    widget.destroy();
  });

  it('takes nothing from somebody who writes: an open composer stays, with its text, and the link waits', async () => {
    const { page, widget, shadow, thread } = linked('', [answering([note()])]);
    await widget.refresh();
    // The composer as it is while somebody writes in it.
    const composer = shadow.querySelector('[data-fruitback-composer]') as HTMLElement;
    const field = composer.querySelector('textarea') as HTMLTextAreaElement;
    composer.hidden = false;
    field.value = 'Half a note';
    field.focus();

    page.view.location.hash = '#fruitback-note=sd_linked';
    page.view.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('hashchange'));

    assert.equal(composer.hidden, false, 'the link closed the composer');
    assert.equal(field.value, 'Half a note');
    assert.ok(shadow.activeElement === field, 'the link took focus from the note');
    assert.equal(thread() === null, true);
    // Not lost: the note opens when the composer closes, sent or given up.
    assert.equal(page.view.location.hash, '#fruitback-note=sd_linked');
    composer.hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thread() !== null, true);
    assert.equal(page.view.location.hash, '');

    widget.destroy();
  });
});

describe('a read that fails, seen on the page (FRU-316)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('puts the dot on the button of the list, reads again when the network is back, and takes the dot off', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    let online = false;
    let reads = 0;
    mock.method(globalThis, 'fetch', async () => {
      reads += 1;
      if (!online) throw new TypeError('Failed to fetch');

      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    });
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });
    const root = (page.document.querySelector('[data-fruitback-host]') as HTMLElement).shadowRoot as ShadowRoot;
    const dot = () => root.querySelector('.fruitback-listing-alert') as HTMLElement;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await settle();
      await settle();
      assert.equal(dot().hidden, false, 'a failed first read left no sign on the page');
      assert.equal(
        root.querySelector('[data-fruitback-announcer]')?.textContent,
        'The notes of this page could not be read. They are not lost.',
      );

      online = true;
      const before = reads;
      page.view.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('online'));
      await settle();
      await settle();
      assert.equal(reads, before + 1, 'the network came back and nothing read again');
      assert.equal(dot().hidden, true);
    } finally {
      widget.destroy();
    }
  });
});

describe('a session of the host that ends, and comes back (FRU-315)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function reads(): number[] {
    const seen: number[] = [];
    mock.method(globalThis, 'fetch', async () => {
      seen.push(1);

      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    });

    return seen;
  }

  const launchOf = (page: MountedPage) =>
    (page.document.querySelector('[data-fruitback-host]') as HTMLElement).shadowRoot?.querySelector(
      '[data-fruitback-host-launch]',
    ) as HTMLButtonElement;

  it('turns the launch button and « Leave feedback » into the sign-in, then reads again once back', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const seen = reads();
    const asked: number[] = [];
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      onSignIn: () => asked.push(1),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const readsBefore = seen.length;

      widget.signedOut(true);
      assert.equal(launchOf(page).textContent, 'Sign in to leave notes');
      launchOf(page).click();
      // The command of the popup and of the key leads there too.
      assert.equal(widget.leaveFeedback(), true);
      assert.deepEqual(asked, [1, 1]);

      widget.signedOut(false);
      assert.equal(launchOf(page).textContent, 'Leave feedback');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(seen.length, readsBefore + 1, 'back, the widget did not read the page again');
    } finally {
      widget.destroy();
    }
  });

  it('does nothing for a host that offers no sign-in', () => {
    const page = mountPage('<main></main>');
    reads();
    const widget = init({ document: page.document, endpoint: 'https://worker.test', clientId: 'acme' });
    try {
      widget.signedOut(true);
      assert.equal(launchOf(page).textContent, 'Leave feedback');
    } finally {
      widget.destroy();
    }
  });
});
