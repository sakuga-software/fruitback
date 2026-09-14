import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedReporter } from '@fruitback/shared';
import { type Composer, createComposer } from './composer.ts';
import { type MountedPage, keyboardEventCtor, mountPage } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * The states, which is what this file owns. How it looks is settled in a browser (`e2e/composer`);
 * what happens when the network is slow, when it fails, and when someone clicks twice is settled
 * here, because none of those are things you can see by looking.
 */

const ANCHOR = { left: 100, top: 200, bottom: 240, right: 300 };

let composer: Composer | null = null;

afterEach(() => {
  composer?.destroy();
  composer = null;
});

let mounted: MountedPage | null = null;

function mount(onSubmit: (note: string, reporter?: SeedReporter) => Promise<boolean | void>) {
  const page = mountPage('<main><button id="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  const host = page.document.createElement('div');
  page.document.body.append(host);
  composer = createComposer({ document: page.document, host, onSubmit });
  mounted = page;

  return { page, host };
}

/** A real key press from the page's own realm — a Node `Event` never reaches happy-dom's listeners. */
function press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  const KeyboardEventCtor = keyboardEventCtor(mounted as MountedPage);

  field().dispatchEvent(new KeyboardEventCtor('keydown', { key, bubbles: true, ...modifiers }));
}

const field = () => composer?.element.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
const sendButton = () => composer?.element.querySelector('[data-fruitback-send]') as HTMLButtonElement;
const statusText = () => composer?.element.querySelector('[data-fruitback-status]')?.textContent ?? '';

describe('what the popover looks like (SKG-529)', () => {
  it('draws the seed on the send button and still calls it Plant', () => {
    // The icon is appended after the template is parsed, because an SVG written into an innerHTML
    // string lands in the HTML namespace and renders nothing at all. It is aria-hidden, so the
    // button's accessible name has to be the word alone.
    mount(async () => {});

    assert.ok(sendButton().querySelector('svg.fruitback-icon'), 'the send button lost its mark');
    assert.equal(sendButton().textContent, 'Plant');
  });

  it('confirms in words, with no strawberry in front of them', async () => {
    mount(async () => {});
    composer?.open(ANCHOR);

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(statusText(), 'harvested');
  });
});

