import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedReporter } from '@fruitback/shared';
import {
  type Composer,
  type ComposerOptions,
  type DestinationChoice,
  type SendFailure,
  type SentWithoutPicture,
  createComposer,
} from './composer.ts';
import type { Destination } from './destinations.ts';
import { deepActiveElement, focusables } from './focus.ts';
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

function mount(
  onSubmit: (note: string, reporter?: SeedReporter) => Promise<boolean | void | SendFailure | SentWithoutPicture>,
  more: Pick<ComposerOptions, 'memory' | 'identified' | 'keep' | 'picture' | 'onClose'> = {},
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
const closeButton = () => composer?.element.querySelector('[data-fruitback-close]') as HTMLButtonElement;
const statusText = () => composer?.element.querySelector('[data-fruitback-status]')?.textContent ?? '';

describe('what the popover looks like (FRU-36)', () => {
  it('writes Send alone, and draws the cross that closes without sending (FRU-258)', () => {
    // The icon is appended after the template is parsed, because an SVG written into an innerHTML
    // string lands in the HTML namespace and renders nothing at all. It is aria-hidden, so the
    // name of the cross is its label alone.
    mount(async () => {});

    // The mock-up writes the word and no drop: the drop is the mark of the launch button and of the pins.
    assert.equal(sendButton().querySelector('svg'), null);
    assert.equal(sendButton().textContent, 'Send');
    assert.ok(closeButton().querySelector('svg.fruitback-icon'), 'the cross is not drawn');
    assert.equal(closeButton().textContent, '');
    assert.equal(closeButton().getAttribute('aria-label'), 'Close without sending');
  });

  it('has a head: its title, and what the note is about when the element says something (FRU-258)', () => {
    mount(async () => {});
    const title = () => composer?.element.querySelector('[data-fruitback-title]') as HTMLElement;
    const about = () => composer?.element.querySelector('[data-fruitback-about]') as HTMLElement;

    composer?.open(ANCHOR, 'Fell shell jacket');
    assert.equal(title().textContent, 'New note');
    assert.equal(about().textContent, 'on Fell shell jacket');
    assert.equal(about().hidden, false);

    // An element with no text: the title alone, and no « on » left hanging.
    composer?.close();
    composer?.open(ANCHOR);
    assert.equal(about().textContent, '');
    assert.equal(about().hidden, true);

    // As text: it is whatever the page wrote in its element.
    composer?.close();
    composer?.open(ANCHOR, '<img src=x onerror=alert(1)>');
    assert.equal(about().textContent, 'on <img src=x onerror=alert(1)>');
    assert.equal(about().querySelector('img'), null);
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
    assert.equal(composer?.element.querySelector('[data-fruitback-about]')?.textContent, 'on The second element');
    assert.equal(composer?.element.style.getPropertyValue('--fruitback-composer-left'), '394px');

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
    assert.match(statusText(), /did not go through/);
  });

  it('closes on the cross like on Cancel, and gives the note up', () => {
    let closed = 0;
    mount(async () => true, { onClose: () => (closed += 1) });
    composer?.open(ANCHOR);
    field().value = 'Une note';

    closeButton().click();

    assert.equal(composer?.element.hidden, true);
    assert.equal(closed, 1);
  });

  it('confirms in words, with no strawberry in front of them', async () => {
    mount(async () => {});
    composer?.open(ANCHOR);

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(statusText(), 'sent');
  });

  it('says when the note went without the picture it asked for (FRU-238)', async () => {
    mount(async () => ({ picture: 'missed' as const }));
    composer?.open(ANCHOR);
    field().value = 'Une note';

    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer?.state(), 'sent');
    assert.equal(statusText(), 'sent, without the picture');
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
    assert.match(statusText(), /sending/);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'sent');
    // The word the product uses, not "sent".
    assert.match(statusText(), /^sent$/);
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
      said[failure] = statusText();
      composer?.destroy();
      composer = null;
    }

    assert.equal(said.retry, 'did not go through — your text is kept, try again');
    assert.match(said.wait ?? '', /in a minute/);
    assert.match(said.refused ?? '', /tell the team of the site/);
    assert.match(said['too-large'] ?? '', /shorten it/);
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
    assert.equal(field().getAttribute('aria-label'), 'What should change?');
    assert.equal(field().placeholder, 'What should change?');
  });

  it('writes a host translation as text, never as markup (FRU-37)', () => {
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

  it('opens on the element’s start edge, which is its right in a right-to-left language (FRU-38)', () => {
    const anchor = { left: 500, top: 200, bottom: 240, right: 700 };
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

    // On the edge of the frame, which stands 6 px off the element (FRU-258).
    assert.equal(placedLeft(createTranslator()), '494px');
    // 706 minus the popover's 360: its right edge sits on the right edge of the frame.
    assert.equal(
      placedLeft(createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } })),
      '346px',
    );
  });

  it('stays inside the window when the page is scrolled sideways (FRU-68)', () => {
    const placedLeft = (
      anchor: { left: number; top: number; bottom: number; right: number },
      translator = createTranslator(),
    ) => {
      const page = mountPage('<main></main>', { width: 1_000, height: 1_000 });
      page.view.scrollTo(1_500, 0);
      const host = page.document.createElement('div');
      page.document.body.append(host);
      const opened = createComposer({ document: page.document, host, onSubmit: async () => true, translator });
      opened.open(anchor);
      const left = opened.element.style.getPropertyValue('--fruitback-composer-left');
      opened.destroy();

      return left;
    };

    // The element is on screen at document x 2000, so the popover opens there.
    assert.equal(placedLeft({ left: 2_000, top: 200, bottom: 240, right: 2_100 }), '1994px');
    // Near the right edge of the window it stops 10px short of it: 1500 + 1000 - 360 - 10.
    assert.equal(placedLeft({ left: 2_400, top: 200, bottom: 240, right: 2_450 }), '2130px');
    // Right to left, near the left edge of the window, it stops 10px after it: 1500 + 10.
    assert.equal(
      placedLeft(
        { left: 1_520, top: 200, bottom: 240, right: 1_600 },
        createTranslator({ locale: 'ar', messages: { ar: { 'composer.send': 'أرسل' } } }),
      ),
      '1510px',
    );
  });

  it('opens above its element, 40 px over its top, and below when there is no room above (FRU-258)', () => {
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

    // 600 − 40 − 240: its bottom edge ends 40 px over the element, the name of the component between them.
    assert.deepEqual(placed({ left: 100, top: 600, bottom: 640, right: 300 }), { top: '320px', side: 'above' });
    // No room above: under the frame, 6 px off the element, and 10 px more.
    assert.deepEqual(placed({ left: 100, top: 200, bottom: 240, right: 300 }), { top: '256px', side: 'below' });
    // The window, not the document, says what room there is: scrolled, the same element has none above.
    assert.deepEqual(placed({ left: 100, top: 600, bottom: 640, right: 300 }, 400), { top: '656px', side: 'below' });
    // Room on neither side, for an element as tall as the window: it stays in the window, at its bottom.
    assert.deepEqual(placed({ left: 100, top: 100, bottom: 950, right: 300 }), { top: '750px', side: 'below' });
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
    assert.equal(label().textContent?.trim(), 'Attach a picture of this element');
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
    assert.equal(page.document.querySelector('[type="email"]'), null);
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
    assert.equal(query(page, '[data-fruitback-who]').hidden, false, 'the name the note is signed with is hidden');
    assert.equal(query(page, '[data-fruitback-identify]').getAttribute('aria-expanded'), 'true');
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
    const seen: (SeedReporter | undefined)[] = [];
    const { memory, writes } = memoryHolding('Alice');
    const { page } = mount(async (_note, reporter) => void seen.push(reporter), { memory, identified: true });
    composer?.open(ANCHOR);

    assert.equal(query(page, '[data-fruitback-identify]').hidden, true);
    assert.equal(query(page, '[data-fruitback-who]').hidden, true);
    await send(page);

    assert.deepEqual(seen, [undefined]);
    assert.deepEqual(writes, []);
  });

  it('asks whether the worker names the reporter at each open, and never under an open composer (FRU-112)', async () => {
    // In team mode the widget learns it from a read, after the composer is built, and a session ends.
    const seen: (SeedReporter | undefined)[] = [];
    let identified = false;
    const { page } = mount(async (_note, reporter) => void seen.push(reporter), { identified: () => identified });
    const asked = () => !query(page, '[data-fruitback-identify]').hidden;

    composer?.open(ANCHOR);
    assert.equal(asked(), true);
    query(page, '[data-fruitback-identify]').click();
    input(page, '[data-fruitback-name]').value = 'Alice';

    // The answer changes while somebody types: the field stays, and the note goes with the name.
    identified = true;
    composer?.identityChanged();
    assert.equal(asked(), true);
    assert.equal(query(page, '[data-fruitback-who]').hidden, false);
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
    // The cross of the head is the first control (FRU-258); the note field keeps the focus of the open.
    assert.ok(active() === closeButton(), 'Tab on the last control did not go back to the first');

    assert.equal(keyOn(closeButton(), 'Tab', true).defaultPrevented, true);
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

    assert.ok(active() === closeButton(), 'the disabled send button is still in the cycle');
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
    assert.ok(active() === closeButton(), 'Tab from the disabled send button left the popover');
  });

  it('brings Tab back in after a click moved focus to the page, in both directions', () => {
    mount(async () => true);
    composer?.open(ANCHOR);
    const outside = opener();

    outside.focus();
    assert.equal(keyOn(outside, 'Tab').defaultPrevented, true);
    assert.ok(active() === closeButton(), 'Tab from the page left the popover behind');

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
    assert.equal(line().textContent, 'Send to: Linear · Web');
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

    assert.equal(line().textContent, 'Send to: Linear · Design');
    // Before any send, so a failed send does not lose the choice.
    assert.deepEqual(choice.writes, [DESIGN.id]);

    sendButton().click();
    await Promise.resolve();
    assert.deepEqual(seen, [DESIGN.id]);
  });

  it('opens the next note on the place chosen last, folded', () => {
    mountWith(choiceOf([WEB, DESIGN], DESIGN.id));
    composer?.open(ANCHOR);

    assert.equal(line().textContent, 'Send to: Linear · Design');
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

    assert.equal(line().textContent, 'Send to: Linear · Web');
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
    assert.equal(line().textContent, 'Send to: Linear · Design');
  });

  it('follows a list that a read changed under the open popover, and says when its place is gone', () => {
    const choice = choiceOf([WEB, DESIGN, OLD]);
    mountWith(choice);
    composer?.open(ANCHOR);
    choose(DESIGN.id);
    assert.equal(notice(), '');

    // A new place, and the chosen one still there: the choice holds, and there is nothing to say.
    choice.offer([WEB, DESIGN, OLD, { id: 'dst_new', label: 'Linear · Support' }]);
    assert.equal(line().textContent, 'Send to: Linear · Design');
    assert.equal(radios().length, 4);
    assert.equal(notice(), '');

    // An admin took the place off the list. The line goes back to the first one, in words.
    choice.offer([WEB, OLD]);
    assert.equal(line().textContent, 'Send to: Linear · Web');
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
    assert.equal(line().textContent, 'Send to: Linear · Web');
  });

  it('writes the name of a place as text, never as markup', () => {
    // The name is what somebody called a team in a tracker.
    mountWith(choiceOf([{ id: 'dst_x', label: '<img src=x onerror=alert(1)>' }, DESIGN]));
    composer?.open(ANCHOR);

    assert.equal(composer?.element.querySelector('img'), null);
    assert.equal(line().textContent, 'Send to: <img src=x onerror=alert(1)>');
    assert.equal(names()[0], '<img src=x onerror=alert(1)>');
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
    const styles = (mounted as MountedPage).document.querySelector('style')?.textContent ?? '';

    assert.match(styles, /\.fruitback-composer-places\[hidden\] \{ display: none; \}/);
    assert.match(styles, /\.fruitback-composer-identify\[hidden\] \{ display: none; \}/);
  });
});

