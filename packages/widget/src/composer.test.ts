import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteReporter } from '@fruitback/shared';
import {
  type BatchSeam,
  type BatchSent,
  type Composer,
  type ComposerOptions,
  type DestinationChoice,
  type SendFailure,
  type SentAs,
  type SentWithoutPicture,
  FIELD_MAX,
  createComposer,
  initialsOf,
  placeParts,
} from './composer.ts';
import type { Destination } from './destinations.ts';
import { deepActiveElement, focusables } from './focus.ts';
import { type MountedPage, keyboardEventCtor, mountPage, useHandFrames, stylesIn } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * The states, which is what this file owns. How it looks is settled in a browser (`e2e/composer`);
 * what happens when the network is slow, when it fails, and when someone clicks twice is settled
 * here, because none of those are things you can see by looking.
 */

const ANCHOR = { left: 100, top: 200, bottom: 240, right: 300 };

/** A batch as `embed.ts` gives it (FRU-608), with the parts a test changes. */
function batchOf(more: Partial<BatchSeam> & { count?: () => number } = {}): BatchSeam {
  return {
    offered: () => true,
    waiting: more.count ?? (() => 0),
    subscribe: () => () => {},
    add: async () => true,
    sendAll: async (note) => ({ sent: [{ id: 'n1', text: note }], unsent: [] }),
    resend: async () => ({ sent: [], unsent: [] }),
    ...more,
  };
}

let composer: Composer | null = null;

afterEach(() => {
  composer?.destroy();
  composer = null;
});

let mounted: MountedPage | null = null;

function mount(
  onSubmit: (
    note: string,
    reporter?: NoteReporter,
  ) => Promise<boolean | void | SendFailure | SentWithoutPicture | SentAs>,
  more: Pick<
    ComposerOptions,
    'memory' | 'identified' | 'batch' | 'picture' | 'onClose' | 'autosave' | 'suggestName'
  > = {},
) {
  const page = mountPage('<main><button id="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  const host = page.document.createElement('div');
  page.document.body.append(host);
  composer = createComposer({ document: page.document, host, onSubmit, ...more });
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
/** The head lost its cross in FRU-305: « Cancel » and Escape close the composer. */
const closeButton = () => composer?.element.querySelector('[data-fruitback-close]') ?? null;
const cancelButton = () => composer?.element.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;
const statusText = () => composer?.element.querySelector('[data-fruitback-status]')?.textContent ?? '';
/** The card of a failed send (FRU-305): its title, then the sentence of its cause. */
const failedText = () =>
  [...(composer?.element.querySelectorAll('[data-fruitback-failed] p') ?? [])].map((p) => p.textContent).join(' ');
/** The title of the card of a sent note (FRU-305). */
const sentTitle = () => composer?.element.querySelector('[data-fruitback-sent-title]')?.textContent ?? '';
const sentText = () => composer?.element.querySelector('[data-fruitback-sent-text]')?.textContent ?? '';

describe('what the popover looks like (FRU-36)', () => {
  it('writes Send behind the drop of the mark, and has no cross: Cancel and Escape close it (FRU-305)', () => {
    // The icon is appended after the template is built, because an SVG made by createElement lands
    // in the HTML namespace and renders nothing at all.
    mount(async () => {});

    assert.ok(sendButton().querySelector('svg.fruitback-icon'), 'the drop of Send is not drawn');
    assert.equal(sendButton().textContent, 'Send');
    assert.equal(closeButton(), null);
  });

  it('has a head: what the note points at, in mono, with what the element says as its title (FRU-305)', () => {
    mount(async () => {});
    const about = () => composer?.element.querySelector('[data-fruitback-about]') as HTMLElement;

    composer?.open(ANCHOR, 'button.add · <AddToCart>', 'Ajouter');
    assert.equal(about().textContent, 'button.add · <AddToCart>');
    assert.equal(about().title, 'Ajouter');

    // As text: it is whatever the page called its element.
    composer?.close();
    composer?.open(ANCHOR, '<img src=x onerror=alert(1)>');
    assert.equal(about().textContent, '<img src=x onerror=alert(1)>');
    assert.equal(about().querySelector('img'), null);
  });

  it('holds the note, its files, its tools and the signature in one field, three zones in all (FRU-607)', () => {
    mount(async () => {});
    composer?.open(ANCHOR);
    const root = composer?.element as HTMLElement;
    // The head, the body, the foot: no row of chips between the field and the foot.
    assert.deepEqual(
      [...root.children].filter((child) => !(child as HTMLElement).hidden).map((child) => child.className),
      ['fruitback-composer-tether', 'fruitback-composer-head', 'fruitback-composer-body', 'fruitback-composer-foot'],
    );
    const box = root.querySelector('[data-fruitback-box]') as HTMLElement;
    for (const inside of ['[data-fruitback-note]', '[data-fruitback-attach-list]', '[data-fruitback-tools]'])
      assert.ok(box.contains(root.querySelector(inside)), `${inside} is not in the field`);
    // The files come above the icons.
    const order = [...box.querySelectorAll('[data-fruitback-attach-list], [data-fruitback-tools]')];
    assert.deepEqual(
      order.map((each) => each.hasAttribute('data-fruitback-tools')),
      [false, true],
    );
    // « Your note » still names the field, for a screen reader: the label wraps it.
    assert.equal(field().closest('label')?.querySelector('[data-fruitback-note-label]')?.textContent, 'Your note');
    // « Attachments » is in the tree, hidden while no host offers files (FRU-332).
    assert.equal(root.querySelector('[data-fruitback-attach]')?.hasAttribute('hidden'), true);
    // The name stands behind the avatar, folded.
    const name = root.querySelector('[data-fruitback-name]') as HTMLInputElement;
    assert.equal(name.closest('[data-fruitback-who]')?.hasAttribute('hidden'), true);
    assert.equal(root.querySelector('[data-fruitback-identify]'), null);
  });

  it('says where the note lands in the foot: the one place, or the team (FRU-305)', () => {
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const lands = () => composer?.element.querySelector('[data-fruitback-lands]') as HTMLElement;
    const offered: Destination[][] = [[], [{ id: 'a', label: 'Linear · Northwind' }]];
    for (const places of offered) {
      composer = createComposer({
        document: page.document,
        host,
        onSubmit: async () => true,
        destinations: {
          offered: () => places,
          subscribe: () => () => {},
          remembered: () => undefined,
          remember: () => {},
        },
      });
      composer.open(ANCHOR);
      if (places.length === 0) assert.equal(lands().textContent, 'Sent to the team');
      else {
        // In icons (FRU-607): the tile of the tool and the most precise name, the whole path in the
        // tooltip and for a screen reader.
        assert.equal(lands().querySelector('.fruitback-composer-tile')?.textContent, 'L');
        assert.equal(lands().querySelector('.fruitback-composer-place-name')?.textContent, 'Northwind');
        // Heard whole: « Creates a new issue in Linear · », then the name in sight.
        assert.equal(lands().querySelector('.fruitback-composer-sr')?.textContent, 'Creates a new issue in Linear · ');
        assert.equal(
          [...lands().childNodes]
            .slice(1)
            .map((node) => node.textContent)
            .join(''),
          'Creates a new issue in Linear · Northwind',
        );
        assert.equal(lands().title, 'Linear · Northwind');
      }
      composer.destroy();
      composer = null;
    }
  });

  it('offers « Choose another element » only to a host that can start a capture, and keeps the text when it does (FRU-305)', () => {
    let asked = 0;
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async () => true,
      onPickAgain: () => (asked += 1),
    });
    composer.open(ANCHOR, 'button.add');
    field().value = 'Half a note';
    const pick = composer.element.querySelector('[data-fruitback-pick]') as HTMLButtonElement;
    assert.equal(pick.hidden, false);
    assert.equal(pick.textContent, 'Choose another element');
    pick.click();
    assert.equal(asked, 1);
    // The host chooses again and opens the composer on the new element: nothing written goes.
    composer.open({ left: 400, top: 500, bottom: 540, right: 600 }, 'h3.title');
    assert.equal(field().value, 'Half a note');
    composer.destroy();
    composer = null;

    mount(async () => {});
    const pickOf = (open: Composer | null) => open?.element.querySelector('[data-fruitback-pick]') as HTMLButtonElement;
    assert.equal(pickOf(composer as Composer | null).hidden, true);
  });

  it('keeps what was written when the open composer is pointed at another element', async () => {
    // A second capture over an open composer chooses another element. Losing what somebody just
    // wrote is the one failure the product cannot afford: the text stays, and the head says the new element.
    let remembered: string | undefined = 'Ana';
    mount(async () => true, {
      memory: {
        get: () => remembered,
        set: (name) => {
          remembered = name;
        },
      },
    });
    composer?.open(ANCHOR, 'The first element');
    field().value = 'Half a note';
    // The name the composer remembered, changed by hand and not sent yet: it is what was written too.
    const name = composer?.element.querySelector('[data-fruitback-name]') as HTMLInputElement;
    assert.equal(name.value, 'Ana');
    name.value = 'Bob';

    composer?.open({ left: 400, top: 500, bottom: 540, right: 600 }, 'The second element');

    assert.equal(field().value, 'Half a note');
    assert.equal(name.value, 'Bob', 'the name that was typed gave way to the one remembered');
    assert.equal(composer?.element.querySelector('[data-fruitback-about]')?.textContent, 'The second element');
    // Beside the new element, 16 px off its frame, which stands 5 px off the element (FRU-607).
    assert.equal(composer?.element.style.getPropertyValue('--fruitback-composer-left'), '621px');

    // The control: closed and opened again, it is a new note.
    composer?.close();
    composer?.open(ANCHOR, 'The first element');
    assert.equal(field().value, '');

    // And a composer that shows « sent » is not being written in: the next note starts empty.
    field().value = 'A whole note';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'sent');
    composer?.open(ANCHOR, 'The first element');
    assert.equal(field().value, '');
  });

  it('loses nothing when it is pointed at another element while the note is on its way', async () => {
    // The launch button is reachable under the composer while a note is sending. A send that then
    // fails must find its text and say why: it is the one failure the product cannot afford.
    let answer: (result: boolean) => void = () => {};
    mount(() => new Promise<boolean>((resolve) => (answer = resolve)));
    composer?.open(ANCHOR, 'The first element');
    field().value = 'A note on its way';
    sendButton().click();
    await Promise.resolve();
    assert.equal(composer?.state(), 'sending');

    composer?.open({ left: 400, top: 500, bottom: 540, right: 600 }, 'The second element');
    assert.equal(field().value, 'A note on its way');
    assert.equal(composer?.state(), 'sending');

    answer(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'A note on its way');
    assert.match(failedText(), /^Not sent Your text is still here\./);
  });

  it('closes on Cancel, and gives the note up', () => {
    let closed = 0;
    mount(async () => true, { onClose: () => (closed += 1) });
    composer?.open(ANCHOR);
    field().value = 'Une note';

    cancelButton().click();

    assert.equal(composer?.element.hidden, true);
    assert.equal(closed, 1);
  });

  it('confirms in a card, with no strawberry in front of the words (FRU-305)', async () => {
    mount(async () => {});
    composer?.open(ANCHOR);

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentTitle(), 'Sent');
    const sent = (composer as Composer).element;
    assert.equal((sent.querySelector('[data-fruitback-sent]') as HTMLElement).hidden, false);
    // No way to an issue it was not told about.
    assert.equal((sent.querySelector('[data-fruitback-sent-open]') as HTMLElement).hidden, true);
  });

  it('says « Sent as » the identifier, with the number of the pin and the way to the issue (FRU-305)', async () => {
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async () => ({ sentAs: { identifier: 'FRU-134', url: 'https://linear.app/x/FRU-134', number: 5 } }),
    });
    composer.open(ANCHOR);
    field().value = 'Une note';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentTitle(), 'Sent as FRU-134');
    assert.equal(composer.element.querySelector('[data-fruitback-sent-drop]')?.textContent, '5');
    assert.equal(
      composer.element.querySelector('[data-fruitback-sent-text]')?.textContent,
      'The pin stays here and follows the issue’s status.',
    );
    const open = composer.element.querySelector('[data-fruitback-sent-open]') as HTMLAnchorElement;
    assert.equal(open.hidden, false);
    assert.equal(open.textContent, 'Open →');
    assert.equal(open.getAttribute('href'), 'https://linear.app/x/FRU-134');
    // The card is read where focus is: on its link.
    assert.ok(deepActiveElement(page.document) === open);
    // A click anywhere else closes it at once.
    page.document.body.click();
    assert.equal(composer.element.hidden, true);
  });

  it('says when a note added to the batch has no picture, and not that it was sent (FRU-238, FRU-608)', async () => {
    mount(async () => true, {
      batch: batchOf({ add: async () => ({ picture: 'missed' as const }) }),
    });
    composer?.open(ANCHOR);
    field().value = 'Une note';

    (composer?.element.querySelector('[data-fruitback-keep]') as HTMLButtonElement | null)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'kept');
    assert.equal(statusText(), 'Added to the batch, without the picture');
  });

  it('says when the note went without the picture it asked for (FRU-238)', async () => {
    mount(async () => ({ picture: 'missed' as const }));
    composer?.open(ANCHOR);
    field().value = 'Une note';

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'sent');
    assert.equal(sentTitle(), 'Sent');
    assert.equal(
      sentText(),
      'Sent without the picture, which could not be taken. The pin stays here and follows the issue’s status.',
    );
  });

  it('keeps the identifier in the title of a note sent without its picture, and says the picture under it (FRU-326)', async () => {
    let answer: SentAs | SentWithoutPicture = { sentAs: { identifier: 'FRU-134', number: 3 }, picture: 'missed' };
    mount(async () => answer);
    composer?.open(ANCHOR);
    field().value = 'Une note';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentTitle(), 'Sent as FRU-134');
    assert.match(sentText(), /^Sent without the picture/);

    // The card is reused: the next note, sent with its picture, gets the sentence of the pin back.
    answer = { sentAs: { identifier: 'FRU-135', number: 4 } };
    composer?.open(ANCHOR);
    field().value = 'Une autre';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentTitle(), 'Sent as FRU-135');
    assert.equal(sentText(), 'The pin stays here and follows the issue’s status.');
  });
});

