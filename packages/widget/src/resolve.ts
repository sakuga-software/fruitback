import { type SeedAnchor, type SeedAnchorStrategy, type SeedBounds, TEXT_EXCERPT_MAX_LENGTH } from '@fruitback/shared';

/**
 * Finding the element again, on a page that has been redeployed since the note was written.
 *
 * The anchor carries five independent claims about one element, and this walks them in the order
 * `SEED_ANCHOR_STRATEGIES` declares: **selector → testId → text → domPath → bounds**. That order is
 * the contract's, not this file's, and it puts `text` ahead of `domPath` on purpose — see below.
 *
 * The rule that matters more than the order: **a claim is only accepted if it is unique, and a claim
 * that is not identity-bearing has to be corroborated.** A structural path always resolves to
 * *something*; what it cannot tell you is whether that something is your element or the neighbour
 * that inherited the position. Answering "I lost this one" is cheap to recover from — the pin is
 * listed as an orphan and a human puts it right. Answering with the wrong element is not: the note
 * now says something about a button its author never looked at, and it is believed.
 */

/** Attributes a test id may hide behind, most conventional first. */
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

/**
 * How much of the stored box a candidate has to still occupy.
 *
 * Two thresholds, because the two strategies ask different questions. `domPath` has already found
 * exactly one element and only needs a sanity check that it did not slide across the page, so it is
 * lenient. `bounds` is choosing between elements on position alone, so it has to be strict or it
 * will confidently pick a neighbour.
 */
const DOM_PATH_MIN_OVERLAP = 0.25;
const BOUNDS_MIN_OVERLAP = 0.5;

export type AnchorResolution = {
  /** The element the pin belongs on, or `null` when nothing could be trusted. */
  element: Element | null;
  /** What found it — `orphan` when nothing did. Rendered onto the pin, and worth logging. */
  strategy: SeedAnchorStrategy | 'orphan';
  /**
   * Whether what found it was an **identity** or merely a **position**.
   *
   * This is the field that matters most on a page that changed. Delete a card from a grid and its
   * neighbour slides into the vacated slot with the same tag, the same text and the same box — no
   * signal a seed stores can separate them, so `domPath` and `bounds` will both land on the
   * neighbour, confidently and wrongly. Refusing to answer at all would throw away the cases where
   * position is exactly right, so the answer is given *with its provenance*: the overlay draws an
   * unconfident pin differently and says so in the thread, and nobody is asked to believe a pin that
   * was placed by coordinates alone.
   */
  confident: boolean;
};

/** The claims that say *which element*, as opposed to *which spot on the page*. */
const IDENTITY_STRATEGIES: readonly SeedAnchorStrategy[] = ['selector', 'testId', 'text'];

export type ResolveOptions = {
  /** Defaults to the ambient document; the widget passes its own when it runs inside an iframe. */
  document?: Document;
};

export function resolveAnchor(anchor: SeedAnchor, options: ResolveOptions = {}): AnchorResolution {
  const root = options.document ?? globalThis.document;

  for (const strategy of ['selector', 'testId', 'text', 'domPath', 'bounds'] as const) {
    const element = FINDERS[strategy](anchor, root);
    if (element !== null) return { element, strategy, confident: IDENTITY_STRATEGIES.includes(strategy) };
  }

  return { element: null, strategy: 'orphan', confident: false };
}

type Finder = (anchor: SeedAnchor, root: Document) => Element | null;

