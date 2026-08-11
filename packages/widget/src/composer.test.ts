import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Composer, createComposer } from './composer.ts';
import { type MountedPage, keyboardEventCtor, mountPage } from './dom.fixture.ts';

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

function mount(onSubmit: (note: string) => Promise<boolean | void>) {
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

const field = () => composer?.element.querySelector('[data-fb-note]') as HTMLTextAreaElement;
const sendButton = () => composer?.element.querySelector('[data-fb-send]') as HTMLButtonElement;
const statusText = () => composer?.element.querySelector('[data-fb-status]')?.textContent ?? '';

describe('createComposer', () => {
  it('stays out of the way until it is opened', () => {
    mount(async () => true);

    assert.equal(composer?.element.hidden, true);
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
    assert.match(statusText(), /plante/);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'harvested');
    // The word the product uses, not "sent".
    assert.match(statusText(), /récolté/);
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
    // Cancel while the request is in flight and the response still arrives. Announcing "récolté" on
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

    const status = composer?.element.querySelector('[data-fb-status]');
    assert.equal(status?.getAttribute('role'), 'status');
    assert.equal(status?.getAttribute('aria-live'), 'polite');
    assert.equal(field().getAttribute('aria-label'), 'Votre commentaire');
  });

  it('takes its own DOM with it when destroyed', () => {
    const { host } = mount(async () => true);

    composer?.destroy();
    composer = null;

    assert.equal(host.querySelector('[data-fb-composer]'), null);
    assert.equal(host.querySelector('style'), null);
  });
});