describe('createComposer', () => {
  it('stays out of the way until it is opened', () => {
    mount(async () => true);

    assert.equal(composer?.element.hidden, true);
  });

  it('carries no content in the template, so the field is not prefilled before any open', () => {
    // Measured before any `open()`, which sets `value` to '' and would mask a polluted template.
    // The trap is that a textarea's content is whitespace-sensitive: FRU-53 wrapped this tag to get
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

  it('walks from sending to sent, and says so out loud', async () => {
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
    assert.match(statusText(), /Sending/);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'sent');
    // The word the product uses, in the card of a sent note (FRU-305).
    assert.equal(sentTitle(), 'Sent');
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

  it('says what to do next by the cause of the failure, and keeps the text each time (FRU-156)', async () => {
    const said: Record<string, string> = {};
    for (const failure of ['retry', 'wait', 'refused', 'too-large'] as const) {
      mount(async () => failure);
      composer?.open(ANCHOR);
      field().value = `Une note, ${failure}`;
      sendButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(composer?.state(), 'failed');
      assert.equal(field().value, `Une note, ${failure}`);
      said[failure] = failedText();
      composer?.destroy();
      composer = null;
    }

    // « Not sent », then the sentence of the cause (FRU-305).
    assert.equal(said.retry, 'Not sent Your text is still here. Try again, or copy it before you close the page.');
    for (const sentence of Object.values(said)) assert.match(sentence, /^Not sent /);
    assert.match(said.wait ?? '', /in a minute/);
    assert.match(said.refused ?? '', /Tell the site’s team/);
    assert.match(said['too-large'] ?? '', /Shorten it/);
    assert.equal(new Set(Object.values(said)).size, 4, 'four causes, four sentences');
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
    // Cancel while the request is in flight and the response still arrives. Announcing "sent" on
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
    // A failure is said at once, in the card that holds it (FRU-305).
    assert.equal(composer?.element.querySelector('[data-fruitback-failed]')?.getAttribute('role'), 'alert');
    // Named by its label, « Your comment »; the placeholder says what to write.
    assert.equal(field().closest('label')?.textContent?.trim(), 'Your note');
    assert.equal(field().placeholder, 'What should change?');
  });

  it('writes a host translation as text, never as markup (FRU-37)', () => {
    // A word set as markup would be parsed: every word is set after the build, as text (FRU-389).
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

  it('above or below, opens on the element’s start edge, which is its right in a right-to-left language (FRU-38)', () => {
    // As wide as no side has room beside it (FRU-607).
    const anchor = { left: 300, top: 200, bottom: 240, right: 700 };
    const placedLeft = (translator: ReturnType<typeof createTranslator>) => {
      const page = mountPage('<main></main>', { width: 1_000, height: 1_000 });
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const opened = createComposer({ document: page.document, host, onSubmit: async () => true, translator });
      opened.open(anchor);
      const left = opened.element.style.getPropertyValue('--fruitback-composer-left');
      opened.destroy();

      return left;
    };

    // On the edge of the frame, which stands 5 px off the element (FRU-258, FRU-303).
    assert.equal(placedLeft(createTranslator()), '295px');
    // 705 minus the popover’s 360: its right edge sits on the right edge of the frame.
    assert.equal(
      placedLeft(createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } })),
      '345px',
    );
  });

  it('stays inside the window when the page is scrolled sideways (FRU-68)', () => {
    const placedLeft = (
      anchor: { left: number; top: number; bottom: number; right: number },
      translator = createTranslator(),
      width = 1_000,
    ) => {
      const page = mountPage('<main></main>', { width, height: 1_000 });
      page.view.scrollTo(1_500, 0);
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const opened = createComposer({ document: page.document, host, onSubmit: async () => true, translator });
      opened.open(anchor);
      const left = opened.element.style.getPropertyValue('--fruitback-composer-left');
      opened.destroy();

      return left;
    };

    // The element is on screen at document x 2000, so the popover opens beside it: 2100 + 5 + 16.
    assert.equal(placedLeft({ left: 2_000, top: 200, bottom: 240, right: 2_100 }), '2121px');
    // In a window of 600 px, with room on no side, it stops 10px short of its edge: 1500 + 600 - 360 - 10.
    assert.equal(placedLeft({ left: 1_850, top: 200, bottom: 240, right: 1_890 }, createTranslator(), 600), '1730px');
    // Right to left, near the left edge of the window, it stops 10px after it: 1500 + 10.
    assert.equal(
      placedLeft(
        { left: 1_520, top: 200, bottom: 240, right: 1_720 },
        createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } }),
        600,
      ),
      '1510px',
    );
  });

  it('follows an element that moves against the document at a scroll, and not one that moves with it (FRU-457)', () => {
    const page = mountPage('<main><a id="fixed">Administration</a><p id="prose">Du texte</p></main>', {
      width: 1_000,
      height: 1_000,
    });
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const opened = createComposer({ document: page.document, host, onSubmit: async () => true });
    composer = opened;
    opened.element.getBoundingClientRect = () => ({ height: 240 }) as DOMRect;
    const top = () => opened.element.style.getPropertyValue('--fruitback-composer-top');
    // `rect` is in the window, as `getBoundingClientRect` answers.
    const at = (element: Element, rect: { top: number }) =>
      Object.defineProperty(element, 'getBoundingClientRect', {
        // As wide as no side has room beside it (FRU-607): this test is about above and below.
        value: () => ({ left: 20, right: 900, top: rect.top, bottom: rect.top + 30 }),
        configurable: true,
      });
    const scroll = (y: number) => {
      Object.defineProperty(page.view, 'scrollY', { value: y, configurable: true });
      page.document.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('scroll'));
    };

    // A link of a fixed sidebar: 400 px from the top of the window, at any scroll.
    const fixed = page.query('#fixed');
    at(fixed, { top: 400 });
    opened.open(fixed);
    // 430 + 5 + 10, below the link: below comes before above (FRU-607).
    assert.equal(top(), '445px');
    scroll(300);
    assert.equal(top(), '745px', 'the composer left a link that stays in the window');

    // A paragraph of the document: the window moves over it, and the composer stays with it.
    opened.close();
    scroll(0);
    const prose = page.query('#prose');
    const where = { top: 600 };
    at(prose, where);
    opened.open(prose);
    assert.equal(top(), '645px');
    where.top = 300;
    scroll(300);
    assert.equal(top(), '645px', 'the composer slid along the window');

    // Closed, it follows nothing.
    opened.close();
    at(fixed, { top: 400 });
    scroll(500);
    assert.equal(top(), '645px');

    // An element of the document that shifts by 2 px as the page scrolls: the composer moves by as
    // much, and keeps the side it opened on.
    opened.close();
    scroll(0);
    const shifting = { top: 700 };
    at(prose, shifting);
    opened.open(prose);
    assert.equal(top(), '745px');
    assert.equal(opened.element.dataset.fruitbackSide, 'below');
    shifting.top = 502;
    scroll(200);
    assert.equal(top(), '747px', 'the composer jumped to the other side of its element');
    assert.equal(opened.element.dataset.fruitbackSide, 'below');

    // An element that a box scrolls sideways out of the window: the composer follows it down, and
    // stays inside the window across, 10 px from its edge (1000 - 360 - 10).
    Object.defineProperty(prose, 'getBoundingClientRect', {
      value: () => ({ left: 1_500, right: 1_620, top: 512, bottom: 542, width: 120, height: 30 }),
      configurable: true,
    });
    scroll(200);
    assert.equal(top(), '757px');
    assert.equal(opened.element.style.getPropertyValue('--fruitback-composer-left'), '630px');

    // An element the page hides, still in the document, measures as a box of nothing: the composer stays.
    Object.defineProperty(prose, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
      configurable: true,
    });
    scroll(400);
    assert.equal(top(), '757px', 'the composer followed an element that is hidden');

    // An element the page took away: the composer stays where it was, not at the top of the page.
    scroll(0);
    opened.open(fixed);
    assert.equal(top(), '445px');
    fixed.remove();
    at(fixed, { top: -40 });
    scroll(300);
    assert.equal(top(), '445px', 'the composer followed an element that is gone');
  });

  it('follows its element as it grows back from a press, on the edges it was placed against (FRU-489)', () => {
    // A button at `scale(0.97)` while pressed: 116 px of its 120, around the same centre. The click
    // places the composer on that box; React Aria takes the press off some frames later.
    // As wide as no side has room beside it (FRU-607): this test is about above and below.
    const pressed = { left: 21.8, right: 838.2, top: 300.45, bottom: 329.55 };
    const released = { left: 20, right: 840, top: 300, bottom: 330 };
    const opened = (translator = createTranslator(), box = { ...pressed }) => {
      const page = mountPage('<main><button id="add">Ajouter</button></main>', { width: 1_000, height: 1_000 });
      const frames = useHandFrames(page.view);
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const made = createComposer({ document: page.document, host, onSubmit: async () => true, translator });
      composer = made;
      made.element.getBoundingClientRect = () => ({ height: 240 }) as DOMRect;
      const button = page.query('#add');
      Object.defineProperty(button, 'getBoundingClientRect', { value: () => box, configurable: true });
      made.open(button);
      // Rounded: the edges of a scaled box are not whole, and their sums carry the error of a float.
      const read = (name: string) =>
        Math.round(Number.parseFloat(made.element.style.getPropertyValue(`--fruitback-composer-${name}`)) * 1_000) /
        1_000;
      const at = () => ({ left: read('left'), top: read('top') });

      return { made, frames, box, at };
    };

    // Left to right, on the left edge of the frame: 21.8 − 5, then 20 − 5 once released.
    const ltr = opened();
    // Below it, by its bottom edge: 329.55 + 5 + 10.
    assert.deepEqual(ltr.at(), { left: 16.8, top: 344.55 });
    for (let frame = 0; frame < 5; frame += 1) ltr.frames.next();
    Object.assign(ltr.box, released);
    ltr.frames.next();
    assert.deepEqual(ltr.at(), { left: 15, top: 345 }, 'the composer stayed on the pressed box');
    while (ltr.frames.next());
    ltr.made.destroy();

    // Right to left, on the right edge of the frame: it moves by that edge, the other way.
    const room = opened(createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } }), {
      ...pressed,
      left: 121.8,
      right: 638.2,
    });
    assert.equal(room.at().left, 283.2);
    Object.assign(room.box, { ...released, left: 120, right: 640 });
    room.frames.next();
    assert.equal(room.at().left, 285, 'the composer moved by the left edge of its element');
    room.made.destroy();

    // Below its element, it keeps to the bottom edge.
    const low = opened(createTranslator(), { ...pressed, top: 100.45, bottom: 129.55 });
    assert.equal(low.made.element.dataset.fruitbackSide, 'below');
    assert.equal(low.at().top, 144.55);
    Object.assign(low.box, { ...released, top: 100, bottom: 130 });
    low.frames.next();
    assert.equal(low.at().top, 145);

    // Closed, it stops reading the box.
    low.made.close();
    assert.equal(low.frames.next(), false, 'a closed composer still watched its element');
  });

  it('opens beside its element, then below, and above only when nothing else fits (FRU-258, FRU-607)', () => {
    const placed = (anchor: { left: number; top: number; bottom: number; right: number }, scrollY = 0) => {
      const page = mountPage('<main></main>', { width: 1_000, height: 1_000 });
      page.view.scrollTo(0, scrollY);
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const opened = createComposer({ document: page.document, host, onSubmit: async () => true });
      // No layout here: the test gives the popover the height the mock-up measures.
      opened.element.getBoundingClientRect = () => ({ height: 240 }) as DOMRect;
      opened.open(anchor);
      const result = {
        top: opened.element.style.getPropertyValue('--fruitback-composer-top'),
        side: opened.element.dataset.fruitbackSide,
      };
      opened.destroy();

      return result;
    };

    // Elements as wide as no side has room beside them (FRU-607): below comes first, then above.
    // No room below: 600 − 40 − 240, its bottom edge ends 40 px over the element, the name of the
    // component between them.
    assert.deepEqual(placed({ left: 100, top: 600, bottom: 800, right: 700 }), { top: '320px', side: 'above' });
    // Room below: under the frame, 5 px off the element, and 10 px more.
    assert.deepEqual(placed({ left: 100, top: 600, bottom: 640, right: 700 }), { top: '655px', side: 'below' });
    // The window, not the document, says what room there is: scrolled, the same element has room above only.
    assert.deepEqual(placed({ left: 100, top: 1_000, bottom: 1_200, right: 700 }, 400), {
      top: '720px',
      side: 'above',
    });
    // Room on no side, for an element as tall as the window: it stays in the window, at its bottom.
    assert.deepEqual(placed({ left: 100, top: 100, bottom: 950, right: 700 }), { top: '750px', side: 'below' });
  });

  it('opens beside its element on the end side, then the start side, with a tether to its middle (FRU-607)', () => {
    const placed = (
      anchor: { left: number; top: number; bottom: number; right: number },
      translator = createTranslator(),
    ) => {
      const page = mountPage('<main></main>', { width: 1_000, height: 1_000 });
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const opened = createComposer({ document: page.document, host, onSubmit: async () => true, translator });
      opened.element.getBoundingClientRect = () => ({ height: 240 }) as DOMRect;
      opened.open(anchor);
      const read = (name: string) => opened.element.style.getPropertyValue(`--fruitback-composer-${name}`);
      const result = {
        left: read('left'),
        top: read('top'),
        side: opened.element.dataset.fruitbackSide,
        tether: read('tether'),
        length: read('tether-length'),
      };
      opened.destroy();

      return result;
    };
    const rtl = createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } });

    // To the right: 300 + 5 + 16, its top on the top of the frame, the tether on the middle of the element.
    assert.deepEqual(placed({ left: 100, top: 400, bottom: 440, right: 300 }), {
      left: '321px',
      top: '395px',
      side: 'right',
      tether: '25px',
      length: '16px',
    });
    // No room to the right: to the left, 700 − 5 − 16 − 360.
    assert.deepEqual(placed({ left: 700, top: 400, bottom: 440, right: 900 }).left, '319px');
    assert.deepEqual(placed({ left: 700, top: 400, bottom: 440, right: 900 }).side, 'left');
    // Right to left, the end side is the left.
    assert.deepEqual(placed({ left: 500, top: 400, bottom: 440, right: 600 }, rtl).side, 'left');
    assert.deepEqual(placed({ left: 100, top: 400, bottom: 440, right: 300 }, rtl).side, 'right');
    // Near the foot of the window, it stays in it, and the tether stays on its edge, off its corner.
    assert.deepEqual(placed({ left: 100, top: 980, bottom: 995, right: 300 }), {
      left: '321px',
      top: '750px',
      side: 'right',
      tether: '222px',
      length: '16px',
    });
  });

  it('shows the box of the picture only when a picture can be taken, and never ticks it itself (FRU-258)', () => {
    // Privacy: no image leaves the page without a choice. The box shows the preference; the default is off.
    let attach = false;
    const listeners: (() => void)[] = [];
    const picture = {
      offered: () => true,
      get: () => attach,
      set: (next: boolean) => {
        attach = next;
      },
      subscribe: (listener: () => void) => {
        listeners.push(listener);

        return () => {};
      },
    };
    mount(async () => true, { picture });
    const label = () => composer?.element.querySelector('[data-fruitback-picture-label]') as HTMLElement;
    const box = () => composer?.element.querySelector('[data-fruitback-picture]') as HTMLInputElement;

    composer?.open(ANCHOR);
    assert.equal(label().hidden, false);
    assert.equal(label().textContent?.trim(), 'Attach a picture of the element');
    assert.equal(box().checked, false, 'the box was ticked by default');
    assert.equal(attach, false, 'opening the composer changed the preference');

    // Ticked: the preference is kept at once, with or without a note sent.
    box().checked = true;
    const EventCtor = (mounted as MountedPage).view as unknown as { Event: typeof Event };
    box().dispatchEvent(new EventCtor.Event('change', { bubbles: true }));
    assert.equal(attach, true);

    // The next note shows what was chosen, and the settings panel can turn it off under an open composer.
    composer?.close();
    composer?.open(ANCHOR);
    assert.equal(box().checked, true);
    attach = false;
    for (const listener of listeners) listener();
    assert.equal(box().checked, false);
  });

  it('has no box of the picture when the host cannot take one', () => {
    mount(async () => true);
    composer?.open(ANCHOR);
    const label = () => composer?.element.querySelector('[data-fruitback-picture-label]') as HTMLElement;
    assert.equal(label().hidden, true);

    composer?.destroy();
    mount(async () => true, { picture: { offered: () => false, get: () => true, set: () => {} } });
    composer?.open(ANCHOR);
    assert.equal(label().hidden, true);
    // Not offered is not ticked, whatever the stored preference says.
    assert.equal((label().querySelector('input') as HTMLInputElement).checked, false);
  });

  it('grows the field with its text up to 150 px, then fades its foot while text is below (FRU-611, P7)', () => {
    mount(async () => {});
    composer?.open(ANCHOR);
    const input = new ((mounted as MountedPage).view as unknown as { Event: typeof Event }).Event('input', {
      bubbles: true,
    });
    // happy-dom lays nothing out: the heights are given, as a browser would measure them.
    let content = 120;
    Object.defineProperty(field(), 'scrollHeight', { get: () => content, configurable: true });
    Object.defineProperty(field(), 'clientHeight', {
      get: () => Number.parseFloat(field().style.height) || 96,
      configurable: true,
    });
    field().dispatchEvent(input);
    assert.equal(field().style.height, '120px');
    assert.equal(field().hasAttribute('data-fruitback-more'), false);

    content = 400;
    field().dispatchEvent(input);
    assert.equal(field().style.height, `${FIELD_MAX}px`);
    assert.equal(field().hasAttribute('data-fruitback-more'), true);
    // Scrolled to its end, the fade goes.
    field().scrollTop = 250;
    field().dispatchEvent(new ((mounted as MountedPage).view as unknown as { Event: typeof Event }).Event('scroll'));
    assert.equal(field().hasAttribute('data-fruitback-more'), false);
  });

  it('gives each button of words its words in a tooltip, for the one that ends in « … » (FRU-611, P7)', () => {
    mount(async () => {}, { batch: batchOf() });
    composer?.open(ANCHOR);
    for (const name of ['cancel', 'send']) {
      const button = composer?.element.querySelector(`[data-fruitback-${name}]`) as HTMLElement;
      assert.equal(button.title, button.textContent, `${name} has no tooltip of its words`);
    }
  });

  it('takes its own DOM with it when destroyed', () => {
    const { host } = mount(async () => true);

    composer?.destroy();
    composer = null;

    assert.equal(host.querySelector('[data-fruitback-composer]'), null);
    assert.equal(stylesIn(host), '');
  });
});