const FINDERS: Record<SeedAnchorStrategy, Finder> = {
  /** The selector the capture judged most durable. Identity-bearing, so uniqueness is enough. */
  selector: (anchor, root) => onlyMatch(root, anchor.selector, anchor),

  /**
   * The test id on its own, in case the selector that wrapped it moved — `[data-testid="x"] > button`
   * breaks when the button stops being a direct child, while the id it was scoped to is still there.
   */
  testId: (anchor, root) => {
    const testId = anchor.attrs?.testId;
    if (testId === undefined) return null;

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const found = onlyMatch(root, `[${attribute}="${cssValue(testId)}"]`, anchor);
      if (found !== null) return found;
    }

    return null;
  },

  /**
   * What the element says. Ahead of `domPath` because content survives a rewrite of the markup far
   * better than a position survives an insertion — and because it is the last strategy that carries
   * any identity at all.
   */
  text: (anchor, root) => {
    if (!anchor.text) return null;

    const matches = [...root.querySelectorAll(anchor.tag)].filter((element) => excerpt(element) === anchor.text);

    // Two elements saying the same thing is not an identity: three "Ajouter" buttons must fail here.
    return matches.length === 1 ? (matches[0] ?? null) : null;
  },

  /**
   * `html > body > main > ul > li:nth-child(2) > button`.
   *
   * Corroborated by position, and only by position. This is the strategy that quietly lands on the
   * wrong element — insert one card and `li:nth-child(2)` is the neighbour, with the same tag and
   * often the same text, so neither of those can tell them apart. Where the element *is* can: a path
   * whose claim ("the element sits here in the tree") has gone stale usually points somewhere else
   * on the page entirely.
   */
  domPath: (anchor, root) => {
    if (anchor.domPath === undefined) return null;

    const found = onlyMatch(root, anchor.domPath, anchor);
    if (found === null) return null;

    return overlap(boxOf(found), anchor.bounds) >= DOM_PATH_MIN_OVERLAP ? found : null;
  },

  /**
   * Last resort: whichever element of the right tag still occupies the box the pin was planted on.
   *
   * Strict, because this one is choosing on position alone. Below the threshold the honest answer is
   * that the element is gone, and the pin becomes an orphan (SKG-501 decides how to present it).
   */
  bounds: (anchor, root) => {
    let best: { element: Element; score: number } | null = null;

    for (const element of root.querySelectorAll(anchor.tag)) {
      const score = overlap(boxOf(element), anchor.bounds);
      if (score >= BOUNDS_MIN_OVERLAP && (best === null || score > best.score)) best = { element, score };
    }

    return best?.element ?? null;
  },
};

/** A selector is only an answer when it matches exactly one element, of the tag we captured. */
function onlyMatch(root: Document, selector: string, anchor: SeedAnchor): Element | null {
  try {
    const found = root.querySelectorAll(selector);
    if (found.length !== 1) return null;

    const element = found[0] ?? null;

    // A selector that now matches a different kind of element is a coincidence, not a match.
    return element !== null && element.localName === anchor.tag ? element : null;
  } catch {
    // A selector the current engine will not parse. Refusing beats throwing during a render.
    return null;
  }
}

/** Same normalisation as the capture, or a comparison would fail on whitespace alone. */
function excerpt(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_EXCERPT_MAX_LENGTH);
}

/**
 * The element's current box, in the same document-relative percentages the anchor stored — which is
 * what makes the two comparable across a different window size.
 */
export function boxOf(element: Element): SeedBounds {
  const document = element.ownerDocument;
  const view = document.defaultView;
  const rect = element.getBoundingClientRect();
  const width = Math.max(document.documentElement.scrollWidth, view?.innerWidth ?? 0);
  const height = Math.max(document.documentElement.scrollHeight, view?.innerHeight ?? 0);

  if (width <= 0 || height <= 0) return { xPct: 0, yPct: 0, wPct: 0, hPct: 0 };

  return {
    xPct: ((rect.left + (view?.scrollX ?? 0)) / width) * 100,
    yPct: ((rect.top + (view?.scrollY ?? 0)) / height) * 100,
    wPct: (rect.width / width) * 100,
    hPct: (rect.height / height) * 100,
  };
}

/**
 * Intersection over union of two boxes, 0 to 1.
 *
 * Not centre distance: a small element inside a big one shares a centre with it, and "the pin is on
 * the card rather than on the button" is exactly the mistake this is here to avoid.
 */
export function overlap(a: SeedBounds, b: SeedBounds): number {
  const left = Math.max(a.xPct, b.xPct);
  const top = Math.max(a.yPct, b.yPct);
  const right = Math.min(a.xPct + a.wPct, b.xPct + b.wPct);
  const bottom = Math.min(a.yPct + a.hPct, b.yPct + b.hPct);

  if (right <= left || bottom <= top) return 0;

  const intersection = (right - left) * (bottom - top);
  const union = a.wPct * a.hPct + b.wPct * b.hPct - intersection;

  return union > 0 ? intersection / union : 0;
}

function cssValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
