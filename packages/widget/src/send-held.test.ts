import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Composer, createComposer } from './composer.ts';
import { plant } from './embed.ts';
import type { TransportResponse } from './transport.ts';
import { mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * A note the worker keeps for a member to approve (FRU-704): « Hold new visitor notes » of the site.
 * The worker answers `202` with `held: true`. The card says the note was sent for review, and promises
 * no pin: there is none until a member approves it.
 */

const ENDPOINT = 'https://worker.test';
const NOTE = 'Le bouton ne répond pas';

let composer: Composer | null = null;
afterEach(() => {
  composer?.destroy();
  composer = null;
});

async function sendAnswered(answer: TransportResponse, locale = 'en-US') {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
  const host = page.document.createElement('div');
  page.document.body.append(host);
  composer = createComposer({
    document: page.document,
    host,
    translator: createTranslator({ locale }),
    onSubmit: async (note, reporter) =>
      plant({
        note,
        target: { element: page.query('button'), source: undefined },
        reporter,
        config: { hiddenStages: [], screenshot: false },
        options: { endpoint: ENDPOINT, clientId: 'acme', transport: async () => answer },
      }),
  });
  composer.open({ left: 100, top: 200, bottom: 240, right: 300 });
  (composer.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement).value = NOTE;
  (composer.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const read = (selector: string) => composer?.element.querySelector(selector)?.textContent ?? '';

  return {
    state: composer.state(),
    title: read('[data-fruitback-sent-title]'),
    text: read('[data-fruitback-sent-text]'),
  };
}

describe('a note kept for a member to approve (FRU-704)', () => {
  const held: TransportResponse = { ok: true, status: 202, body: JSON.stringify({ held: true, id: 'n1' }) };

  it('says it was sent for review, and promises no pin', async () => {
    const shown = await sendAnswered(held);

    assert.equal(shown.state, 'sent');
    assert.equal(shown.title, 'Sent for review');
    assert.equal(
      shown.text,
      'The team of this site reviews notes before they go on. Its pin shows here once approved.',
    );
    assert.doesNotMatch(shown.text, /stays here/);
  });

  it('says it in French', async () => {
    const shown = await sendAnswered(held, 'fr-FR');

    assert.equal(shown.title, 'Envoyée pour relecture');
  });

  it('still says the pin stays on a note that went at once', async () => {
    const shown = await sendAnswered({ ok: true, status: 201, body: JSON.stringify({ issue: { id: 'i1' } }) });

    assert.equal(shown.title, 'Sent');
    assert.equal(shown.text, 'The pin stays here and follows the issue’s status.');
  });
});