describe('saying who you are, or not', () => {
  const query = (page: MountedPage, selector: string) => page.document.querySelector(selector) as HTMLElement;

  it('is anonymous by default: the name is empty, and nothing is claimed', async () => {
    // Anonymous has to stay the path of least resistance. It is the default in the contract too —
    // an absent reporter, not an empty one. The field is in sight since FRU-305, and empty.
    const seen: (NoteReporter | undefined)[] = [];
    const { page } = mount(async (_note, reporter) => void seen.push(reporter));
    composer?.open(ANCHOR);

    // Signed « Guest », in dashes, and the name folded behind it (FRU-607).
    const avatar = query(page, '[data-fruitback-avatar]');
    assert.equal(avatar.dataset.fruitbackAvatar, 'guest');
    assert.equal(avatar.textContent, 'Guest');
    assert.equal(avatar.getAttribute('aria-label'), 'Signed as Guest. Add your name');
    assert.equal((query(page, '[data-fruitback-who]') as HTMLElement).hidden, true);
    assert.equal((query(page, '[data-fruitback-name]') as HTMLInputElement).value, '');
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = 'Une note';
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();

    assert.deepEqual(seen, [undefined]);
  });

  it('opens « Name » from the avatar, which then shows the initials and the whole name (FRU-607)', () => {
    const { page } = mount(async () => true);
    composer?.open(ANCHOR);
    const avatar = query(page, '[data-fruitback-avatar]') as HTMLButtonElement;
    const who = query(page, '[data-fruitback-who]');
    const name = query(page, '[data-fruitback-name]') as HTMLInputElement;
    // « Name », and « Remember me in this browser » (FRU-609).
    assert.equal(name.closest('label')?.textContent?.trim(), 'Name');
    assert.equal(avatar.getAttribute('aria-expanded'), 'false');
    assert.equal(avatar.getAttribute('aria-controls'), who.id);

    avatar.click();
    assert.equal(who.hidden, false);
    assert.equal(avatar.getAttribute('aria-expanded'), 'true');
    assert.equal(deepActiveElement(page.document), name);

    name.value = 'Camille Durand';
    name.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
    assert.equal(avatar.textContent, 'CD');
    assert.equal(avatar.title, 'Camille Durand');
    assert.equal(avatar.dataset.fruitbackAvatar, 'named');
    assert.equal(avatar.getAttribute('aria-label'), 'Signed as Camille Durand. Change the name');

    // Folded again, the name stays: nothing typed goes.
    avatar.click();
    assert.equal(who.hidden, true);
    assert.equal(name.value, 'Camille Durand');
    assert.equal(avatar.textContent, 'CD');
  });

  it('writes the initials of a name by its first and last words, and by code point', () => {
    assert.equal(initialsOf('Camille Durand'), 'CD');
    assert.equal(initialsOf('  camille  '), 'C');
    assert.equal(initialsOf('Jean Pierre de la Fontaine'), 'JF');
    assert.equal(initialsOf('𝒜da Lovelace'), '𝒜L');
    assert.equal(initialsOf('   '), '');
    assert.equal(initialsOf('ilker', 'tr'), 'İ');
  });

  it('passes what was typed, trimmed, and leaves an empty field out', async () => {
    const seen: (NoteReporter | undefined)[] = [];
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
    const seen: (NoteReporter | undefined)[] = [];
    const { page } = mount(async (_note, reporter) => void seen.push(reporter));
    composer?.open(ANCHOR);

    (query(page, '[data-fruitback-name]') as HTMLInputElement).value = 'Alice';
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = 'Une note';
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();

    assert.deepEqual(seen, [{ name: 'Alice' }]);
    assert.equal(seen[0] && 'verified' in seen[0], false);
  });

  it('asks for a name and for nothing else (FRU-91)', () => {
    const { page } = mount(async () => true);
    composer?.open(ANCHOR);
    const typed = [...page.document.querySelectorAll('[data-fruitback-who] input')] as HTMLInputElement[];

    assert.deepEqual(
      typed.map((input) => input.type),
      ['text', 'checkbox'],
    );
    // FRU-604: the one address field is the question asked after a visitor's note is sent, hidden
    // until then, and not a field of the note. Compared as booleans: a failed compare of two elements
    // makes node:assert diff the whole DOM.
    const emails = [...page.document.querySelectorAll('[type="email"]')];
    assert.equal(emails.length, 1);
    assert.equal(emails[0]?.closest('[data-fruitback-notify]') !== null, true);
    assert.equal((page.document.querySelector('[data-fruitback-notify]') as HTMLElement).hidden, true);
  });
});

