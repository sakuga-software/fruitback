import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Composer, createComposer } from './composer.ts';
import { init, plant } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * A send or a read refused for who the reader is, not for the network (FRU-394).
 *
 * Measured in production: on a site whose notes are « Members only », a page with no session sent a
 * note, the worker answered `401`, and the composer said « try again ». No second try passes: the
 * reader signs in from the extension, or is not a member. The bodies below are the ones the worker
 * answers (`attributionFor`).
 */

const ENDPOINT = 'https://worker.test';
const NOTE = 'Le prix ne correspond pas à la page panier';

let composer: Composer | null = null;
const cleanup: (() => void)[] = [];
afterEach(() => {
  composer?.destroy();
  composer = null;
  for (const undo of cleanup.splice(0)) undo();
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

/** A composer whose send goes through `plant`, to a worker that answers `answer`. */
async function sendThrough(answer: () => Promise<TransportResponse>, locale = 'en-US'): Promise<string> {
  const page = mounted();
  const host = page.document.createElement('div');
  page.document.body.append(host);
  composer = createComposer({
    document: page.document,
    host,
    translator: createTranslator({ locale }),
    onSubmit: (note, reporter) =>
      plant({
        note,
        target: { element: page.query('button'), source: undefined },
        reporter,
        config: { hiddenStages: [], screenshot: false },
        options: { endpoint: ENDPOINT, clientId: 'acme', transport: answer },
      }),
  });
  composer.open({ left: 100, top: 200, bottom: 240, right: 300 });
  const field = composer.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
  field.value = NOTE;
  (composer.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(composer.state(), 'failed');
  // No way out of a failure empties the field.
  assert.equal(field.value, NOTE);

  return composer.element.querySelector('[data-fruitback-failed-text]')?.textContent ?? '';
}

const answering = (status: number, body: string) => async (): Promise<TransportResponse> => ({
  ok: false,
  status,
  body,
});

describe('a send refused for who the reader is (FRU-394)', () => {
  it('says the site is for members, on the 401 of a members-only site with no session', async () => {
    const said = await sendThrough(
      answering(401, JSON.stringify({ error: 'identity-required', reason: 'identity-required' })),
    );

    assert.equal(
      said,
      'This site is for members only. Your text is kept: sign in to Fruitback from the extension, then send it again.',
    );
    assert.doesNotMatch(said, /try again/i);
  });

  it('says it in French', async () => {
    const said = await sendThrough(
      answering(401, JSON.stringify({ error: 'identity-required', reason: 'session-required' })),
      'fr-FR',
    );

    assert.equal(
      said,
      'Ce site est réservé aux membres. Le texte est gardé : connectez-vous à Fruitback depuis l’extension, puis envoyez à nouveau.',
    );
  });

  it('still says the session ended on the 401 of a token that was refused (FRU-193)', async () => {
    const said = await sendThrough(answering(401, JSON.stringify({ error: 'invalid-identity', reason: 'expired' })));

    assert.equal(said, 'Your session has ended. Your text is kept: sign in again, then send it.');
  });

  it('does not say to try again on a 403', async () => {
    const said = await sendThrough(answering(403, JSON.stringify({ error: 'origin-not-allowed' })));

    assert.equal(said, 'This site does not accept your note from here. Your text is kept: tell the team of the site.');
  });

  it('says to try again on a failure of the worker or of the network, and only there', async () => {
    assert.equal(
      await sendThrough(answering(503, JSON.stringify({ error: 'store-unavailable' }))),
      'Your text is kept. Try again, or copy it before closing the page.',
    );
    composer?.destroy();
    assert.equal(
      await sendThrough(() => Promise.reject(new TypeError('Failed to fetch'))),
      'Your text is kept. Try again, or copy it before closing the page.',
    );
  });
});

describe('a read refused for who the reader is (FRU-394)', () => {
  async function widgetReading(status: number, body: string, locale = 'en-US') {
    const requests: TransportRequest[] = [];
    const page = mounted();
    const widget = init({
      document: page.document,
      endpoint: ENDPOINT,
      clientId: 'acme',
      locale,
      transport: async (request) => {
        requests.push(request);

        return { ok: false, status, body };
      },
    });
    cleanup.push(() => widget.destroy());
    await widget.refresh();
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    widget.showEveryNote();

    return {
      widget,
      requests,
      list: () => root.querySelector('.fruitback-sidebar-failed-text')?.textContent ?? '',
      retry: () => root.querySelector('.fruitback-sidebar-retry') as HTMLButtonElement,
      announced: () => root.querySelector('[data-fruitback-announcer]')?.textContent ?? '',
    };
  }

  it('says the site is for members in the list and on the page, and offers no « Try again »', async () => {
    const { widget, list, retry, announced } = await widgetReading(
      401,
      JSON.stringify({ error: 'identity-required', reason: 'identity-required' }),
    );

    const sentence = 'This site is for members only. Sign in to Fruitback from the extension to see its notes.';
    assert.equal(list(), sentence);
    assert.equal(announced(), sentence);
    assert.equal(retry().hidden, true);
    // The side panel of the extension knows four states, and this is one of its failures.
    assert.equal(widget.notesState(), 'failed');
  });

  it('says it in French', async () => {
    const { list } = await widgetReading(401, JSON.stringify({ error: 'identity-required' }), 'fr-FR');

    assert.equal(
      list(),
      'Ce site est réservé aux membres. Connectez-vous à Fruitback depuis l’extension pour voir ses notes.',
    );
  });

  it('keeps « could not be read » and « Try again » for a worker that failed', async () => {
    const { list, retry } = await widgetReading(503, JSON.stringify({ error: 'store-unavailable' }));

    assert.equal(list(), 'The notes of this page could not be read. They are not lost.');
    assert.equal(retry().hidden, false);
  });
});