describe('createComposer', () => {
  it('stays out of the way until it is opened', () => {
    mount(async () => true);

    assert.equal(composer?.element.hidden, true);
  });

  it('carries no content in the template, so the field is not prefilled before any open', () => {
    // Measured before any `open()`, which sets `value` to '' and would mask a polluted template.
    // The trap is that a textarea's content is whitespace-sensitive: SKG-580 wrapped this tag to get
    // under 120 columns, and a break placed between `>` and `</textarea>` rather than between two
    // attributes puts text in the field that nobody typed. Losing or inventing what someone wrote is
    // the one failure this widget cannot afford.
    mount(async () => true);

    assert.equal(field().textContent, '');
    assert.equal(field().value, '');
  });

  it('opens empty, whatever the last note said', async () => {
    mount(async () => true);
    composer?.open(ANCHOR);
    field().value = 'un premier avis';
    composer?.close();

    composer?.open(ANCHOR);

    assert.equal(field().value, '');
  });

  it('walks from sending to harvested, and says so out loud', async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    mount(async () => {
      await inFlight;
      return true;
    });
    composer?.open(ANCHOR);
    field().value = 'Le bouton est trop petit';

    sendButton().click();
    await Promise.resolve();
    assert.equal(composer?.state(), 'sending');
    assert.match(statusText(), /planting/);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'harvested');
    // The word the product uses, not "sent".
    assert.match(statusText(), /harvested/);
  });

  it('refuses to plant the same note twice', async () => {
    // A double click while the request is in flight would create two issues, and the worker has no
    // way to tell them apart.
    let calls = 0;
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    mount(async () => {
      calls += 1;
      await inFlight;
      return true;
    });
    composer?.open(ANCHOR);

    sendButton().click();
    await Promise.resolve();
    sendButton().click();
    sendButton().click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls, 1);
    assert.equal(sendButton().disabled, true);
  });

  it('keeps the text when the send fails', async () => {
    // The one failure this widget cannot afford is losing what someone just wrote.
    mount(async () => {
      throw new Error('offline');
    });
    composer?.open(ANCHOR);
    field().value = 'Une remarque qui a pris du temps à écrire';

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Une remarque qui a pris du temps à écrire');
    assert.equal(composer?.element.hidden, false, 'the popover closed and took the note with it');
    assert.equal(sendButton().disabled, false, 'retrying should be one click');
  });

  it('treats a refusal like a failure, not like a success', async () => {
    mount(async () => false);
    composer?.open(ANCHOR);
    field().value = 'Refusée par le worker';

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Refusée par le worker');
  });

  it('sends on ⌘/Ctrl+Enter, and leaves a plain Enter to the note', async () => {
    let calls = 0;
    mount(async () => {
      calls += 1;
      return true;
    });
    composer?.open(ANCHOR);

    press('Enter');
    assert.equal(calls, 0);

    press('Enter', { metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
  });

  it('closes on Escape without sending anything', () => {
    let calls = 0;
    mount(async () => {
      calls += 1;
      return true;
    });
    composer?.open(ANCHOR);

    press('Escape');

    assert.equal(calls, 0);
    assert.equal(composer?.element.hidden, true);
  });

  it('says nothing when the reporter walked away mid-send', async () => {
    // Cancel while the request is in flight and the response still arrives. Announcing "harvested" on
    // a closed popover, or focusing a hidden textarea, is the kind of ghost that makes a widget feel
    // haunted.
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    mount(async () => {
      await inFlight;
      return true;
    });
    composer?.open(ANCHOR);

    sendButton().click();
    await Promise.resolve();
    composer?.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'idle');
    assert.equal(composer?.element.hidden, true);
    assert.equal(statusText(), '');
  });

  it('does not report a stale failure onto the next note', async () => {
    // Same race, the other outcome: the first send fails after the reporter has moved on and opened
    // the popover on a different element.
    let fail: (reason: Error) => void = () => {};
    const inFlight = new Promise<void>((_resolve, reject) => (fail = reject));
    mount(async () => {
      await inFlight;
      return true;
    });
    composer?.open(ANCHOR);
    sendButton().click();
    await Promise.resolve();

    composer?.close();
    composer?.open(ANCHOR);
    fail(new Error('offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'idle', 'the new note inherited the old note’s failure');
    assert.equal(statusText(), '');
  });

  it('announces its state to a screen reader', () => {
    mount(async () => true);

    const status = composer?.element.querySelector('[data-fruitback-status]');
    assert.equal(status?.getAttribute('role'), 'status');
    assert.equal(status?.getAttribute('aria-live'), 'polite');
    assert.equal(field().getAttribute('aria-label'), 'Your comment');
  });

  it('writes a host translation as text, never as markup (SKG-530)', () => {
    // The template is parsed with innerHTML, so a word interpolated into it would be parsed too.
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const translator = createTranslator({
      locale: 'fr',
      messages: {
        fr: { 'composer.cancel': '<img src=x onerror="alert(1)">', 'composer.placeholder': '"><b>bold</b>' },
      },
    });
    composer = createComposer({ document: page.document, host, onSubmit: async () => true, translator });

    assert.equal(
      composer.element.querySelector('[data-fruitback-cancel]')?.textContent,
      '<img src=x onerror="alert(1)">',
    );
    assert.equal(field().placeholder, '"><b>bold</b>');
    assert.equal(composer.element.querySelector('img'), null);
    assert.equal(composer.element.querySelector('b'), null);
  });

  it('takes its own DOM with it when destroyed', () => {
    const { host } = mount(async () => true);

    composer?.destroy();
    composer = null;

    assert.equal(host.querySelector('[data-fruitback-composer]'), null);
    assert.equal(host.querySelector('style'), null);
  });
});

describe('saying who you are, or not', () => {
  const query = (page: MountedPage, selector: string) => page.document.querySelector(selector) as HTMLElement;

  it('is anonymous by default: the fields are hidden and nothing is claimed', async () => {
    // Anonymous has to stay the path of least resistance. It is the default in the contract too —
    // an absent reporter, not an empty one.
    const seen: (SeedReporter | undefined)[] = [];
    const { page } = mount(async (_note, reporter) => void seen.push(reporter));
    composer?.open(ANCHOR);

    assert.equal((query(page, '[data-fruitback-who]') as HTMLElement).hidden, true);
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = 'Une note';
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();

    assert.deepEqual(seen, [undefined]);
  });

  it('reveals the fields when asked, and says so to a screen reader', () => {
    const { page } = mount(async () => true);
    composer?.open(ANCHOR);
    const toggle = query(page, '[data-fruitback-identify]');

    toggle.click();

    assert.equal((query(page, '[data-fruitback-who]') as HTMLElement).hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });

  it('passes what was typed, trimmed, and leaves an empty field out', async () => {
    const seen: (SeedReporter | undefined)[] = [];
    const { page } = mount(async (_note, reporter) => void seen.push(reporter));
    composer?.open(ANCHOR);

    (query(page, '[data-fruitback-name]') as HTMLInputElement).value = '  Alice  ';
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = 'Une note';
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();

    // No `email` key at all: the round-trip forbids a field the caller did not provide.
    assert.deepEqual(seen, [{ name: 'Alice' }]);
  });

  it('never claims to be verified, because that is the worker word', async () => {
    const seen: (SeedReporter | undefined)[] = [];
    const { page } = mount(async (_note, reporter) => void seen.push(reporter));
    composer?.open(ANCHOR);

    (query(page, '[data-fruitback-name]') as HTMLInputElement).value = 'Alice';
    (query(page, '[data-fruitback-email]') as HTMLInputElement).value = 'alice@acme.test';
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = 'Une note';
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();

    assert.deepEqual(seen, [{ name: 'Alice', email: 'alice@acme.test' }]);
    assert.equal(seen[0] && 'verified' in seen[0], false);
  });
});