describe('remembering the name, when the reporter asks (FRU-91)', () => {
  const query = (page: MountedPage, selector: string) => page.document.querySelector(selector) as HTMLElement;
  const input = (page: MountedPage, selector: string) => query(page, selector) as HTMLInputElement;

  /** A memory that records every write, so a test can tell "wrote nothing" from "wrote the same". */
  function memoryHolding(initial?: string) {
    let held = initial;
    const writes: (string | undefined)[] = [];

    return {
      writes,
      held: () => held,
      memory: {
        get: () => held,
        set(name: string | undefined) {
          held = name;
          writes.push(name);
        },
      },
    };
  }

  function tick(page: MountedPage, box: HTMLInputElement, checked: boolean): void {
    box.checked = checked;
    box.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
  }

  async function send(page: MountedPage, note = 'Une note'): Promise<void> {
    (query(page, '[data-fruitback-note]') as HTMLTextAreaElement).value = note;
    query(page, '[data-fruitback-send]').click();
    await Promise.resolve();
  }

  // FRU-302: the « Name on my notes » of the extension, for a reporter who kept none here.
  it('fills the name the host suggests, leaves the box as it is, and keeps a remembered name first', async () => {
    const { memory, writes } = memoryHolding();
    const { page } = mount(async () => true, { memory, suggestName: () => 'Camille Durand' });
    composer?.open(ANCHOR);

    assert.equal(input(page, '[data-fruitback-name]').value, 'Camille Durand');
    assert.equal(input(page, '[data-fruitback-remember]').checked, false, 'a suggestion ticked « remember me »');
    await send(page);
    assert.deepEqual(writes, [], 'the site kept a name it was not asked to');

    composer?.close();
    const kept = memoryHolding('Ana');
    const second = mount(async () => true, { memory: kept.memory, suggestName: () => 'Camille Durand' });
    composer?.open(ANCHOR);
    assert.equal(input(second.page, '[data-fruitback-name]').value, 'Ana');
  });

  it('writes nothing when the box is not ticked, name typed or not', async () => {
    const { memory, writes } = memoryHolding();
    const { page } = mount(async () => true, { memory });
    composer?.open(ANCHOR);

    assert.equal(input(page, '[data-fruitback-remember]').checked, false, 'the box starts ticked');
    input(page, '[data-fruitback-name]').value = 'Alice';
    await send(page);

    assert.deepEqual(writes, []);
  });

  it('keeps the trimmed name when the box is ticked, and shows it on the next note', async () => {
    const { memory, held } = memoryHolding();
    const { page } = mount(async () => true, { memory });
    composer?.open(ANCHOR);
    input(page, '[data-fruitback-name]').value = '  Alice  ';
    tick(page, input(page, '[data-fruitback-remember]'), true);
    await send(page);
    assert.equal(held(), 'Alice');

    composer?.close();
    input(page, '[data-fruitback-name]').value = '';
    input(page, '[data-fruitback-remember]').checked = false;
    composer?.open(ANCHOR);

    assert.equal(input(page, '[data-fruitback-name]').value, 'Alice');
    assert.equal(input(page, '[data-fruitback-remember]').checked, true);
    // The name the note is signed with shows on the avatar (FRU-607).
    assert.equal(query(page, '[data-fruitback-avatar]').textContent, 'A');
    assert.equal(query(page, '[data-fruitback-avatar]').title, 'Alice');
  });

  it('keeps the name when the send fails, because the choice was made before it', async () => {
    const { memory, held } = memoryHolding();
    const { page } = mount(async () => false, { memory });
    composer?.open(ANCHOR);
    input(page, '[data-fruitback-name]').value = 'Alice';
    tick(page, input(page, '[data-fruitback-remember]'), true);
    await send(page);
    await Promise.resolve();

    assert.equal(composer?.state(), 'failed');
    assert.equal(held(), 'Alice');
  });

  it('forgets at once when the box is unticked, with no note sent', () => {
    const { memory, writes, held } = memoryHolding('Alice');
    const { page } = mount(async () => true, { memory });
    composer?.open(ANCHOR);

    tick(page, input(page, '[data-fruitback-remember]'), false);

    assert.deepEqual(writes, [undefined]);
    assert.equal(held(), undefined);
  });

  it('forgets when the box stays ticked and the name is emptied', async () => {
    const { memory, held } = memoryHolding('Alice');
    const { page } = mount(async () => true, { memory });
    composer?.open(ANCHOR);
    input(page, '[data-fruitback-name]').value = '   ';
    await send(page);

    assert.equal(held(), undefined);
  });

  it('offers no box when it was given nowhere to keep the name', () => {
    const { page } = mount(async () => true);
    composer?.open(ANCHOR);

    assert.equal(query(page, '[data-fruitback-remember-label]').hidden, true);
  });

  it('asks for no name when the worker names the reporter, and sends none', async () => {
    const seen: (NoteReporter | undefined)[] = [];
    const { memory, writes } = memoryHolding('Alice');
    const { page } = mount(async (_note, reporter) => void seen.push(reporter), { memory, identified: true });
    composer?.open(ANCHOR);

    assert.equal(query(page, '[data-fruitback-who]').hidden, true);
    // No avatar either: the worker signs, and the widget does not know the name (FRU-112).
    assert.equal(query(page, '[data-fruitback-avatar]').hidden, true);
    await send(page);

    assert.deepEqual(seen, [undefined]);
    assert.deepEqual(writes, []);
  });

  it('asks whether the worker names the reporter at each open, and never under an open composer (FRU-112)', async () => {
    // In team mode the widget learns it from a read, after the composer is built, and a session ends.
    const seen: (NoteReporter | undefined)[] = [];
    let identified = false;
    const { page } = mount(async (_note, reporter) => void seen.push(reporter), { identified: () => identified });
    const asked = () => !query(page, '[data-fruitback-avatar]').hidden;

    composer?.open(ANCHOR);
    assert.equal(asked(), true);
    input(page, '[data-fruitback-name]').value = 'Alice';

    // The answer changes while somebody types: the field stays, and the note goes with the name.
    identified = true;
    composer?.identityChanged();
    assert.equal(asked(), true);
    await send(page);
    composer?.close();

    // Closed, it takes the answer at once, and the next note carries no name.
    composer?.identityChanged();
    assert.equal(asked(), false);
    composer?.open(ANCHOR);
    assert.equal(asked(), false);
    assert.equal(query(page, '[data-fruitback-who]').hidden, true);
    await send(page);
    composer?.close();

    // The session ended: the field comes back.
    identified = false;
    composer?.open(ANCHOR);
    assert.equal(asked(), true);

    assert.deepEqual(seen, [{ name: 'Alice' }, undefined]);
  });
});