describe('keep for later (FRU-124)', () => {
  const keepButton = () => composer?.element.querySelector('[data-fruitback-keep]') as HTMLButtonElement;

  it('is offered only while the worker takes several notes, asked at each open', () => {
    let offered = false;
    mount(async () => true, { keep: { offered: () => offered, onKeep: async () => true } });

    composer?.open(ANCHOR);
    assert.equal(keepButton().hidden, true);
    composer?.close();
    offered = true;
    composer?.open(ANCHOR);
    assert.equal(keepButton().hidden, false);
    assert.equal(keepButton().textContent, 'Keep for later');
  });

  it('is not there at all for a host that gives no way to keep a note', () => {
    mount(async () => true);
    composer?.open(ANCHOR);

    assert.equal(keepButton().hidden, true);
  });

  it('keeps the note rather than send it, says so, and keeps the text when keeping fails', async () => {
    const sent: string[] = [];
    const kept: string[] = [];
    let answer: true | SendFailure = 'retry';
    mount(async (note) => void sent.push(note), {
      keep: { offered: () => true, onKeep: async (note) => (kept.push(note), answer) },
    });
    composer?.open(ANCHOR);
    field().value = 'Pour plus tard';

    keepButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'failed');
    assert.equal(field().value, 'Pour plus tard');

    answer = true;
    keepButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(composer?.state(), 'kept');
    assert.equal(statusText(), 'kept for later');
    assert.equal(sendButton().disabled, true);
    assert.equal(keepButton().disabled, true);
    assert.deepEqual(kept, ['Pour plus tard', 'Pour plus tard']);
    assert.deepEqual(sent, [], 'keeping a note sent it');
  });
});
