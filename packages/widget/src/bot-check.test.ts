import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TURNSTILE_HEADER, TURNSTILE_SCRIPT, loadTurnstile, solveTurnstile } from './bot-check.ts';
import { type Composer, createComposer } from './composer.ts';
import { plant } from './embed.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';

/**
 * « Bot check » (FRU-704). The worker answers a note of a visitor with `403 bot-check` and the site key
 * of its instance; the composer draws Cloudflare Turnstile, keeps the text, and sends the same note
 * again with the token. **No case loads the script of Cloudflare**: happy-dom loads no script, and a
 * case that needs Turnstile puts a fake `turnstile` on the window, as `e2e/public-guards.spec.ts`
 * serves a fake `api.js`.
 */

const ENDPOINT = 'https://worker.test';
const NOTE = 'The price is wrong on the cart page.';
const SITE_KEY = '1x00000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const ASKED = { ok: false, status: 403, body: JSON.stringify({ error: 'bot-check', siteKey: SITE_KEY }) };
const SENT = { ok: true, status: 201, body: JSON.stringify({ issue: { id: '1', identifier: 'FB-1' } }) };

let composer: Composer | null = null;
afterEach(() => {
  composer?.destroy();
  composer = null;
});

function mounted(): MountedPage {
  const page = mountPage('<main><button>Order</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

/** A worker that answers each call with the next of `answers`, and keeps what it was asked. */
function worker(...answers: TransportResponse[]) {
  const calls: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    calls.push(request);

    return answers.shift() ?? SENT;
  };

  return { calls, transport };
}

/** A fake of Cloudflare's `window.turnstile`: it draws a box, and answers as `answer` says. */
function fakeTurnstile(view: Window, answer: 'token' | 'error' | 'never') {
  const drawn: { siteKey: string; slot: HTMLElement }[] = [];
  const removed: string[] = [];
  (view as Window & { turnstile?: unknown }).turnstile = {
    render(slot: HTMLElement, options: { sitekey: string; callback(token: string): void; 'error-callback'(): void }) {
      drawn.push({ siteKey: options.sitekey, slot });
      const box = slot.ownerDocument.createElement('div');
      box.dataset.fakeTurnstile = '';
      slot.append(box);
      if (answer === 'token') queueMicrotask(() => options.callback(TOKEN));
      if (answer === 'error') queueMicrotask(() => options['error-callback']());

      return 'widget_1';
    },
    remove(widget: string) {
      removed.push(widget);
    },
  };

  return { drawn, removed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a note the worker asks a bot check for (FRU-704)', () => {
  it('sends the same note again with the token the check gave', async () => {
    const page = mounted();
    const { calls, transport } = worker(ASKED, SENT);
    const asked: string[] = [];

    const sent = await plant({
      note: NOTE,
      target: { element: page.query('button'), source: undefined },
      reporter: undefined,
      config: { hiddenStages: [], screenshot: false },
      options: { endpoint: ENDPOINT, clientId: 'acme', transport },
      botCheck: async (siteKey) => {
        asked.push(siteKey);

        return { token: TOKEN };
      },
    });

    assert.equal(sent, true);
    assert.deepEqual(asked, [SITE_KEY]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers[TURNSTILE_HEADER], undefined);
    assert.equal(calls[1]?.headers[TURNSTILE_HEADER], TOKEN);
    // The same note, with the same id: the worker keeps it once.
    assert.equal(calls[1]?.body, calls[0]?.body);
    assert.equal(calls[1]?.url, calls[0]?.url);
  });

  it('says why when the check fails, does not load, or is asked again, and draws it once', async () => {
    const page = mounted();
    const send = async (outcome: 'failed' | 'unavailable' | 'token' | 'none', ...answers: TransportResponse[]) => {
      const { calls, transport } = worker(...answers);
      let drawn = 0;
      const result = await plant({
        note: NOTE,
        target: { element: page.query('button'), source: undefined },
        reporter: undefined,
        config: { hiddenStages: [], screenshot: false },
        options: { endpoint: ENDPOINT, clientId: 'acme', transport },
        ...(outcome === 'none'
          ? {}
          : {
              botCheck: async () => {
                drawn += 1;

                return outcome === 'token' ? { token: TOKEN } : outcome;
              },
            }),
      });

      return { result, calls: calls.length, drawn };
    };

    assert.deepEqual(await send('failed', ASKED), { result: 'bot-check', calls: 1, drawn: 1 });
    assert.deepEqual(await send('unavailable', ASKED), { result: 'bot-check-unavailable', calls: 1, drawn: 1 });
    // A host with no way to draw it: said, never sent as is.
    assert.deepEqual(await send('none', ASKED), { result: 'bot-check', calls: 1, drawn: 0 });
    // A token the worker refuses: said, and not drawn a second time.
    assert.deepEqual(await send('token', ASKED, ASKED), { result: 'bot-check', calls: 2, drawn: 1 });
    // Any other 403 is no check.
    assert.deepEqual(
      await send('token', { ok: false, status: 403, body: JSON.stringify({ error: 'origin-not-allowed' }) }),
      { result: 'refused', calls: 1, drawn: 0 },
    );
  });
});

describe('« Bot check » in the composer (FRU-704)', () => {
  /** A composer whose send goes through `plant`, to `transport`, with the check drawn by `solveTurnstile`. */
  function composerOn(
    page: MountedPage,
    transport: (request: TransportRequest) => Promise<TransportResponse>,
    locale = 'en-US',
  ) {
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const made = createComposer({
      document: page.document,
      host,
      translator: createTranslator({ locale }),
      onSubmit: (note, reporter) =>
        plant({
          note,
          target: { element: page.query('button'), source: undefined },
          reporter,
          config: { hiddenStages: [], screenshot: false },
          options: { endpoint: ENDPOINT, clientId: 'acme', transport },
          botCheck: (siteKey) =>
            made.challenge((slot, signal) => solveTurnstile(slot, siteKey, { signal }), 'failed' as const),
        }),
    });
    composer = made;
    made.open({ left: 100, top: 200, bottom: 240, right: 300 });
    const field = made.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
    field.value = NOTE;

    return {
      made,
      field,
      send: () => (made.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click(),
      box: () => made.element.querySelector('[data-fruitback-challenge]') as HTMLElement,
      said: () => made.element.querySelector('[data-fruitback-failed-text]')?.textContent ?? '',
    };
  }

  it('draws the check in the composer with the site key, then sends, and takes the check out', async () => {
    const page = mounted();
    const turnstile = fakeTurnstile(page.view, 'token');
    const { calls, transport } = worker(ASKED, SENT);
    const { made, send, box } = composerOn(page, transport);

    send();
    await settle();

    assert.equal(made.state(), 'sent');
    assert.equal(turnstile.drawn.length, 1);
    assert.equal(turnstile.drawn[0]?.siteKey, SITE_KEY);
    // Drawn inside the composer, in its own part.
    assert.equal(made.element.contains(turnstile.drawn[0]?.slot ?? null), true);
    assert.deepEqual(turnstile.removed, ['widget_1']);
    assert.equal(box().hidden, true);
    assert.equal(calls[1]?.headers[TURNSTILE_HEADER], TOKEN);
  });

  it('shows the line of the check while it waits, and keeps the text when it fails, in English and in French', async () => {
    for (const [locale, line, failed] of [
      [
        'en-US',
        'This site checks that a person sends this note. Your note goes once the check passes.',
        'The check that a person sends this note did not pass. Your text is still here. Try again.',
      ],
      [
        'fr-FR',
        'Ce site vérifie qu’une personne envoie cette note. Votre note part dès que la vérification passe.',
        'La vérification qu’une personne envoie cette note n’a pas réussi. Votre texte est toujours là. Réessayez.',
      ],
    ] as const) {
      const page = mounted();
      fakeTurnstile(page.view, 'never');
      const { made, field, send, box } = composerOn(page, worker(ASKED).transport, locale);
      send();
      await settle();

      assert.equal(box().hidden, false);
      assert.equal(made.element.querySelector('[data-fruitback-challenge-text]')?.textContent, line);
      assert.equal(made.element.querySelector('[data-fake-turnstile]') !== null, true);
      assert.equal(field.value, NOTE);
      made.destroy();
      composer = null;

      const failing = mounted();
      fakeTurnstile(failing.view, 'error');
      const again = composerOn(failing, worker(ASKED).transport, locale);
      again.send();
      await settle();
      assert.equal(again.made.state(), 'failed');
      assert.equal(again.said(), failed);
      assert.equal(again.field.value, NOTE);
      assert.equal(again.box().hidden, true);
      again.made.destroy();
      composer = null;
    }
  });

  it('says the check did not load when Cloudflare cannot be reached, and keeps the text', async () => {
    // happy-dom loads no script: the script of Turnstile fails as a page that blocks it.
    const page = mounted();
    const { made, field, send, said } = composerOn(page, worker(ASKED).transport);

    send();
    await settle();

    assert.equal(made.state(), 'failed');
    assert.equal(
      said(),
      'The check that a person sends this note did not load. Your text is still here. Try again, or tell the site’s team.',
    );
    assert.equal(field.value, NOTE);
  });

  it('takes the check out when the composer closes under it, and says nothing after', async () => {
    const page = mounted();
    const turnstile = fakeTurnstile(page.view, 'never');
    const { calls, transport } = worker(ASKED, SENT);
    const { made, send } = composerOn(page, transport);

    send();
    await settle();
    made.close();
    await settle();

    assert.deepEqual(turnstile.removed, ['widget_1']);
    assert.equal(made.state(), 'idle');
    assert.equal(calls.length, 1);
  });
});

describe('the script of Turnstile (FRU-704)', () => {
  it('loads it from the address of the host, takes a load that failed out, and tries again at the next check', async () => {
    const page = mounted();
    const appended: string[] = [];
    const { MutationObserver: Observer } = page.view as unknown as { MutationObserver: typeof MutationObserver };
    new Observer((records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          if ((node as Element).localName === 'script') appended.push((node as HTMLScriptElement).src);
      }
    }).observe(page.document.head, { childList: true });

    assert.equal(await loadTurnstile(page.document, 'https://turnstile.invalid/api.js?render=explicit'), undefined);
    assert.equal(await loadTurnstile(page.document, 'https://turnstile.invalid/api.js?render=explicit'), undefined);
    await settle();

    assert.deepEqual(appended, [
      'https://turnstile.invalid/api.js?render=explicit',
      'https://turnstile.invalid/api.js?render=explicit',
    ]);
    assert.equal(page.document.querySelectorAll('script[data-fruitback-turnstile]').length, 0);
    assert.match(TURNSTILE_SCRIPT, /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/);
  });

  it('answers the API a page has already, with no script', async () => {
    const page = mounted();
    fakeTurnstile(page.view, 'token');

    assert.notEqual(await loadTurnstile(page.document), undefined);
    assert.equal(page.document.querySelectorAll('script').length, 0);
  });
});