describe('the popover as a dialog (FRU-51)', () => {
  function keyOn(target: Element, key: string, shiftKey = false): KeyboardEvent {
    const KeyboardEventCtor = keyboardEventCtor(mounted as MountedPage);
    const event = new KeyboardEventCtor('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    return event;
  }

  const active = () => (mounted as MountedPage).document.activeElement;
  const cancelButton = () => composer?.element.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;

  function opener(): HTMLButtonElement {
    const { document } = mounted as MountedPage;
    const button = document.createElement('button');
    document.body.append(button);

    return button;
  }

  it('is a modal dialog, with a name that is not the name of its field', () => {
    mount(async () => true);

    assert.equal(composer?.element.getAttribute('role'), 'dialog');
    assert.equal(composer?.element.getAttribute('aria-modal'), 'true');
    assert.equal(composer?.element.getAttribute('aria-label'), 'New note');
    assert.notEqual(composer?.element.getAttribute('aria-label'), field().getAttribute('aria-label'));
  });

  it('keeps Tab inside, in both directions', () => {
    mount(async () => true);
    composer?.open(ANCHOR);

    sendButton().focus();
    assert.equal(keyOn(sendButton(), 'Tab').defaultPrevented, true);
    // The field of the note is the first control since the head lost its cross (FRU-305).
    assert.ok(active() === field(), 'Tab on the last control did not go back to the first');

    assert.equal(keyOn(field(), 'Tab', true).defaultPrevented, true);
    assert.ok(active() === sendButton(), 'Shift+Tab on the first control did not go to the last');
  });

  it('leaves Tab to the browser between two controls inside', () => {
    mount(async () => true);
    composer?.open(ANCHOR);

    assert.equal(keyOn(field(), 'Tab').defaultPrevented, false);
  });

  it('does not count the send button while it is disabled', async () => {
    mount(() => new Promise<boolean>(() => {}));
    composer?.open(ANCHOR);
    field().value = 'Le bouton est trop petit';
    sendButton().click();
    await Promise.resolve();
    assert.equal(sendButton().disabled, true);

    cancelButton().focus();
    keyOn(cancelButton(), 'Tab');

    assert.ok(active() === field(), 'the disabled send button is still in the cycle');
  });

  it('closes on Escape from any control, and the Escape goes no further', () => {
    mount(async () => true);
    let heard = 0;
    (mounted as MountedPage).document.addEventListener('keydown', () => (heard += 1));
    composer?.open(ANCHOR);

    keyOn(cancelButton(), 'Escape');

    assert.equal(composer?.element.hidden, true);
    assert.equal(heard, 0, 'the thread or the capture mode would close on the same key press');
  });

  it('gives focus back to what had it before it opened', () => {
    mount(async () => true);
    const launch = opener();
    launch.focus();

    composer?.open(ANCHOR);
    assert.ok(active() === field(), 'the note field has no focus after the open');
    press('Escape');

    assert.ok(active() === launch, 'focus did not go back to the opener');
  });

  it('gives focus back after Cancel too', () => {
    mount(async () => true);
    const launch = opener();
    launch.focus();
    composer?.open(ANCHOR);

    cancelButton().click();

    assert.ok(active() === launch, 'focus did not go back to the opener');
  });

  it('leaves focus where the reporter moved it', () => {
    mount(async () => true);
    const launch = opener();
    launch.focus();
    composer?.open(ANCHOR);
    const elsewhere = opener();
    elsewhere.focus();

    composer?.close();

    assert.ok(active() === elsewhere, 'the close took focus from where the reporter put it');
  });

  it('wraps Tab from a focused control that left the cycle, like a send button disabled in flight', async () => {
    mount(() => new Promise<boolean>(() => {}));
    composer?.open(ANCHOR);
    field().value = 'Le bouton est trop petit';
    sendButton().focus();
    sendButton().click();
    await Promise.resolve();
    assert.equal(sendButton().disabled, true);

    assert.equal(keyOn(sendButton(), 'Tab').defaultPrevented, true);
    assert.ok(active() === field(), 'Tab from the disabled send button left the popover');
  });

  it('brings Tab back in after a click moved focus to the page, in both directions', () => {
    mount(async () => true);
    composer?.open(ANCHOR);
    const outside = opener();

    outside.focus();
    assert.equal(keyOn(outside, 'Tab').defaultPrevented, true);
    assert.ok(active() === field(), 'Tab from the page left the popover behind');

    outside.focus();
    keyOn(outside, 'Tab', true);
    assert.ok(active() === sendButton(), 'Shift+Tab from the page did not come back to the last control');
  });

  it('leaves Tab on the page alone while the popover is closed', () => {
    mount(async () => true);
    composer?.open(ANCHOR);
    composer?.close();
    const outside = opener();
    outside.focus();

    assert.equal(keyOn(outside, 'Tab').defaultPrevented, false);
    assert.ok(active() === outside, 'a closed popover took focus');
  });
});

describe('where the note goes (FRU-123)', () => {
  const WEB = { id: 'dst_web', label: 'Linear · Web' };
  const DESIGN = { id: 'dst_design', label: 'Linear · Design' };
  const OLD = { id: 'dst_old' };

  /** The seam as `embed.ts` fills it: a list a read can change, and a choice that is kept. */
  function choiceOf(initial: readonly Destination[], remembered?: string) {
    let offered = initial;
    let kept = remembered;
    const writes: string[] = [];
    const listeners = new Set<() => void>();

    return {
      writes,
      offer(next: readonly Destination[]) {
        offered = next;
        for (const listener of listeners) listener();
      },
      listeners,
      destinations: {
        offered: () => offered,
        subscribe(listener: () => void) {
          listeners.add(listener);

          return () => listeners.delete(listener);
        },
        remembered: () => kept,
        remember(id: string) {
          kept = id;
          writes.push(id);
        },
      } satisfies DestinationChoice,
    };
  }

  function mountWith(choice?: ReturnType<typeof choiceOf>, onSubmit: ComposerOptions['onSubmit'] = async () => {}) {
    const page = mountPage('<main><button id="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit,
      ...(choice === undefined ? {} : { destinations: choice.destinations }),
    });
    mounted = page;

    return page;
  }

  const line = () => composer?.element.querySelector('[data-fruitback-destination]') as HTMLButtonElement;
  /** What the button says (FRU-607): the whole path for the ear, but the tile drawn for the eye. */
  const said = () =>
    [...line().childNodes]
      .filter((node) => !(node as Element).classList?.contains('fruitback-composer-tile'))
      .map((node) => node.textContent)
      .join('');
  const list = () => composer?.element.querySelector('[data-fruitback-destinations]') as HTMLElement;
  const radios = () => [...list().querySelectorAll('input')] as HTMLInputElement[];
  const notice = () => composer?.element.querySelector('[data-fruitback-destination-gone]')?.textContent ?? '';
  const names = () => [...list().querySelectorAll('label')].map((label) => label.textContent);

  function choose(id: string): void {
    const radio = radios().find((each) => each.value === id) as HTMLInputElement;
    radio.checked = true;
    const EventCtor = (mounted as MountedPage).view as unknown as { Event: typeof Event };
    radio.dispatchEvent(new EventCtor.Event('change', { bubbles: true }));
  }

  async function sent(choice: ReturnType<typeof choiceOf> | undefined): Promise<(string | undefined)[]> {
    const seen: (string | undefined)[] = [];
    mountWith(choice, async (_note, _reporter, destination) => void seen.push(destination));
    composer?.open(ANCHOR);
    sendButton().click();
    await Promise.resolve();

    return seen;
  }

  it('is the composer of FRU-89 when nothing offers a place: no line, and the send names none', async () => {
    assert.deepEqual(await sent(undefined), [undefined]);
    assert.equal(line().hidden, true);
    assert.equal(list().hidden, true);
    assert.equal(radios().length, 0);
    assert.equal(notice(), '');
  });

  it('shows no line for one place, which is every site that sends to one tracker', async () => {
    assert.deepEqual(await sent(choiceOf([WEB])), [undefined]);
    assert.equal(line().hidden, true);
    assert.equal(radios().length, 0);
  });

  it('draws a folded line on the first place, from two places', () => {
    mountWith(choiceOf([WEB, DESIGN]));
    composer?.open(ANCHOR);

    assert.equal(line().hidden, false);
    assert.equal(said(), 'Send to: Linear · Web');
    // In icons, in the foot: the tile of the tool, then the most precise name; the path in the tooltip.
    assert.equal(line().closest('.fruitback-composer-foot') !== null, true);
    assert.equal(line().querySelector('.fruitback-composer-tile')?.textContent, 'L');
    assert.equal(line().querySelector('.fruitback-composer-place-name')?.textContent, 'Web');
    assert.equal(line().title, 'Linear · Web');
    assert.equal(line().getAttribute('aria-expanded'), 'false');
    assert.equal(list().hidden, true);
  });

  it('unfolds to one radio for each place, in the order of the worker, with the first one checked', () => {
    mountWith(choiceOf([WEB, DESIGN, OLD]));
    composer?.open(ANCHOR);
    line().click();

    assert.equal(line().getAttribute('aria-expanded'), 'true');
    assert.equal(list().hidden, false);
    assert.equal(list().getAttribute('role'), 'radiogroup');
    assert.equal(list().getAttribute('aria-label'), 'Where this note goes');
    // A place set before the worker wrote labels has none, and is named by its rank.
    assert.deepEqual(names(), ['Linear · Web', 'Linear · Design', 'Destination 3']);
    assert.deepEqual(
      radios().map((radio) => radio.checked),
      [true, false, false],
    );
    assert.equal(new Set(radios().map((radio) => radio.name)).size, 1, 'the radios are not one group');

    line().click();
    assert.equal(list().hidden, true);
    assert.equal(line().getAttribute('aria-expanded'), 'false');
  });

  it('sends the place chosen, says it on the line, and keeps it at the choice', async () => {
    const choice = choiceOf([WEB, DESIGN]);
    const seen: (string | undefined)[] = [];
    mountWith(choice, async (_note, _reporter, destination) => void seen.push(destination));
    composer?.open(ANCHOR);
    line().click();
    choose(DESIGN.id);

    assert.equal(said(), 'Send to: Linear · Design');
    // Before any send, so a failed send does not lose the choice.
    assert.deepEqual(choice.writes, [DESIGN.id]);

    sendButton().click();
    await Promise.resolve();
    assert.deepEqual(seen, [DESIGN.id]);
  });

  it('opens the next note on the place chosen last, folded', () => {
    mountWith(choiceOf([WEB, DESIGN], DESIGN.id));
    composer?.open(ANCHOR);

    assert.equal(said(), 'Send to: Linear · Design');
    assert.equal(list().hidden, true);
    assert.deepEqual(
      radios().map((radio) => radio.checked),
      [false, true],
    );
  });

  it('does not follow a remembered place that is not offered', async () => {
    // The key is in the localStorage of the page. What it holds chooses among the places the worker
    // offers this reader, and nothing more.
    const seen = await sent(choiceOf([WEB, DESIGN], 'dst_of_another_site'));

    assert.equal(said(), 'Send to: Linear · Web');
    assert.deepEqual(seen, [WEB.id]);
  });

  it('keeps the note and the choice when the send is refused', async () => {
    const choice = choiceOf([WEB, DESIGN]);
    mountWith(choice, async () => false);
    composer?.open(ANCHOR);
    choose(DESIGN.id);
    field().value = 'Une note pour le design';

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Une note pour le design');
    assert.equal(said(), 'Send to: Linear · Design');
  });

  it('follows a list that a read changed under the open popover, and says when its place is gone', () => {
    const choice = choiceOf([WEB, DESIGN, OLD]);
    mountWith(choice);
    composer?.open(ANCHOR);
    choose(DESIGN.id);
    assert.equal(notice(), '');

    // A new place, and the chosen one still there: the choice holds, and there is nothing to say.
    choice.offer([WEB, DESIGN, OLD, { id: 'dst_new', label: 'Linear · Support' }]);
    assert.equal(said(), 'Send to: Linear · Design');
    assert.equal(radios().length, 4);
    assert.equal(notice(), '');

    // An admin took the place off the list. The line goes back to the first one, in words.
    choice.offer([WEB, OLD]);
    assert.equal(said(), 'Send to: Linear · Web');
    assert.match(notice(), /Sending to Linear · Design is no longer possible/);

    // A choice made after that is an answer to the notice.
    choose(OLD.id);
    assert.equal(notice(), '');
  });

  it('removes the line when the reader may no longer choose, and the send then names no place', async () => {
    const choice = choiceOf([WEB, DESIGN]);
    const seen: (string | undefined)[] = [];
    mountWith(choice, async (_note, _reporter, destination) => void seen.push(destination));
    composer?.open(ANCHOR);
    line().click();
    choose(DESIGN.id);

    choice.offer([]);

    assert.equal(line().hidden, true);
    assert.equal(list().hidden, true);
    assert.equal(radios().length, 0);
    assert.match(notice(), /Sending to Linear · Design is no longer possible/);

    sendButton().click();
    await Promise.resolve();
    assert.deepEqual(seen, [undefined]);
  });

  it('says nothing when the list keeps only the place the line showed: one place is the default', () => {
    const choice = choiceOf([WEB, DESIGN]);
    mountWith(choice);
    composer?.open(ANCHOR);
    choose(DESIGN.id);

    choice.offer([DESIGN]);

    assert.equal(line().hidden, true);
    assert.equal(notice(), '');
  });

  it('says nothing about a list that changed while the popover was closed, or at the next open', () => {
    const choice = choiceOf([WEB, DESIGN]);
    mountWith(choice);
    composer?.open(ANCHOR);
    choose(DESIGN.id);
    composer?.close();

    choice.offer([WEB, OLD]);
    assert.equal(notice(), '');

    composer?.open(ANCHOR);
    assert.equal(notice(), '');
    assert.equal(said(), 'Send to: Linear · Web');
  });

  it('writes the name of a place as text, never as markup', () => {
    // The name is what somebody called a team in a tracker.
    mountWith(choiceOf([{ id: 'dst_x', label: '<img src=x onerror=alert(1)>' }, DESIGN]));
    composer?.open(ANCHOR);

    assert.equal(composer?.element.querySelector('img'), null);
    assert.equal(said(), 'Send to: <img src=x onerror=alert(1)>');
    assert.equal(names()[0], '<img src=x onerror=alert(1)>');
  });

  it('takes the tool from the start of the path and the most precise name from its end (FRU-607)', () => {
    assert.deepEqual(placeParts('Linear · Design · Website'), { tool: 'Linear', name: 'Website' });
    assert.deepEqual(placeParts('Linear · Design'), { tool: 'Linear', name: 'Design' });
    assert.deepEqual(placeParts('GitHub · acme/site'), { tool: 'GitHub', name: 'acme/site' });
    // A place the worker named in one word, or not at all, is its own tool and name.
    assert.deepEqual(placeParts('Destination 2'), { tool: 'Destination 2', name: 'Destination 2' });
  });

  it('keeps the unfolded list in the Tab cycle of the dialog, and out of it while folded', () => {
    const page = mountWith(choiceOf([WEB, DESIGN]));
    composer?.open(ANCHOR);
    const cycle = () => focusables(composer?.element as HTMLElement);

    assert.equal(cycle().includes(line()), true);
    assert.equal(
      cycle().some((element) => radios().includes(element as HTMLInputElement)),
      false,
    );

    line().click();
    assert.equal(
      cycle().some((element) => radios().includes(element as HTMLInputElement)),
      true,
    );
    // Unfolding puts the reader on the place that is chosen.
    assert.equal(deepActiveElement(page.document), radios()[0]);
  });

  it('stops following the list when it is destroyed', () => {
    const choice = choiceOf([WEB, DESIGN]);
    mountWith(choice);
    assert.equal(choice.listeners.size, 1);

    composer?.destroy();
    composer = null;
    assert.equal(choice.listeners.size, 0);
  });

  it('hides the folded line and list with a rule of their own, because their class sets a display', () => {
    // happy-dom does no layout. A class that sets `display` beats the browser's rule for `hidden`.
    mountWith(choiceOf([WEB, DESIGN]));
    const styles = stylesIn((mounted as MountedPage).document);

    assert.match(styles, /\.fruitback-composer-places\[hidden\] \{ display: none; \}/);
    assert.match(styles, /\.fruitback-composer-destination\[hidden\] \{ display: none; \}/);
  });
});

