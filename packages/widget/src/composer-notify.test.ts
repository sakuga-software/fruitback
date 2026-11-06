import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Composer, type NotifyOffer, type NotifyOutcome, createComposer } from './composer.ts';
import { deepActiveElement } from './focus.ts';
import { mountPage } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * « Want to know when it's fixed? » under the card of a note sent (FRU-604). The composer asks only
 * when the host hands it a question, stays open until the person answers, and keeps the address in
 * its field when it did not go.
 */

const ANCHOR = { left: 100, top: 200, bottom: 240, right: 300 };
let composer: Composer | null = null;

afterEach(() => {
  composer?.destroy();
  composer = null;
});

function offer(outcomes: NotifyOutcome[]): NotifyOffer & { sent: string[]; declined: number } {
  const sent: string[] = [];
  const state = {
    sent,
    declined: 0,
    async send(email: string) {
      sent.push(email);

      return outcomes.shift() ?? 'sent';
    },
    decline() {
      state.declined += 1;
    },
  };

  return state;
}

async function sentWith(notify: NotifyOffer | undefined, language = 'en') {
  const page = mountPage('<main></main>');
  const host = page.document.createElement('div');
  page.document.body.append(host);
  composer = createComposer({
    document: page.document,
    host,
    translator: createTranslator({ language }),
    onSubmit: async () => ({ sentAs: { identifier: 'DEV-1', number: 1 }, ...(notify === undefined ? {} : { notify }) }),
  });
  composer.open(ANCHOR);
  (composer.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement).value = 'Le bouton est trop petit';
  (composer.element.querySelector('[data-fruitback-send]') as HTMLButtonElement).click();
  await tick();

  return page;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const part = <T extends Element = HTMLElement>(selector: string) => composer?.element.querySelector(selector) as T;
const form = () => part<HTMLFormElement>('[data-fruitback-notify]');
const email = () => part<HTMLInputElement>('[data-fruitback-notify-email]');
const yes = () => part<HTMLButtonElement>('[data-fruitback-notify-yes]');
const no = () => part<HTMLButtonElement>('[data-fruitback-notify-no]');
const error = () => part('[data-fruitback-notify-error]').textContent;
const done = () => part('[data-fruitback-notify-done]');

describe('the question of a note sent (FRU-604)', () => {
  it('is not asked when the host hands no question', async () => {
    await sentWith(undefined);
    assert.equal(form().hidden, true);
  });

  it('asks under the card, with a labelled field of an address, and focus in it', async () => {
    const page = await sentWith(offer([]));
    assert.equal(form().hidden, false);
    assert.equal(part('[data-fruitback-notify-title]').textContent, 'Want to know when it’s fixed?');
    assert.equal(form().getAttribute('aria-labelledby'), 'fruitback-notify-title');
    assert.equal(email().type, 'email');
    assert.equal(email().autocomplete, 'email');
    assert.equal(email().closest('label')?.textContent, 'Email');
    assert.equal(yes().textContent, 'Notify me');
    assert.equal(no().textContent, 'No thanks');
    assert.ok(deepActiveElement(page.document) === email());
  });

  it('stays open under a click elsewhere, and does not close by itself', async () => {
    const page = await sentWith(offer([]));
    page.document.body.click();
    await new Promise((resolve) => setTimeout(resolve, 4_100));
    assert.equal(composer?.element.hidden, false);
    assert.equal(form().hidden, false);
  });

  it('sends the address, says it once, and closes', async () => {
    const asked = offer(['sent']);
    await sentWith(asked);
    email().value = '  ana@example.com ';
    yes().click();
    await tick();
    assert.deepEqual(asked.sent, ['ana@example.com']);
    assert.equal(form().hidden, true);
    assert.equal(done().hidden, false);
    assert.equal(done().textContent, 'We’ll email you once, when it’s fixed.');
  });

  it('keeps the address in its field when it did not go, and says why', async () => {
    const asked = offer(['retry', 'wait', 'invalid']);
    await sentWith(asked);
    email().value = 'ana@example.com';
    yes().click();
    await tick();
    assert.equal(error(), 'Not saved. Try again.');
    yes().click();
    await tick();
    assert.equal(error(), 'Too many tries. Wait a minute, then try again.');
    yes().click();
    await tick();
    assert.equal(error(), 'Enter an email address, like name@example.com.');
    assert.equal(email().getAttribute('aria-invalid'), 'true');
    assert.equal(email().value, 'ana@example.com');
    assert.equal(form().hidden, false);
  });

  it('sends nothing for an empty field or what is no address', async () => {
    const asked = offer([]);
    await sentWith(asked);
    yes().click();
    await tick();
    email().value = 'not an address';
    yes().click();
    await tick();
    assert.deepEqual(asked.sent, []);
    assert.equal(error(), 'Enter an email address, like name@example.com.');
  });

  it('« No thanks » keeps the answer and closes, with nothing sent', async () => {
    const asked = offer([]);
    await sentWith(asked);
    no().click();
    assert.equal(asked.declined, 1);
    assert.deepEqual(asked.sent, []);
    assert.equal(composer?.element.hidden, true);
  });

  it('asks in French for a French reader', async () => {
    await sentWith(offer([]), 'fr');
    assert.equal(part('[data-fruitback-notify-title]').textContent, 'Être prévenu quand ce sera corrigé\u202F?');
    assert.equal(yes().textContent, 'Me prévenir');
    assert.equal(no().textContent, 'Non merci');
  });
});
