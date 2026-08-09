// Aliased: an unqualified `Window` in this file has to keep meaning the DOM's, which is what the
// code under test is written against and what `MountedPage` hands back.
import { Window as HappyDomWindow } from 'happy-dom';

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