describe('the batch: send alone or together (FRU-608)', () => {
  const keepButton = () => composer?.element.querySelector('[data-fruitback-keep]') as HTMLButtonElement;
  const more = () => composer?.element.querySelector('[data-fruitback-send-more]') as HTMLButtonElement;
  const menu = () => composer?.element.querySelector('[data-fruitback-send-menu]') as HTMLElement;
  const q = <T extends Element = HTMLElement>(selector: string) => composer?.element.querySelector(selector) as T;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is offered only while the worker takes several notes, asked at each open', () => {
    let offered = false;
    mount(async () => true, { batch: batchOf({ offered: () => offered }) });

    composer?.open(ANCHOR);
    assert.equal(keepButton().hidden, true);
    composer?.close();
    offered = true;
    composer?.open(ANCHOR);
    assert.equal(keepButton().hidden, false);
  });

  it('is not there at all for a host that gives no batch', () => {
    mount(async () => true);
    composer?.open(ANCHOR);

    assert.equal(keepButton().hidden, true);
    assert.equal(more().hidden, true);
  });

  it('with none waiting: « Send », and « Add to batch » as an icon named in its tooltip', () => {
    mount(async () => true, { batch: batchOf() });
    composer?.open(ANCHOR);
    assert.equal(sendButton().textContent, 'Send');
    assert.ok(keepButton().querySelector('svg.fruitback-icon'));
    assert.equal(keepButton().title, 'Add to batch');
    assert.equal(keepButton().textContent, 'Add to batch', 'its name, for a screen reader');
    assert.equal(more().hidden, true, 'no menu with nothing to choose');
  });

  it('with two waiting: « Send all 3 », the count on the icon, and a menu for « Send only this note »', async () => {
    let waiting = 2;
    const listeners: (() => void)[] = [];
    const sentAlone: string[] = [];
    const sentTogether: string[] = [];
    mount(async (note) => void sentAlone.push(note), {
      batch: batchOf({
        count: () => waiting,
        subscribe: (listener) => (listeners.push(listener), () => {}),
        sendAll: async (note) => (sentTogether.push(note), { sent: [{ id: 'a', text: note }], unsent: [] }),
      }),
    });
    composer?.open(ANCHOR);
    assert.equal(sendButton().textContent, 'Send all 3');
    assert.equal(keepButton().title, 'Add to batch · 2 waiting');
    assert.equal(q('.fruitback-composer-badge').textContent, '2');
    assert.equal(more().hidden, false);
    assert.equal(more().getAttribute('aria-haspopup'), 'menu');

    more().click();
    assert.equal(menu().hidden, false);
    assert.deepEqual(
      [...menu().querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
      ['Send all 3', 'Send only this note'],
    );
    assert.equal(deepActiveElement((mounted as MountedPage).document), q('[data-fruitback-send-all]'));

    // « Send only this note » sends it alone, and leaves the batch in place.
    field().value = 'Seule';
    q<HTMLButtonElement>('[data-fruitback-send-only]').click();
    await settle();
    assert.deepEqual(sentAlone, ['Seule']);
    assert.deepEqual(sentTogether, []);
    composer?.close();

    // A note added elsewhere: the foot counts it at once.
    waiting = 3;
    for (const listener of listeners) listener();
    composer?.open(ANCHOR);
    assert.equal(sendButton().textContent, 'Send all 4');
    field().value = 'Ensemble';
    sendButton().click();
    await settle();
    assert.deepEqual(sentTogether, ['Ensemble']);
  });

  it('says « Sending 2 of 3… » while the batch goes, freezes the text, and closes on nothing', async () => {
    let progress: (done: number, total: number) => void = () => {};
    let finish: (value: BatchSent) => void = () => {};
    mount(async () => true, {
      batch: batchOf({
        count: () => 2,
        sendAll: (_note, _reporter, _destination, _files, told) => {
          progress = told;
          return new Promise((resolve) => (finish = resolve));
        },
      }),
    });
    composer?.open(ANCHOR);
    field().value = 'La troisième';
    sendButton().click();
    await settle();
    assert.equal(composer?.state(), 'sending');
    assert.equal(statusText(), 'Sending 1 of 3…');
    progress(1, 3);
    assert.equal(statusText(), 'Sending 2 of 3…');
    assert.equal(field().readOnly, true);
    assert.equal(field().value, 'La troisième', 'the text is still there to read');
    assert.equal(cancelButton().disabled, true);
    composer?.close();
    press('Escape');
    assert.equal(composer?.element.hidden, false, 'a batch on its way closed the composer');

    finish({
      sent: [
        { id: 'a', text: 'Une' },
        { id: 'b', text: 'Deux' },
        { id: 'c', text: 'La troisième' },
      ],
      unsent: [],
    });
    await settle();
    assert.equal(composer?.state(), 'receipt');
  });

  it('gives a receipt: « 3 notes sent », where, each ticket with its link, and « Close »', async () => {
    mount(async () => true, {
      batch: batchOf({
        count: () => 2,
        sendAll: async () => ({
          sent: [
            { id: 'a', text: 'Une', identifier: 'WEB-1', url: 'https://linear.app/x/WEB-1' },
            { id: 'b', text: 'Deux', identifier: 'WEB-2' },
            { id: 'c', text: '<img src=x onerror=alert(1)>' },
          ],
          unsent: [],
        }),
      }),
    });
    composer?.open(ANCHOR);
    sendButton().click();
    await settle();
    const receipt = q('[data-fruitback-receipt]');
    assert.equal(receipt.hidden, false);
    assert.equal(composer?.element.dataset.fruitbackState, 'receipt');
    assert.equal(q('[data-fruitback-receipt-title]').textContent, '3 notes sent');
    assert.equal(q('[data-fruitback-receipt-to]').textContent, 'Sent to the team');
    const rows = [...receipt.querySelectorAll('[data-fruitback-receipt-row]')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('.fruitback-composer-receipt-id')?.textContent),
      ['WEB-1', 'WEB-2', 'Sent'],
    );
    assert.equal(rows[0]?.querySelector('a')?.getAttribute('href'), 'https://linear.app/x/WEB-1');
    assert.equal(rows[1]?.querySelector('a'), null, 'a link to an issue the reader may not open');
    assert.equal(receipt.querySelector('img'), null, 'a note was written as markup');
    // The list is a region the keyboard reaches, named.
    const region = q('[data-fruitback-receipt-region]');
    assert.equal(region.getAttribute('role'), 'region');
    assert.equal(region.getAttribute('tabindex'), '0');
    assert.equal(region.getAttribute('aria-label'), 'Notes of this send');
    assert.equal(q<HTMLButtonElement>('[data-fruitback-receipt-retry]').hidden, true);
    assert.equal(
      q<HTMLButtonElement>('[data-fruitback-receipt-all]').hidden,
      true,
      'a small batch fits in the receipt',
    );
    q<HTMLButtonElement>('[data-fruitback-receipt-close]').click();
    assert.equal(composer?.element.hidden, true);
  });

  it('says « 2 sent, 1 not sent », keeps the text of the one that did not go, and sends it again', async () => {
    let tries = 0;
    let shown = 0;
    mount(async () => true, {
      batch: batchOf({
        count: () => 2,
        sendAll: async () => ({
          sent: [
            { id: 'a', text: 'Une', identifier: 'WEB-1' },
            { id: 'b', text: 'Deux', identifier: 'WEB-2' },
          ],
          unsent: [{ id: 'c', text: 'La troisième, entière' }],
          failure: 'wait',
        }),
        resend: async () => (
          (tries += 1),
          { sent: [{ id: 'c', text: 'La troisième, entière', identifier: 'WEB-3' }], unsent: [] }
        ),
        onShowAll: () => (shown += 1),
      }),
    });
    composer?.open(ANCHOR);
    sendButton().click();
    await settle();
    assert.equal(q('[data-fruitback-receipt-title]').textContent, '2 sent, 1 not sent');
    assert.match(q('[data-fruitback-receipt-status]').textContent ?? '', /Too many notes just now/);
    const unsent = q('[data-fruitback-receipt-row="unsent"]');
    assert.equal(unsent.querySelector('.fruitback-composer-receipt-text')?.textContent, 'La troisième, entière');
    assert.equal(unsent.querySelector('.fruitback-composer-receipt-id')?.textContent, 'Not sent');
    assert.equal(unsent.querySelector('button')?.textContent, 'Copy text');
    const retry = q<HTMLButtonElement>('[data-fruitback-receipt-retry]');
    assert.equal(retry.hidden, false);
    assert.equal(retry.textContent, 'Send again');

    retry.click();
    await settle();
    assert.equal(tries, 1);
    assert.equal(q('[data-fruitback-receipt-title]').textContent, '3 notes sent');
    assert.equal(q('[data-fruitback-receipt-row="unsent"]'), null);
    assert.equal(retry.hidden, true);
    assert.equal(shown, 0);
  });

  it('offers « Show all in the sidebar » for a big batch, which closes the receipt and opens the list', async () => {
    let shown = 0;
    const many = Array.from({ length: 12 }, (_, n) => ({ id: `n${n}`, text: `Note ${n}`, identifier: `WEB-${n}` }));
    mount(async () => true, {
      batch: batchOf({
        count: () => 11,
        sendAll: async () => ({ sent: many, unsent: [] }),
        onShowAll: () => (shown += 1),
      }),
    });
    composer?.open(ANCHOR);
    sendButton().click();
    await settle();
    assert.equal(q('[data-fruitback-receipt-title]').textContent, '12 notes sent');
    const all = q<HTMLButtonElement>('[data-fruitback-receipt-all]');
    assert.equal(all.hidden, false);
    assert.equal(all.textContent, 'Show all in the sidebar');
    all.click();
    assert.equal(shown, 1);
    assert.equal(composer?.element.hidden, true);
  });

  it('keeps the text in the field when the note with files that goes first fails', async () => {
    mount(async () => true, {
      batch: batchOf({
        count: () => 1,
        sendAll: async () => ({ sent: [], unsent: [], failure: 'retry', inField: true }),
      }),
    });
    composer?.open(ANCHOR);
    field().value = 'Avec un fichier';
    sendButton().click();
    await settle();
    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Avec un fichier');
    assert.match(failedText(), /Not sent/);
  });

  it('adds the note to the batch rather than send it, says so, and keeps the text when adding fails', async () => {
    const sent: string[] = [];
    const kept: string[] = [];
    let answer: true | SendFailure = 'retry';
    mount(async (note) => void sent.push(note), {
      batch: batchOf({ add: async (note) => (kept.push(note), answer) }),
    });
    composer?.open(ANCHOR);
    field().value = 'Pour le lot';

    keepButton().click();
    await settle();
    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Pour le lot');

    answer = true;
    keepButton().click();
    await settle();
    assert.equal(composer?.state(), 'kept');
    assert.equal(statusText(), 'Added to the batch');
    assert.equal(sendButton().disabled, true);
    assert.equal(keepButton().disabled, true);
    assert.deepEqual(kept, ['Pour le lot', 'Pour le lot']);
    assert.deepEqual(sent, [], 'adding a note to the batch sent it');
  });
});

