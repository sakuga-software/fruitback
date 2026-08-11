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

export function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && (value as Node).nodeType === ELEMENT_NODE;
}
