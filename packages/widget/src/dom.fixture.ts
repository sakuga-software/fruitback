// Aliased: an unqualified `Window` in this file has to keep meaning the DOM's, which is what the
// code under test is written against and what `MountedPage` hands back.
import { mock } from 'node:test';
import { Window as HappyDomWindow } from 'happy-dom';
import type { Frames } from './settle.ts';

/**
 * A real DOM for the tests.
 *
 * The anchor code asks the document questions no hand-rolled fake answers honestly — "is this
 * selector unique", "which siblings share this tag" — so the tests run against happy-dom rather than
 * against stubs. It is a devDependency of this package only: nothing in `src` outside `*.test.ts`
 * and this file may import it.
 *
 * happy-dom's classes are structurally the DOM's but nominally its own, so the casts here are the
 * one place that conversion happens.
 */

export type MountedPage = {
  view: Window;
  document: Document;
  /** The element matching `selector`, or a failure loud enough to read in the test output. */
  query(selector: string): Element;
};

export type MountOptions = {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  dpr?: number;
};

export function mountPage(html: string, options: MountOptions = {}): MountedPage {
  const window = new HappyDomWindow({
    url: options.url ?? 'https://preview.acme.test/pricing',
    width: options.width ?? 1_440,
    height: options.height ?? 900,
  });

  const document = window.document as unknown as Document;
  document.body.innerHTML = html;
  if (options.title !== undefined) document.title = options.title;
  if (options.dpr !== undefined) {
    Object.defineProperty(window, 'devicePixelRatio', { value: options.dpr, configurable: true });
  }

  return {
    view: window as unknown as Window,
    document,
    query(selector: string): Element {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`nothing matches ${selector} in the mounted page`);

      return element;
    },
  };
}

/**
 * Give Node's own navigator a language, until `mock.restoreAll()`.
 *
 * Node has a navigator too, and it takes its language from the locale of the shell: `fr-FR` under
 * `LC_ALL=fr_FR.UTF-8`. A test that proves a binding reads the navigator of the page gives the page
 * one language and this navigator another. Left to the shell, the two agreed on a French machine:
 * four tests failed there and passed in CI (FRU-172).
 *
 * The getter of the prototype is replaced. `mock.property` refuses `language`, which the navigator
 * does not own, and it cannot restore `navigator` itself, which is a getter of `globalThis`
 * (measured on Node 25.8.1).
 */
export function globalNavigatorSpeaks(language: string): void {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as Navigator;

  mock.getter(prototype, 'language', () => language);
  mock.getter(prototype, 'languages', () => [language]);
}

/**
 * happy-dom does no layout, so an element's box is whatever a test says it is. That is enough here:
 * what is under test is the arithmetic that turns a box into document-relative percentages.
 */
export function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
    }),
    configurable: true,
  });
}

/** The document box the percentages are taken against, which happy-dom leaves at zero. */
export function setDocumentSize(document: Document, width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
}

/** Scroll offsets, so a pin captured below the fold lands at the right place in the document. */
export function setScroll(view: Window, scrollX: number, scrollY: number): void {
  Object.defineProperty(view, 'scrollX', { value: scrollX, configurable: true });
  Object.defineProperty(view, 'scrollY', { value: scrollY, configurable: true });
}

/** Same cast again, for the tests that dispatch a key press at an element rather than the document. */
export function keyboardEventCtor(page: MountedPage): typeof KeyboardEvent {
  return (page.view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
}

/** happy-dom's `MouseEvent` is not on the DOM `Window` type either — same cast, same place. */
export function mouseEventCtor(page: MountedPage): typeof MouseEvent {
  return (page.view as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
}

/**
 * Dispatch a key press. happy-dom's constructors are not on the DOM `Window` type, so the cast lives
 * here with the others rather than in a test.
 */
export function pressKey(page: MountedPage, key: string): void {
  const KeyboardEventCtor = (page.view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

  page.document.dispatchEvent(new KeyboardEventCtor('keydown', { key, bubbles: true }));
}

/** Frames that the test runs by hand, at a clock it sets: 16 ms a frame unless it says otherwise. */
export function handFrames(): Frames & { next(ms?: number): boolean; pending(): number; clock: number } {
  const queue = new Map<number, () => void>();
  let id = 0;
  const frames = {
    clock: 0,
    request(callback: () => void) {
      id += 1;
      queue.set(id, callback);

      return id;
    },
    cancel(handle: number) {
      queue.delete(handle);
    },
    now: () => frames.clock,
    /** Run the frames that wait, after `ms`. False when none waited. */
    next(ms = 16) {
      frames.clock += ms;
      const waiting = [...queue.values()];
      queue.clear();
      for (const callback of waiting) callback();

      return waiting.length > 0;
    },
    pending: () => queue.size,
  };

  return frames;
}

/**
 * Give a window the frames of `handFrames`: its `requestAnimationFrame`, `cancelAnimationFrame` and
 * clock are then the test's. happy-dom runs a frame at the next turn, at no time a test can choose.
 */
export function useHandFrames(view: Window): ReturnType<typeof handFrames> {
  const frames = handFrames();
  Object.assign(view, {
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.request(() => callback(frames.clock)),
    cancelAnimationFrame: (handle: number) => frames.cancel(handle),
  });
  Object.defineProperty(view.performance, 'now', { value: () => frames.clock, configurable: true });

  return frames;
}