describe('« Sign in to send » (FRU-609)', () => {
  it('waits for the sign-in with the note in place, says why, and sends once signed in', async () => {
    let signedOut = true;
    let asked = 0;
    const sent: string[] = [];
    const kept: string[] = [];
    mount(async (note) => void sent.push(note), {
      batch: batchOf({ add: async (note) => (kept.push(note), true) }),
    });
    composer?.destroy();
    const page = mounted as MountedPage;
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async (note) => void sent.push(note),
      batch: batchOf({ add: async (note) => (kept.push(note), true) }),
      signInToSend: () => signedOut,
      onSignIn: () => (asked += 1),
    });
    composer.open(ANCHOR);
    field().value = 'Écrite avant la connexion';
    const notice = composer.element.querySelector('[data-fruitback-sign-needed]') as HTMLElement;
    const signIn = composer.element.querySelector('[data-fruitback-sign-in]') as HTMLButtonElement;
    assert.equal(sendButton().textContent, 'Sign in to send');
    assert.equal(sendButton().disabled, true);
    assert.equal(notice.hidden, false);
    assert.equal(notice.textContent, 'Only the team of this site can send notes here.');
    assert.equal(signIn.hidden, false);
    signIn.click();
    assert.equal(asked, 1);
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, [], 'a reader who must sign in sent a note');

    // Signed in: the composer, still open, has everything, and « Send » goes.
    signedOut = false;
    composer.signInChanged();
    assert.equal(field().value, 'Écrite avant la connexion');
    assert.equal(sendButton().textContent, 'Send');
    assert.equal(sendButton().disabled, false);
    assert.equal(notice.hidden, true);
    assert.equal(signIn.hidden, true);
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ['Écrite avant la connexion']);
  });

  it('still adds a note to the batch while signed out: it goes once the reader is back', async () => {
    const kept: string[] = [];
    mount(async () => true, { batch: batchOf({ add: async (note) => (kept.push(note), true) }) });
    composer?.destroy();
    const page = mounted as MountedPage;
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async () => true,
      batch: batchOf({ add: async (note) => (kept.push(note), true) }),
      signInToSend: () => true,
    });
    composer.open(ANCHOR);
    field().value = 'Pour plus tard';
    const keep = composer.element.querySelector('[data-fruitback-keep]') as HTMLButtonElement;
    assert.equal(keep.disabled, false);
    keep.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(kept, ['Pour plus tard']);
  });
});

