import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Composer, createComposer, failureText } from './composer.ts';
import { failureOf, plant, sendDrafts } from './embed.ts';
import { type PlaceHelp, placeHelpOf } from './place-help.ts';
import type { TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';
import type { Draft } from './drafts.ts';
import { noteFixture } from '@fruitback/shared/note.fixture';

/**
 * A place of the site that the tracker no longer has (FRU-640).
 *
 * Measured in production on 2026-11-19: the project of a destination moved to another team of
 * Linear, and every note got `502 store-unavailable`, which the composer said as « try again ». The
 * bodies below are the ones of the worker of FRU-640.
 */

const ENDPOINT = 'https://worker.test';
const NOTE = 'Le prix ne correspond pas à la page panier';
const CONSOLE = 'https://app.fruitback.test/w/ws_1/sites/site_1';
const HELP = 'https://fruitback.com/note-not-sent';

const gone = (help: string, reader: 'member' | 'visitor'): string =>
  JSON.stringify({ error: 'destination-unavailable', help, for: reader });

const answering = (status: number, body: string) => async (): Promise<TransportResponse> => ({
  ok: false,
  status,
  body,
});

let composer: Composer | null = null;
afterEach(() => {
  composer?.destroy();
  composer = null;
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

/** A composer wired to `plant` as `embed.ts` wires it, to a worker that answers `body` with `status`. */
async function sendThrough(
  status: number,
  body: string,
  locale = 'en-US',
): Promise<{ text: string; link: HTMLAnchorElement }> {
  const page = mounted();
  const host = page.document.createElement('div');
  page.document.body.append(host);
  let help: PlaceHelp | undefined;
  composer = createComposer({
    document: page.document,
    host,
    translator: createTranslator({ locale }),
    placeHelp: () => help,
    onSubmit: (note, reporter) =>
      plant({
        note,
        target: { element: page.query('button'), source: undefined },
        reporter,
        config: { hiddenStages: [], screenshot: false },
        options: { endpoint: ENDPOINT, clientId: 'acme', transport: answering(status, body) },
        onPlaceHelp: (given) => (help = given),
      }),
  });
  composer.open({ left: 100, top: 200, bottom: 240, right: 300 });
  const field = composer.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
  field.value = NOTE;
  (composer.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(composer.state(), 'failed');
  assert.equal(field.value, NOTE, 'a failure emptied the field');

  return {
    text: composer.element.querySelector('[data-fruitback-failed-text]')?.textContent ?? '',
    link: composer.element.querySelector('[data-fruitback-failed-help]') as HTMLAnchorElement,
  };
}

describe('the help of a place that is gone (FRU-640)', () => {
  it('reads the address and who it is for', () => {
    assert.deepEqual(placeHelpOf(gone(CONSOLE, 'member')), { url: CONSOLE, for: 'member' });
    assert.deepEqual(placeHelpOf(gone(HELP, 'visitor')), { url: HELP, for: 'visitor' });
    assert.deepEqual(placeHelpOf(JSON.stringify({ error: 'destination-unavailable', help: HELP })), {
      url: HELP,
      for: 'visitor',
    });
  });

  it('takes http on a local host only, and no other scheme', () => {
    assert.equal(placeHelpOf(gone('http://localhost:5178/w/ws_1/sites/site_1', 'member'))?.for, 'member');
    for (const address of [
      'http://app.fruitback.test/w/ws_1',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'https://user:secret@app.fruitback.test/',
      '/w/ws_1/sites/site_1',
      'not an address',
    ]) {
      assert.equal(placeHelpOf(gone(address, 'member')), undefined, address);
    }
  });

  it('reads nothing from another error, or from a body that is not JSON', () => {
    assert.equal(placeHelpOf(JSON.stringify({ error: 'store-unavailable', help: HELP })), undefined);
    assert.equal(placeHelpOf('<html>Bad Gateway</html>'), undefined);
    assert.equal(placeHelpOf('null'), undefined);
  });
});

describe('failureOf, for a place that is gone (FRU-640)', () => {
  it('is place-gone for the 502 of a place that is gone', () => {
    assert.equal(failureOf({ status: 502, body: gone(HELP, 'visitor') }), 'place-gone');
  });

  it('stays retry for any other 502, as before', () => {
    assert.equal(failureOf({ status: 502, body: JSON.stringify({ error: 'store-unavailable' }) }), 'retry');
    assert.equal(failureOf({ status: 502, body: 'Bad Gateway' }), 'retry');
  });
});

describe('the composer, for a place that is gone (FRU-640)', () => {
  it('sends a member to the page of the site in the console, in a new tab', async () => {
    const { text, link } = await sendThrough(502, gone(CONSOLE, 'member'));

    assert.match(text, /no longer exists in the tracker/u);
    assert.equal(link.hidden, false);
    assert.equal(link.href, CONSOLE);
    assert.equal(link.textContent, 'Fix it in the console');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noreferrer noopener');
  });

  it('sends a visitor to the page of help, with words that ask nothing of the tracker', async () => {
    const { text, link } = await sendThrough(502, gone(HELP, 'visitor'));

    assert.match(text, /could not reach the team/u);
    assert.doesNotMatch(text, /tracker|console/u);
    assert.equal(link.hidden, false);
    assert.equal(link.href, HELP);
    assert.equal(link.textContent, 'What to do');
  });

  it('shows no link for an address it does not open', async () => {
    const { text, link } = await sendThrough(502, gone('javascript:alert(1)', 'member'));

    assert.match(text, /could not reach the team/u);
    assert.equal(link.hidden, true);
    assert.equal(link.getAttribute('href'), null);
  });

  it('shows no link for a failure of another cause', async () => {
    const { link } = await sendThrough(502, JSON.stringify({ error: 'store-unavailable', help: HELP }));

    assert.equal(link.hidden, true);
  });

  it('says it in French', async () => {
    const { text, link } = await sendThrough(502, gone(CONSOLE, 'member'), 'fr-FR');

    assert.match(text, /n’existe plus/u);
    assert.equal(link.textContent, 'Corriger dans la console');
  });
});

describe('the notes kept for later, for a place that is gone (FRU-640)', () => {
  const draftOf = (id: string): Draft => ({ note: noteFixture({ id }) });

  it('tells the help of a single note, and keeps the draft', async () => {
    let told: PlaceHelp | undefined;
    const outcome = await sendDrafts({
      drafts: [draftOf('sd_a')],
      offer: undefined,
      options: { endpoint: ENDPOINT, clientId: 'acme', transport: answering(502, gone(HELP, 'visitor')) },
      onPlaceHelp: (help) => (told = help),
    });

    assert.deepEqual(outcome.kept, []);
    assert.equal(outcome.failure, 'place-gone');
    assert.deepEqual(told, { url: HELP, for: 'visitor' });
  });

  it('tells the help of a batch', async () => {
    let told: PlaceHelp | undefined;
    const outcome = await sendDrafts({
      drafts: [draftOf('sd_a'), draftOf('sd_b')],
      offer: { max: 10, maxBytes: 65_536 },
      options: { endpoint: ENDPOINT, clientId: 'acme', transport: answering(502, gone(CONSOLE, 'member')) },
      onPlaceHelp: (help) => (told = help),
    });

    assert.deepEqual(outcome.kept, []);
    assert.equal(outcome.failure, 'place-gone');
    assert.deepEqual(told, { url: CONSOLE, for: 'member' });
  });

  it('says the sentence of the reader in the list', () => {
    const t = createTranslator({ locale: 'en-US' });

    assert.match(failureText(t, 'place-gone', { url: CONSOLE, for: 'member' }), /no longer exists/u);
    assert.match(failureText(t, 'place-gone', { url: HELP, for: 'visitor' }), /could not reach the team/u);
    assert.match(failureText(t, 'place-gone'), /could not reach the team/u);
  });
});
