import { type SeedAnchor, type SeedBounds, TEXT_EXCERPT_MAX_LENGTH } from '@fruitback/shared';
import { buildDomPath, buildSelector } from './selector.ts';

/**
 * Turning a clicked element into an anchor.
 *
 * The redundancy is the design: `selector`, the test id, the text, `domPath` and `bounds` are five
 * independent ways to find the element again, because the site *will* be redeployed between the
 * moment the note is written and the moment someone comes back to read it. Resolution order lives in
 * the widget's re-anchoring engine (SKG-500); this only has to make sure each way is worth trying.
 *
 * Nothing here writes a field it did not observe: an absent text excerpt stays absent rather than
 * becoming `''`, or the seed stops round-tripping through the Linear description.
 */

/** Attributes worth matching on when the selector misses, in the shape the seed schema expects. */
type AnchorAttrs = NonNullable<SeedAnchor['attrs']>;

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

export function captureAnchor(element: Element): SeedAnchor {
  const anchor: SeedAnchor = {
    selector: buildSelector(element),
    domPath: buildDomPath(element),
    tag: element.localName,
    bounds: captureBounds(element),
  };

  const text = readTextExcerpt(element);
  if (text !== undefined) anchor.text = text;

  const attrs = readAttrs(element);
  if (attrs !== undefined) anchor.attrs = attrs;

  return anchor;
}

/**
 * A short, whitespace-collapsed excerpt of what the element says.
 *
 * Content is the one identity that survives a full CSS and markup rewrite — a redesign rarely
 * renames the "Commander" button. Form controls have no text of their own, so their value, their
 * placeholder or their label stands in.
 */
export function readTextExcerpt(element: Element, maxLength = TEXT_EXCERPT_MAX_LENGTH): string | undefined {
  const raw = isFormControl(element)
    ? element.value || element.placeholder || element.getAttribute('aria-label') || ''
    : (element.textContent ?? '');
  const text = raw.replace(/\s+/g, ' ').trim();

  return text.length > 0 ? text.slice(0, maxLength) : undefined;
}

function isFormControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element.localName === 'input' || element.localName === 'textarea';
}

function readAttrs(element: Element): AnchorAttrs | undefined {
  const attrs: AnchorAttrs = {};

  const id = element.getAttribute('id');
  if (id) attrs.id = id;

  const testId = TEST_ID_ATTRIBUTES.map((attribute) => element.getAttribute(attribute)).find(
    (value): value is string => value !== null && value.length > 0,
  );
  if (testId !== undefined) attrs.testId = testId;

  const name = element.getAttribute('name');
  if (name) attrs.name = name;

  // The implicit role of a `<button>` is not in the markup, and re-deriving it needs the full ARIA
  // mapping table — so this stores what the author actually wrote, nothing more.
  const role = element.getAttribute('role');
  if (role) attrs.role = role;

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) attrs.ariaLabel = ariaLabel;

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/**
 * Where the pin sits, as a share of the **document** box rather than the viewport.
 *
 * Viewport coordinates would place the pin correctly only for a reviewer whose window happens to
 * match the reporter's, and would move on every scroll. Document-relative percentages survive both,
 * and are what lets an orphaned pin still be drawn roughly where its element used to be.
 */
export function captureBounds(element: Element): SeedBounds {
  const document = element.ownerDocument;
  const view = document.defaultView;
  const rect = element.getBoundingClientRect();

  const root = document.documentElement;
  const width = Math.max(root.scrollWidth, view?.innerWidth ?? 0);
  const height = Math.max(root.scrollHeight, view?.innerHeight ?? 0);

  return {
    xPct: toPercent(rect.left + (view?.scrollX ?? 0), width),
    yPct: toPercent(rect.top + (view?.scrollY ?? 0), height),
    wPct: toPercent(rect.width, width),
    hPct: toPercent(rect.height, height),
  };
}

/** Four decimals is sub-pixel on any document; more would just be noise in the stored JSON. */
function toPercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;

  return Math.round((value / total) * 1_000_000) / 10_000;
}