describe('the text being written, saved as it is typed (FRU-311)', () => {
  /** What the host would keep, for the one element of these tests. */
  function saved() {
    const writes: string[] = [];
    let text: string | undefined;

    return {
      writes,
      autosave: {
        read: () => text,
        write: (next: string) => {
          writes.push(next);
          text = next === '' ? undefined : next;
        },
      },
    };
  }

  function type(value: string): void {
    field().value = value;
    const EventCtor = (mounted as MountedPage).view as unknown as { Event: typeof Event };
    field().dispatchEvent(new EventCtor.Event('input', { bubbles: true }));
  }

  it('writes each change of the field', () => {
    const { writes, autosave } = saved();
    mount(async () => true, { autosave });
    composer?.open(ANCHOR);

    type('Le prix');
    type('Le prix du Latte');

    assert.deepEqual(writes, ['Le prix', 'Le prix du Latte']);
  });

  for (const [way, leave] of [
    ['Esc', () => press('Escape')],
    ['Cancel', () => cancelButton().click()],
  ] as const) {
    it(`gives the text back after ${way}, and says « Draft restored »`, () => {
      const { autosave } = saved();
      mount(async () => true, { autosave });
      composer?.open(ANCHOR);
      type('Le prix devrait être 18 €');

      leave();
      assert.equal(composer?.element.hidden, true);
      composer?.open(ANCHOR);

      assert.equal(field().value, 'Le prix devrait être 18 €');
      assert.equal(statusText(), 'Draft restored');
      assert.equal(composer?.state(), 'idle');
      // The sentence goes once the person types again.
      type('Le prix devrait être 18 €, pas 19 €');
      assert.equal(statusText(), '');
    });
  }

  it('opens empty and silent when nothing was saved', () => {
    const { writes, autosave } = saved();
    mount(async () => true, { autosave });
    composer?.open(ANCHOR);
    press('Escape');

    assert.equal(field().value, '');
    assert.equal(statusText(), '');
    assert.deepEqual(writes, [], 'a composer opened and closed with nothing typed saved something');
  });

  it('says « Brouillon restauré » in French', () => {
    const { autosave } = saved();
    autosave.write('Une note');
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async () => true,
      autosave,
      translator: createTranslator({ language: 'fr' }),
    });
    composer.open(ANCHOR);

    assert.equal(statusText(), 'Brouillon restauré');
  });
});

describe('a send refused for a session that ended (FRU-315)', () => {
  const signInButton = () => composer?.element.querySelector('[data-fruitback-sign-in]') as HTMLButtonElement;

  it('offers « Sign in again » beside its sentence, and keeps the text', async () => {
    const asked: number[] = [];
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    mounted = page;
    composer = createComposer({
      document: page.document,
      host,
      onSubmit: async () => 'signed-out',
      onSignIn: () => asked.push(1),
    });
    composer.open(ANCHOR);
    field().value = 'Une note gardée';
    assert.equal(signInButton().hidden, true);

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(signInButton().hidden, false);
    assert.equal(signInButton().textContent, 'Sign in again');
    signInButton().click();
    assert.deepEqual(asked, [1]);
    assert.equal(field().value, 'Une note gardée');
  });

  it('offers nothing for another failure, nor without a sign-in to open', async () => {
    mount(async () => 'retry');
    composer?.open(ANCHOR);
    field().value = 'x';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(signInButton().hidden, true);

    composer?.destroy();
    mount(async () => 'signed-out');
    composer?.open(ANCHOR);
    field().value = 'x';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      failedText(),
      'Not sent Your session has ended. Your text is still here. Sign in again, then send it.',
    );
    assert.equal(signInButton().hidden, true);
  });
});
