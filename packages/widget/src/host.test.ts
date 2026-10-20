import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CaptureEngine } from './engine.ts';
import { type CaptureHost, type CaptureTarget, createCaptureHost, shortSelector } from './host.ts';
import { type MountedPage, keyboardEventCtor, mouseEventCtor, mountPage, pressKey } from './dom.fixture.ts';
import { deepActiveElement } from './focus.ts';
import { createTranslator } from './messages.ts';

/**
 * The engine is faked here on purpose. happy-dom has no layout and no `elementsFromPoint`, so asking
 * it to hit-test would test happy-dom; what these check is the host's own behaviour — what it puts in
 * the Shadow root, what it refuses to point at, and what it hands back.
 */

const PAGE = '<main><button id="cta">Commander</button><p id="prose">Du texte</p></main>';

let host: CaptureHost | null = null;

afterEach(() => {
  host?.destroy();
  host = null;
});

/** Reports whatever element the test says is under the pointer, minus what the host rejects. */
function fakeEngine(page: MountedPage, under: () => Element | null): CaptureEngine & { rejected: Element[] } {
  const rejected: Element[] = [];

  return {
    rejected,
    elementAt(_x, _y, reject) {
      const element = under();
      if (element === null) return null;
      if (reject(element)) {
        rejected.push(element);
        return null;
      }

      return element;
    },
    grabbable: () => true,
    boundsOf: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    sourceOf: async () => ({ component: 'CheckoutCta', file: 'src/cta.tsx', line: 12 }),
  };
}

function mount(
  under: () => Element | null,
  onSelect: (target: CaptureTarget) => void = () => {},
  extra: Partial<Parameters<typeof createCaptureHost>[0]> = {},
) {
  const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
  const engine = fakeEngine(page, under);
  host = createCaptureHost({ document: page.document, engine, onSelect, ...extra });

  return { page, engine };
}

