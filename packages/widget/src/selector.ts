/**
 * Building the selector half of an anchor.
 *
 * A selector is the first thing the widget tries when re-planting a pin, and the first thing a
 * redeploy breaks. So this does not ask "what selects this element" — any `:nth-child` chain does
 * that — but "what still selects it after the site changed". Test ids and author-written ids survive
 * a refactor; a class emitted by CSS modules and a `:r7:` from `useId` do not, and picking one of
 * those produces an anchor that looks precise and resolves to nothing a week later.
 *
 * Whatever comes out of here is verified unique in the document before being returned, and
 * `domPath` is captured alongside it as the structural fallback.
 */

/** In the order a front-end dev would recognise them. All of them mean "this is on purpose". */
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

/** More than this and the selector is noise rather than identity. */
const MAX_CLASSES = 3;

/**
 * Ids that a framework generated for us. They are unique, which is exactly what makes them
 * tempting — and they change on every render, which makes them the worst possible anchor.
 */
const GENERATED_ID_PATTERNS = [
  /:/, // React's `useId`: `:r7:`
  /^radix-/i,
  /^headlessui-/i,
  /^mui-/i,
  /^:?[0-9a-f]{8,}:?$/i, // a hash or a uuid fragment
  /\d{4,}/, // a counter, or a timestamp
];

/** Classes emitted by a build step rather than written by a human. */
const GENERATED_CLASS_PATTERNS = [
  /^css-[0-9a-z]+$/i, // emotion
  /^sc-[0-9a-z]+$/i, // styled-components
  /_[0-9a-z]{5,}$/i, // CSS modules: `button_3f2a1`
  /[0-9a-f]{6,}/i,
];

export function isStableId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !GENERATED_ID_PATTERNS.some((pattern) => pattern.test(id));
}

export function isStableClass(className: string): boolean {
  return className.length > 0 && className.length <= 40 && !GENERATED_CLASS_PATTERNS.some((p) => p.test(className));
}

/**
 * Candidates from most to least durable. Uniqueness is checked by the caller, so this can offer a
 * selector that happens to match several elements — it simply loses to the next one.
 */
function* selectorCandidates(element: Element): Generator<string> {
  const tag = cssIdentifier(element.localName);

  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) yield `[${attribute}=${cssString(value)}]`;
  }

  const id = element.getAttribute('id');
  if (id !== null && isStableId(id)) yield `#${cssIdentifier(id)}`;

  const name = element.getAttribute('name');
  if (name) yield `${tag}[name=${cssString(name)}]`;

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) yield `${tag}[aria-label=${cssString(ariaLabel)}]`;

  const classes = stableClasses(element);
  if (classes.length > 0) yield `${tag}${classes.map((name) => `.${cssIdentifier(name)}`).join('')}`;
}

function stableClasses(element: Element): string[] {
  return [...element.classList].filter(isStableClass).slice(0, MAX_CLASSES);
}

/**
 * The best selector we can build for this element, guaranteed to match it and nothing else.
 *
 * When no candidate is unique on its own — three identical cards, one "Add to cart" button each —
 * the winner is scoped under the nearest ancestor that *is* identifiable, which is far more durable
 * than a path from `<html>`: reordering the page above that ancestor no longer breaks it.
 */
export function buildSelector(element: Element): string {
  const root = element.ownerDocument;

  for (const candidate of selectorCandidates(element)) {
    if (matchesOnly(root, candidate, element)) return candidate;
  }

  const scoped = scopeUnderAncestor(element);
  if (scoped !== null) return scoped;

  return buildDomPath(element);
}

function scopeUnderAncestor(element: Element): string | null {
  const root = element.ownerDocument;
  const steps: string[] = [];
  let child: Element = element;

  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    // Grown from the element upwards, so `steps` always spells the path down from `ancestor`.
    steps.unshift(positionalStep(child));

    for (const candidate of selectorCandidates(ancestor)) {
      if (!matchesOnly(root, candidate, ancestor)) continue;

      const scoped = `${candidate} > ${steps.join(' > ')}`;
      if (matchesOnly(root, scoped, element)) return scoped;
    }

    child = ancestor;
  }

  return null;
}

function matchesOnly(root: Document, selector: string, element: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);

    return found.length === 1 && found[0] === element;
  } catch {
    // An unescaped value we did not anticipate. Refusing the candidate beats throwing at capture
    // time — there is always the structural fallback.
    return false;
  }
}

/**
 * `html > body > div:nth-child(2) > main > button`.
 *
 * Brittle on its own, which is why it is stored *next to* the selector rather than instead of it:
 * when everything else has been renamed, the shape of the page is the last thing left to match on.
 * `:nth-child` is only spelled out where it disambiguates, so the path stays readable in the issue.
 */
export function buildDomPath(element: Element): string {
  const steps: string[] = [];

  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    steps.unshift(positionalStep(current));
  }

  return steps.join(' > ');
}

function positionalStep(element: Element): string {
  const tag = cssIdentifier(element.localName);
  const parent = element.parentElement;
  if (parent === null) return tag;

  const siblings = [...parent.children];
  const sameTag = siblings.filter((sibling) => sibling.localName === element.localName);
  if (sameTag.length <= 1) return tag;

  return `${tag}:nth-child(${siblings.indexOf(element) + 1})`;
}

/**
 * `CSS.escape` where it exists — every browser we target has it. The fallback covers the test and
 * server-side environments that do not.
 */
export function cssIdentifier(value: string): string {
  const escape = globalThis.CSS?.escape;

  return escape ? escape(value) : escapeIdentifier(value);
}

/**
 * Exported for its own tests: whether it runs at all depends on the environment, and a bug in here
 * is invisible — an invalid selector is silently rejected by `matchesOnly` and the element quietly
 * falls back to a less durable anchor.
 *
 * The start of an identifier has its own rule: `#1col` is not a selector at all, and CSS spells that
 * first digit as a hex escape, `#\31 col`. The trailing space terminates the escape and is part of
 * it — dropping it swallows the next character.
 */
export function escapeIdentifier(value: string): string {
  if (value === '') return '';
  if (value === '-') return '\\-';

  const escaped = value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);

  return escaped.replace(/^(-?)(\d)/, (_match, dash: string, digit: string) => `${dash}\\3${digit} `);
}

/**
 * A quoted attribute value, so a selector never breaks on an apostrophe or a bracket.
 *
 * The quote is picked to avoid escaping where it can be: `[aria-label='Dire "bonjour"']` rather than
 * the same thing with backslashes. Browsers accept both, but the unescaped form stays readable in
 * the Linear issue, and not every selector engine parses an escaped quote — the widget has to keep
 * working on whichever one the client's page brings along.
 */
export function cssString(value: string): string {
  if (value.includes('"') && !value.includes("'")) return `'${value}'`;

  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
