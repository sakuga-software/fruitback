/**
 * `instanceof Element` is the wrong test, twice over.
 *
 * It reads a class off whatever realm this code was loaded in. An element that came from a
 * same-origin iframe belongs to a *different* realm and fails the check while being a perfectly good
 * element — and react-grab's hit testing crosses iframes on purpose, so those show up here. Outside a
 * browser the global does not exist at all and the comparison throws rather than returning false,
 * which is how this was found: a click handler died silently in the tests.
 *
 * `nodeType` is the same number everywhere and belongs to no realm.
 */

const ELEMENT_NODE = 1;

/**
 * Duck-typed by necessity, and therefore not sound: nothing stops a caller from passing an object
 * shaped like an element. Two properties rather than one narrows it enough to be useful — a bare
 * `{ nodeType: 1 }` no longer passes — and the alternative that *would* be sound is the realm-bound
 * `instanceof` this exists to replace.
 */
export function isElement(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Element;

  return candidate.nodeType === ELEMENT_NODE && typeof candidate.tagName === 'string';
}