const clickAt = (page: MountedPage, target: Element) =>
  target.dispatchEvent(new (mouseEventCtor(page))('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));

const moveOver = (page: MountedPage) =>
  page.document.dispatchEvent(new (mouseEventCtor(page))('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));

/** The host is non-null in every test that reaches for it; `mount` has just built it. */
function launchButton(): HTMLElement {
  const button = host?.root.querySelector('[data-fruitback-host-launch]');
  assert.ok(button, 'the launch button is missing');

  return button as HTMLElement;
}

describe('the chrome the reporter sees (FRU-36)', () => {
  it('names the launch button in words, and draws the seed as a shape', () => {
    // The label used to open with a sprout. An emoji is drawn by the system font, so nothing about
    // it is ours to set — and the accessible name is the label, which is what every E2E spec finds
    // this button by, so the icon has to contribute no text at all.
    mount(() => null);
    const button = launchButton();

    assert.equal(button.textContent, 'Leave feedback');
    assert.ok(button.querySelector('svg.fruitback-icon'), 'the launch button lost its mark');
  });

  it('keeps the mark when the embedder supplies its own label', () => {
    // The label is a string a host passes; setting it through textContent would have taken the icon
    // out with it, which is why the two live in separate nodes.
    mount(
      () => null,
      () => {},
      { label: 'Feedback, please' },
    );
    const button = launchButton();

    assert.equal(button.textContent, 'Feedback, please');
    assert.ok(button.querySelector('svg.fruitback-icon'), 'a custom label removed the mark');
  });

  it('keeps its name while a capture runs, and says it is pressed (FRU-258)', () => {
    // It said « Esc to cancel » while a capture ran. A switch that changes its name says two things
    // at once to a screen reader: the banner holds those words now, and the button holds a state.
    mount(() => null);
    assert.equal(launchButton().getAttribute('aria-pressed'), 'false');

    host?.start();
    assert.equal(launchButton().textContent, 'Leave feedback');
    assert.equal(launchButton().getAttribute('aria-pressed'), 'true');

    host?.stop();
    assert.equal(launchButton().textContent, 'Leave feedback');
    assert.equal(launchButton().getAttribute('aria-pressed'), 'false');
    assert.ok(launchButton().querySelector('svg.fruitback-icon'), 'stopping a capture removed the mark');
  });

  it('says what a capture asks for in the capsule, with the key and the button that stop it (FRU-258, FRU-303)', () => {
    mount(() => null);
    const banner = host?.root.querySelector('[data-fruitback-host-banner]') as HTMLElement;
    const parts = () => [...banner.children].map((part) => `${part.tagName.toLowerCase()}: ${part.textContent}`);

    // In the tree and empty at rest: a live region that was hidden announces nothing when it comes back.
    assert.equal(banner.getAttribute('role'), 'status');
    assert.deepEqual(parts(), []);

    host?.start();
    assert.deepEqual(parts(), [
      'span: Point at an element, or use the arrow keys',
      // Read and not drawn: how a keyboard moves.
      'span: Or move with the arrow keys and press Enter.',
      'button: EscCancel',
    ]);
    // The key is a drawing: the button is named by its word.
    const key = banner.querySelector('kbd');
    assert.equal(key?.getAttribute('aria-hidden'), 'true');
    assert.equal(key?.textContent, 'Esc');
    // The banner is in the capsule of the dock: the way out is where the way in was.
    assert.equal(banner.parentElement, host?.dock);

    host?.stop();
    assert.deepEqual(parts(), []);
  });

  it('stops on the button of the banner, and gives focus back to the launch button (FRU-258)', () => {
    const selected: CaptureTarget[] = [];
    const { page } = mount(
      () => page.query('#cta'),
      (target) => selected.push(target),
    );
    host?.start();
    const stopButton = host?.root.querySelector('.fruitback-banner-stop') as HTMLElement;

    stopButton.click();

    assert.equal(host?.capturing(), false);
    assert.ok(deepActiveElement(page.document) === launchButton(), 'focus did not go back to the launch button');
    // The click was on the widget: it chose nothing.
    assert.equal(selected.length, 0);
  });

  it('says what a tap does on a touch screen, which has no Escape key (FRU-157)', () => {
    const page = mountPage(PAGE, { width: 390, height: 844 });
    const coarse = { value: true };
    Object.defineProperty(page.view, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(pointer: coarse)' && coarse.value }),
    });
    host = createCaptureHost({ document: page.document, engine: fakeEngine(page, () => null), onSelect: () => {} });
    const announcer = host.root.querySelector('[data-fruitback-announcer]');

    const banner = host.root.querySelector('[data-fruitback-host-banner]') as HTMLElement;
    const said = () => [...banner.children].map((part) => part.textContent);

    host.start();
    // No key to name, and no arrows: the sentence and the button, which is the only way out.
    assert.deepEqual(said(), ['Tap the part of the page your note is about', 'Cancel']);
    assert.equal(launchButton().textContent, 'Leave feedback');
    assert.equal(announcer?.textContent, '');
    host.stop();

    // The same device with a mouse plugged in: read again at the next start.
    coarse.value = false;
    host.start();
    assert.equal(said()[0], 'Point at an element, or use the arrow keys');
    assert.match(said()[1] ?? '', /arrow keys/);
    assert.equal(said()[2], 'EscCancel');
  });

  it('keeps the host label over a translated one, before and after a capture (FRU-37)', () => {
    mount(
      () => null,
      () => {},
      {
        label: 'Feedback, please',
        translator: createTranslator({
          locale: 'fr',
          messages: { fr: { 'launch.label': 'Laisser un feedback', 'capture.stop': 'Arrêter' } },
        }),
      },
    );

    assert.equal(launchButton().textContent, 'Feedback, please');
    host?.start();
    assert.equal(launchButton().textContent, 'Feedback, please');
    assert.equal(host?.root.querySelector('.fruitback-banner-stop')?.textContent, 'ÉchapArrêter');
    host?.stop();
    assert.equal(launchButton().textContent, 'Feedback, please');
  });

  it('tells the Shadow root the language and the direction of its words (FRU-38)', () => {
    mount(() => null);
    const container = host?.root.host as HTMLElement;
    assert.equal(container.dir, 'ltr');
    assert.equal(container.lang, 'en');
    host?.destroy();

    mount(
      () => null,
      () => {},
      { translator: createTranslator({ locale: 'ar', messages: { ar: { 'launch.label': 'اترك ملاحظة' } } }) },
    );
    const arabic = host?.root.host as HTMLElement;
    assert.equal(arabic.dir, 'rtl');
    assert.equal(arabic.lang, 'ar');
  });

  it('gives the gear a drawing and a name, and no character', () => {
    mount(
      () => null,
      () => {},
      { onConfigure: () => {} },
    );
    const gear = host?.root.querySelector('[data-fruitback-host-configure]');

    assert.ok(gear?.querySelector('svg.fruitback-icon'), 'the gear is not drawn');
    assert.equal(gear?.textContent, '', 'the gear still carries a character');
    assert.equal(gear?.getAttribute('aria-label'), 'Open Fruitback settings');
  });

  it('stops the reset at the edge of an SVG, or every icon renders empty', () => {
    // Measured in Chromium: under a bare star selector, a path computes d:none and stroke:none —
    // the geometry is a CSS property since SVG2, so all:initial erases the drawing. Nothing throws,
    // nothing logs, and every icon in the widget is an empty box. happy-dom draws nothing, so this
    // asserts the selector; `e2e/host.spec.ts` asserts the pixels.
    const { page } = mount(() => null);
    const sheet = page.document.querySelector('[data-fruitback-host]')?.shadowRoot?.querySelector('style');

    assert.match(sheet?.textContent ?? '', /\*:not\(svg, svg \*\) \{ all: initial;/);
  });
});

describe('createCaptureHost', () => {
  it('puts everything it draws inside a Shadow root', () => {
    // The whole point: the client's CSS cannot reach in, and ours cannot leak out.
    const { page } = mount(() => null);

    const container = page.document.querySelector('[data-fruitback-host]');
    assert.ok(container, 'no host element');
    assert.ok(container.shadowRoot, 'the host has no Shadow root');
    assert.ok(container.shadowRoot.querySelector('[data-fruitback-host-launch]'), 'the launch button leaked out');
    // Nothing of ours in the page's own tree beyond the single empty container.
    assert.equal(page.document.querySelector('.fruitback-launch'), null);
    assert.equal(page.document.querySelector('.fruitback-highlight'), null);
  });

  it('sits at the document origin, so the overlay can position in document coordinates', () => {
    // `createOverlay({ host })` places pins absolutely; an offset or positioned host moves them all.
    const { page } = mount(() => null);
    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;

    assert.equal(container.style.position, 'absolute');
    assert.equal(container.style.top, '0px');
    assert.equal(container.style.left, '0px');
    assert.equal(container.style.width, '0px');
  });

  it('does nothing until the floating button is pressed', () => {
    const { page } = mount(() => page.query('#cta'));
    assert.equal(host?.capturing(), false);

    moveOver(page);
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, '');

    launchButton().click();
    assert.equal(host?.capturing(), true);
  });

  it('highlights the element under the pointer, in document coordinates', () => {
    const { page } = mount(() => page.query('#cta'));
    host?.start();

    moveOver(page);

    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'block');
    // The frame is a line of 2 px, 3 px off the element, as an outline draws it (FRU-303).
    assert.equal(highlight.style.left, '5px');
    assert.equal(highlight.style.top, '15px');
    assert.equal(highlight.style.width, '110px');
    assert.equal(highlight.style.height, '40px');
  });

  it('writes a short selector and the component on the frame, the selector alone without one (FRU-258, FRU-303)', async () => {
    const names: (string | undefined)[] = ['CheckoutCta', undefined, '<b>Bold</b>'];
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    let asked = 0;
    const engine: CaptureEngine = {
      ...fakeEngine(page, () => page.query('#cta')),
      sourceOf: async () => {
        asked += 1;
        const component = names.shift();

        return component === undefined ? undefined : { component };
      },
    };
    host = createCaptureHost({ document: page.document, engine, onSelect: () => {} });
    const tag = host.root.querySelector('.fruitback-highlight-tag') as HTMLElement;
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    host.start();
    moveOver(page);
    await settle();
    assert.equal(tag.hidden, false);
    assert.equal(tag.textContent, 'button#cta · <CheckoutCta>');
    // For the eye: the note carries the name, and a screen reader hears the element.
    assert.equal(tag.getAttribute('aria-hidden'), 'true');
    // The pointer moves on the same element: the engine is asked once.
    moveOver(page);
    moveOver(page);
    await settle();
    assert.equal(asked, 1);

    // A new capture asks again, and a page with no component shows the selector alone.
    host.stop();
    host.start();
    moveOver(page);
    await settle();
    assert.equal(tag.hidden, false);
    assert.equal(tag.textContent, 'button#cta');

    host.stop();
    host.start();
    moveOver(page);
    await settle();
    // As text: a name is whatever the page called its component.
    assert.equal(tag.textContent, 'button#cta · <<b>Bold</b>>');
    assert.equal(tag.querySelector('b'), null);
  });

  it('holds the frame on the element that was chosen, for a caller that asks, until it lets go (FRU-258)', async () => {
    const { page } = mount(
      () => page.query('#cta'),
      (target) => host?.hold(target.element),
    );
    host?.start();
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;

    clickAt(page, page.query('#cta'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(host?.capturing(), false);
    assert.equal(highlight.style.display, 'block');
    assert.equal(highlight.style.left, '5px');
    assert.equal(highlight.querySelector('.fruitback-highlight-tag')?.textContent, 'button#cta · <CheckoutCta>');

    host?.release();
    assert.equal(highlight.style.display, 'none');
  });

  it('gives the frame back to the held element when a capture started over it stops', async () => {
    // The composer is open on an element, and the reporter presses the launch button again, then
    // stops: the frame must be where it was, not gone under an open composer.
    const under: { element: Element | null } = { element: null };
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    const boxes = new Map<Element, { left: number; top: number; width: number; height: number }>([
      [page.query('#cta'), { left: 10, top: 20, width: 100, height: 30 }],
      [page.query('p'), { left: 300, top: 400, width: 50, height: 10 }],
    ]);
    const engine: CaptureEngine = {
      ...fakeEngine(page, () => under.element),
      boundsOf: (element) => boxes.get(element) ?? { left: 0, top: 0, width: 0, height: 0 },
    };
    host = createCaptureHost({ document: page.document, engine, onSelect: () => {} });
    const highlight = host.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    host.hold(page.query('#cta'));
    assert.equal(highlight.style.left, '5px');

    // A second capture borrows the frame for what the pointer is over.
    host.start();
    under.element = page.query('p');
    moveOver(page);
    assert.equal(highlight.style.left, '295px');

    host.stop();
    assert.equal(highlight.style.display, 'block');
    assert.equal(highlight.style.left, '5px');

    host.release();
    assert.equal(highlight.style.display, 'none');
  });

  it('does not give the frame back to the element before when another one is chosen', async () => {
    // The composer is open on the button, a second capture runs, and the reporter chooses the
    // paragraph: the note is about the paragraph now, and the frame of the button must not return.
    const under: { element: Element | null } = { element: null };
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    const boxes = new Map<Element, { left: number; top: number; width: number; height: number }>([
      [page.query('#cta'), { left: 10, top: 20, width: 100, height: 30 }],
      [page.query('p'), { left: 300, top: 400, width: 50, height: 10 }],
    ]);
    const engine: CaptureEngine = {
      ...fakeEngine(page, () => under.element),
      boundsOf: (element) => boxes.get(element) ?? { left: 0, top: 0, width: 0, height: 0 },
    };
    const holds = { next: false };
    host = createCaptureHost({
      document: page.document,
      engine,
      onSelect: (target) => {
        if (holds.next) host?.hold(target.element);
      },
    });
    const highlight = host.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    const choose = async () => {
      host?.hold(page.query('#cta'));
      host?.start();
      under.element = page.query('p');
      clickAt(page, page.query('p'));
      // At the choice, before the caller is told: the frame of the button is not back.
      assert.equal(highlight.style.display, 'none');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    // A caller that holds nothing new: no frame, rather than the frame of another element.
    await choose();
    assert.equal(highlight.style.display, 'none');

    // A caller that holds what was chosen: the frame is on the paragraph.
    holds.next = true;
    await choose();
    assert.equal(highlight.style.display, 'block');
    assert.equal(highlight.style.left, '295px');
  });

  it('takes the frame away at the choice for a caller that holds nothing', async () => {
    // A host that assembles the parts itself, and was written before `hold`: nothing stays on its page.
    const { page } = mount(() => page.query('#cta'));
    host?.start();
    moveOver(page);
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'block');

    clickAt(page, page.query('#cta'));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(highlight.style.display, 'none');
  });

  it('refuses to point at its own UI', async () => {
    // react-grab traverses open Shadow roots, so without the filter the pointer lands on our
    // highlight box instead of the element behind it.
    const { page, engine } = mount(() => host?.root.querySelector('[data-fruitback-host-launch]') ?? null);
    host?.start();

    moveOver(page);

    assert.equal(engine.rejected.length, 1, 'the host did not reject its own button');
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'none');
  });

  it('hands back the element and the source react-grab resolved for it', async () => {
    const selected: CaptureTarget[] = [];
    const { page } = mount(
      () => page.query('#cta'),
      (target) => selected.push(target),
    );
    host?.start();

    clickAt(page, page.query('#cta'));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.element, page.query('#cta'));
    assert.deepEqual(selected[0]?.source, { component: 'CheckoutCta', file: 'src/cta.tsx', line: 12 });
    // One capture per activation: the mode ends with the click.
    assert.equal(host?.capturing(), false);
  });

  it('keeps the page from acting on the click it just intercepted', () => {
    // The reporter is pointing at the site, not using it — a captured click must not submit a form.
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));
    host?.start();

    clickAt(page, page.query('#cta'));

    assert.equal(pageSawIt, false);
  });

  it('lets the page have its clicks back when capture is off', () => {
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));

    clickAt(page, page.query('#cta'));

    assert.equal(pageSawIt, true);
  });

  it('leaves capture mode on Escape', () => {
    const { page } = mount(() => page.query('#cta'));
    host?.start();

    pressKey(page, 'Escape');

    assert.equal(host?.capturing(), false);
    // The key that stops gives focus back to the button that started (FRU-258).
    assert.ok(deepActiveElement(page.document) === launchButton(), 'focus did not go back to the launch button');
  });

  it('takes its host element and its listeners with it when destroyed', () => {
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));
    host?.start();

    host?.destroy();
    host = null;
    clickAt(page, page.query('#cta'));

    assert.equal(page.document.querySelector('[data-fruitback-host]'), null);
    // The listener is gone too, so the page is not left with a widget that swallows clicks.
    assert.equal(pageSawIt, true);
  });
});

