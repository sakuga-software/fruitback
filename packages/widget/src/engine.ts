import type { SeedSource } from '@sakuga/fruitback-shared';
import { isMangledComponentName } from './source.ts';
import { getElementBounds, getElementContext, getElementAtPoint, isElementGrabbable } from 'react-grab/primitives';

/**
 * The seam over `react-grab/primitives`.
 *
 * Three functions is all the widget takes from it, and naming them here rather than calling into the
 * library from the host buys two things: the unit tests can hand over a fake instead of asking
 * happy-dom for `elementsFromPoint` and a layout engine it does not have, and the day react-grab
 * changes shape the damage is confined to this file.
 *
 * What it is worth taking: hit testing that **crosses open shadow roots and same-origin iframes** and
 * walks *past* transparent overlays — including our own — and a source context read off the React
 * fiber properly. The widget's own `readReactSource` is the fallback for a page where react-grab is
 * not mounted; this is the real thing.
 */

export type CaptureEngine = {
  /** The element a pointer at these viewport coordinates is really pointing at. */
  elementAt(clientX: number, clientY: number, reject: (element: Element) => boolean): Element | null;
  /** Viewport bounds, correct through transformed iframes. */
  boundsOf(element: Element): { left: number; top: number; width: number; height: number };
  /** Component and source file behind the element, when the build kept them. */
  sourceOf(element: Element): Promise<SeedSource | undefined>;
};

export const reactGrabEngine: CaptureEngine = {
  elementAt: (clientX, clientY, reject) =>
    getElementAtPoint(clientX, clientY, {
      // `isElementGrabbable` already skips invisible nodes, document roots and page-covering
      // overlays; `reject` is how the host keeps the pointer from landing on the widget itself.
      filter: (candidate) => isElementGrabbable(candidate) && !reject(candidate),
    }),

  boundsOf: (element) => {
    // react-grab returns `x`/`y` (plus a border radius we do not use); the widget speaks in
    // `left`/`top` like `getBoundingClientRect`, and translating once here keeps that out of the host.
    const bounds = getElementBounds(element);

    return { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
  },

  async sourceOf(element) {
    try {
      const context = await getElementContext(element);
      const source: SeedSource = {};

      // The name is the one field react-grab gets wrong on a design system: pointing at a HeroUI
      // button reports `bound $7230ffa83bc0c2cf$var$DOMElement`, the react-aria internal that
      // rendered the host node, while `filePath`/`lineNumber` correctly point at the app's own JSX.
      // Dropping the name keeps the half that is right — and leaves `captureSeed`'s fiber walk free
      // to supply a name someone can search for.
      if (context.componentName && !isMangledComponentName(context.componentName)) {
        source.component = context.componentName;
      }
      if (context.filePath) source.file = context.filePath;
      if (typeof context.lineNumber === 'number') source.line = context.lineNumber;
      if (typeof context.columnNumber === 'number') source.column = context.columnNumber;

      return Object.keys(source).length > 0 ? source : undefined;
    } catch {
      // A production build with no source metadata, or a page React never touched. A seed without a
      // `source` is a perfectly good seed; failing the capture over it would not be.
      return undefined;
    }
  },
};