describe('selecting an element without a pointer (FRU-51)', () => {
  function mountKeyboard(
    options: {
      grabbable?: (element: Element) => boolean;
      onSelect?: (target: CaptureTarget) => void;
      translator?: ReturnType<typeof createTranslator>;
    } = {},
  ): MountedPage {
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    const engine = { ...fakeEngine(page, () => null), grabbable: options.grabbable ?? (() => true) };
    host = createCaptureHost({
      document: page.document,
      engine,
      onSelect: options.onSelect ?? (() => {}),
      ...(options.translator !== undefined ? { translator: options.translator } : {}),
    });

    return page;
  }

  function press(page: MountedPage, key: string): KeyboardEvent {
    const KeyboardEventCtor = keyboardEventCtor(page);
    const event = new KeyboardEventCtor('keydown', { key, bubbles: true, cancelable: true });
    page.document.dispatchEvent(event);

    return event;
  }

  const announced = () => host?.root.querySelector('[data-fruitback-announcer]')?.textContent ?? '';

  it('walks the page in document order, and never onto the widget', () => {
    const page = mountKeyboard();
    host?.start();

    assert.equal(press(page, 'ArrowDown').defaultPrevented, true, 'the page scrolls under the reporter');
    assert.match(announced(), /^main: /);
    press(page, 'ArrowDown');
    assert.equal(announced(), 'button: Commander');
    press(page, 'ArrowDown');
    assert.equal(announced(), 'p: Du texte');
    press(page, 'ArrowDown');
    assert.equal(announced(), 'p: Du texte', 'the walk went past the page');
    press(page, 'ArrowUp');
    assert.equal(announced(), 'button: Commander');

    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'block');
  });

  it('goes up to the parent and down to the first child', () => {
    const page = mountKeyboard();
    host?.start();
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');

    press(page, 'ArrowLeft');
    assert.match(announced(), /^main: /);
    press(page, 'ArrowRight');
    assert.equal(announced(), 'button: Commander');
  });

  it('swaps the parent and child keys in a right-to-left language', () => {
    const translator = createTranslator({ locale: 'ar', messages: { ar: { 'launch.label': 'اترك ملاحظة' } } });
    assert.equal(translator.direction, 'rtl');
    const page = mountKeyboard({ translator });
    host?.start();
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');

    press(page, 'ArrowRight');
    assert.match(announced(), /^main: /);
    press(page, 'ArrowLeft');
    assert.equal(announced(), 'button: Commander');
  });

  it('skips what the engine cannot grab', () => {
    const page = mountKeyboard({ grabbable: (element) => element.tagName !== 'MAIN' });
    host?.start();

    press(page, 'ArrowDown');

    assert.equal(announced(), 'button: Commander');
  });

  it('selects the highlighted element on Enter or Space, as a click does', async () => {
    for (const key of ['Enter', ' ']) {
      const targets: CaptureTarget[] = [];
      const page = mountKeyboard({ onSelect: (target) => targets.push(target) });
      host?.start();
      press(page, 'ArrowDown');
      press(page, 'ArrowDown');

      assert.equal(press(page, key).defaultPrevented, true, `${JSON.stringify(key)} also reaches the launch button`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(targets[0]?.element.id, 'cta');
      assert.equal(host?.capturing(), false);
      host?.destroy();
      host = null;
    }
  });

  it('gives focus to the way out when the launch button had it, and Enter there stops or selects (FRU-303)', async () => {
    // The capsule hides the launch button while a capture runs: focus must not fall to the page.
    const targets: CaptureTarget[] = [];
    const page = mountKeyboard({ onSelect: (target) => targets.push(target) });
    launchButton().focus();
    host?.start();
    const halt = host?.root.querySelector('.fruitback-banner-stop') as HTMLElement;
    assert.ok(deepActiveElement(page.document) === halt, 'focus did not move to the way out');

    // With an element highlighted, Enter on the way out chooses it, as it did on the launch button.
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');
    assert.equal(press(page, 'Enter').defaultPrevented, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(targets[0]?.element.id, 'cta');
    // The way out left with the banner: focus is back on the launch button, for the dialog to return to.
    assert.ok(deepActiveElement(page.document) === launchButton(), 'focus fell out of the widget');

    // With nothing highlighted, Enter is left to the way out, which stops the capture.
    launchButton().focus();
    host?.start();
    assert.ok(deepActiveElement(page.document) === halt);
    assert.equal(press(page, 'Enter').defaultPrevented, false);
  });

  it('gives focus to the way out when the gear or the list had it, as the shortcut may start a capture then', () => {
    for (const control of ['.fruitback-configure', '.fruitback-listing']) {
      const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
      host = createCaptureHost({
        document: page.document,
        engine: fakeEngine(page, () => null),
        onSelect: () => {},
        onConfigure: () => {},
        onList: () => {},
      });
      (host.root.querySelector(control) as HTMLElement).focus();
      host.start();
      const halt = host.root.querySelector('.fruitback-banner-stop') as HTMLElement;
      assert.ok(deepActiveElement(page.document) === halt, `focus stayed on the hidden ${control}`);
      host.destroy();
      host = null;
    }
  });

  it('leaves focus where it is when a capture starts from elsewhere, as the shortcut of the extension does', () => {
    const page = mountKeyboard();
    const outside = page.query('#cta') as HTMLElement;
    outside.focus();
    host?.start();
    assert.ok(deepActiveElement(page.document) === outside);
  });

  it('leaves Enter to the launch button while nothing is highlighted', () => {
    const page = mountKeyboard();
    host?.start();

    assert.equal(press(page, 'Enter').defaultPrevented, false);
    assert.equal(host?.capturing(), true);
  });

  it('leaves the arrow keys to the page while the mode is off', () => {
    const page = mountKeyboard();

    assert.equal(press(page, 'ArrowDown').defaultPrevented, false);
    assert.equal(announced(), '');
  });

  it('says how to use the mode, says when an element has no text, and goes quiet on stop', () => {
    const page = mountKeyboard();
    page.query('p').textContent = '';

    host?.start();
    // The banner says how to use the mode (FRU-258): this region only names the element reached.
    assert.equal(announced(), '');
    assert.match(host?.root.querySelector('[data-fruitback-host-banner]')?.textContent ?? '', /arrow keys/);
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');
    assert.equal(announced(), 'p, no text');

    host?.stop();
    assert.equal(announced(), '');
  });

  it('stops the capture mode before the settings open', () => {
    let opened = 0;
    mount(
      () => null,
      () => {},
      { onConfigure: () => (opened += 1) },
    );
    host?.start();

    (host?.root.querySelector('[data-fruitback-host-configure]') as HTMLElement | undefined)?.click();

    assert.equal(opened, 1);
    assert.equal(host?.capturing(), false, 'the capture mode still takes the arrows and Enter');
  });

  it('leaves the keys to a dialog of the widget that has focus', () => {
    const page = mountKeyboard();
    const dialog = page.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = page.document.createElement('input');
    dialog.append(input);
    host?.root.append(dialog);
    host?.start();

    input.focus();

    assert.equal(press(page, 'ArrowDown').defaultPrevented, false);
    assert.doesNotMatch(announced(), /^main: /);
  });

  it('consumes the Escape that cancels the capture, and leaves a later Escape to the page', () => {
    const page = mountKeyboard();
    let heard = 0;
    page.document.body.addEventListener('keydown', () => (heard += 1));
    const KeyboardEventCtor = keyboardEventCtor(page);
    host?.start();

    const cancel = new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    page.document.body.dispatchEvent(cancel);
    assert.equal(host?.capturing(), false);
    assert.equal(heard, 0, 'the page also acted on the Escape that cancelled the capture');

    const later = new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    page.document.body.dispatchEvent(later);
    assert.equal(heard, 1);
    assert.equal(later.defaultPrevented, false);
  });

  it('leaves Escape to a dialog of the widget that has focus', () => {
    const page = mountKeyboard();
    const dialog = page.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = page.document.createElement('input');
    dialog.append(input);
    host?.root.append(dialog);
    let closed = 0;
    dialog.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') closed += 1;
    });
    host?.start();
    input.focus();

    const KeyboardEventCtor = keyboardEventCtor(page);
    input.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    assert.equal(closed, 1, 'the dialog did not get its Escape');
    assert.equal(host?.capturing(), true, 'one Escape closed the dialog and the capture');
  });

  it('lets Enter press the gear while an element is highlighted', async () => {
    const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
    const targets: CaptureTarget[] = [];
    host = createCaptureHost({
      document: page.document,
      engine: fakeEngine(page, () => null),
      onSelect: (target) => targets.push(target),
      onConfigure: () => {},
    });
    host.start();
    press(page, 'ArrowDown');
    press(page, 'ArrowDown');

    (host.root.querySelector('[data-fruitback-host-configure]') as HTMLButtonElement).focus();
    const enter = press(page, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(enter.defaultPrevented, false, 'Enter on the gear selected the highlighted element');
    assert.equal(targets.length, 0);
  });

  it('shows a focus ring on the controls the keyboard reaches', () => {
    mountKeyboard();
    const styles = host?.root.querySelector('style')?.textContent ?? '';

    assert.match(styles, /button:focus-visible, a:focus-visible[^{]*\{\s*outline: 2px solid/);
  });

  it('is a named landmark on the host page', () => {
    const page = mountKeyboard();
    const container = page.document.querySelector('[data-fruitback-host]');

    assert.equal(container?.getAttribute('role'), 'region');
    assert.equal(container?.getAttribute('aria-label'), 'Fruitback feedback');
  });
});

describe('the capsule of the dock (FRU-303)', () => {
  it('holds the list, the gear and the launch button in this order, and the banner last', () => {
    mount(
      () => null,
      () => {},
      { onList: () => {}, onConfigure: () => {} },
    );
    const dock = host?.dock as HTMLElement;
    assert.ok(dock.matches('[data-fruitback-dock]'));
    assert.deepEqual(
      [...dock.children].map((child) => child.className),
      ['fruitback-listing', 'fruitback-configure', 'fruitback-launch', 'fruitback-banner'],
    );
    // No second landmark: the host element is the region, and it has the name.
    assert.equal(dock.getAttribute('role'), null);
    assert.equal(host?.root.host.getAttribute('aria-label'), 'Fruitback feedback');
    assert.equal(dock.querySelector('.fruitback-listing')?.getAttribute('aria-label'), 'Show every note in a sidebar');
    assert.equal(dock.querySelector('.fruitback-configure')?.getAttribute('aria-label'), 'Open Fruitback settings');
  });

  it('says « Laisser une note » in French, and « Annuler » with the key « Échap » on the way out', () => {
    mount(
      () => null,
      () => {},
      { translator: createTranslator({ locale: 'fr' }) },
    );
    assert.equal(launchButton().textContent, 'Laisser une note');
    host?.start();
    const banner = host?.root.querySelector('[data-fruitback-host-banner]') as HTMLElement;
    assert.equal(
      banner.querySelector('.fruitback-banner-ask')?.textContent,
      'Pointez un élément, ou utilisez les flèches',
    );
    assert.equal(banner.querySelector('kbd')?.textContent, 'Échap');
    assert.equal(banner.querySelector('.fruitback-banner-stop span')?.textContent, 'Annuler');
  });
});

describe('shortSelector (FRU-303)', () => {
  it('writes the tag, then the id or the first class, as a stylesheet would', () => {
    const page = mountPage(
      '<button class="primary add">A</button><input id="email"><main></main><p id="two words" class="x">B</p>' +
        '<a id=":r7:" class="css-1x2y3z link">C</a>' +
        '<span class="button tag">D</span><span class="tag">E</span><button class="button chip--md chip lone">F</button>',
    );
    assert.equal(shortSelector(page.query('button')), 'button.add');
    assert.equal(shortSelector(page.query('input')), 'input#email');
    assert.equal(shortSelector(page.query('main')), 'main');
    // An id with a space selects nothing: the class is written instead.
    assert.equal(shortSelector(page.query('p')), 'p.x');
    // A generated id and a generated class are skipped, as the selector of the note skips them.
    assert.equal(shortSelector(page.query('a')), 'a.link');
    // The class the fewest elements share, and never the name of the tag again.
    // On a tie the last, which is where a design system puts the class of the author; no modifier.
    assert.equal(shortSelector(page.query('button.lone')), 'button.lone');
    assert.equal(shortSelector(page.query('span.button')), 'span.tag');
  });
});

describe('the button of the list when the notes could not be read (FRU-316)', () => {
  it('wears a dot, says it in its name, and the sentence is announced once', () => {
    mount(
      () => null,
      () => {},
      { onList: () => {} },
    );
    const listing = host?.root.querySelector('[data-fruitback-host-list]') as HTMLElement;
    const dot = listing.querySelector('.fruitback-listing-alert') as HTMLElement;
    const announcer = host?.root.querySelector('[data-fruitback-announcer]') as HTMLElement;
    assert.equal(dot.hidden, true);

    host?.readFailed(true, 'The notes of this page could not be read. They are not lost.');
    assert.equal(dot.hidden, false);
    assert.equal(listing.getAttribute('aria-label'), 'Show every note in a sidebar. They could not be read.');
    assert.equal(announcer.textContent, 'The notes of this page could not be read. They are not lost.');

    // Said once: the same failure again announces nothing new.
    announcer.textContent = '';
    host?.readFailed(true, 'The notes of this page could not be read. They are not lost.');
    assert.equal(announcer.textContent, '');

    host?.readFailed(false, '');
    assert.equal(dot.hidden, true);
    assert.equal(listing.getAttribute('aria-label'), 'Show every note in a sidebar');
  });
});

describe('a failure of the read that comes during a capture (FRU-316)', () => {
  it('is said when the capture ends, and not if the read came back meanwhile', () => {
    mount(
      () => null,
      () => {},
      { onList: () => {} },
    );
    const announcer = host?.root.querySelector('[data-fruitback-announcer]') as HTMLElement;

    host?.start();
    host?.readFailed(true, 'The notes of this page could not be read. They are not lost.');
    assert.notEqual(announcer.textContent, 'The notes of this page could not be read. They are not lost.');
    host?.stop();
    assert.equal(announcer.textContent, 'The notes of this page could not be read. They are not lost.');

    host?.readFailed(false, '');
    host?.start();
    host?.readFailed(true, 'Failed');
    host?.readFailed(false, '');
    host?.stop();
    assert.equal(announcer.textContent, '');
  });
});

describe('the launch button while the session of the host has ended (FRU-315)', () => {
  it('opens the sign-in instead of a capture, and gives the capture back', () => {
    mount(() => null);
    const asked: number[] = [];
    host?.start();
    assert.equal(host?.capturing(), true);

    host?.offerSignIn({ label: 'Sign in to leave notes', onSignIn: () => asked.push(1) });
    // A capture that ran stops: no note can start that the worker will refuse.
    assert.equal(host?.capturing(), false);
    assert.equal(launchButton().textContent, 'Sign in to leave notes');
    assert.equal(launchButton().hasAttribute('aria-pressed'), false);
    launchButton().click();
    assert.deepEqual(asked, [1]);
    assert.equal(host?.capturing(), false);

    host?.offerSignIn(undefined);
    assert.equal(launchButton().textContent, 'Leave feedback');
    assert.equal(launchButton().getAttribute('aria-pressed'), 'false');
    launchButton().click();
    assert.equal(host?.capturing(), true);
  });
});
