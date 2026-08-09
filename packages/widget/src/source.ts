import type { SeedSource } from '@fruitback/shared';

/**
 * The react-grab payoff: the component and the source file behind the clicked element.
 *
 * `react-grab/primitives` owns this properly — it instruments the app and knows the mapping. The
 * widget host (SKG-492) will pass what it resolved through `captureSeed({ source })`, and that always
 * wins over what is here.
 *
 * What is here is the fallback for a page where react-grab is not mounted: React attaches its fiber
 * to the DOM node under a `__reactFiber$…` key, and a dev build keeps the JSX location on it. Both
 * are internals — undocumented, absent from production builds, and gone from `_debugSource` in
 * React 19 — so this reads them defensively and returns `undefined` at the first surprise rather
 * than guessing. A seed with no `source` is a perfectly good seed; a seed pointing at the wrong file
 * is a bug someone chases for an hour.
 */

type DebugSource = { fileName?: unknown; lineNumber?: unknown; columnNumber?: unknown };

type Fiber = {
  _debugSource?: DebugSource;
  _debugOwner?: Fiber;
  type?: unknown;
  elementType?: unknown;
  return?: Fiber;
};

export function readReactSource(element: Element): SeedSource | undefined {
  const fiber = findFiber(element);
  if (fiber === undefined) return undefined;

  const source: SeedSource = {};

  const component = findComponentName(fiber);
  if (component !== undefined) source.component = component;

  const debugSource = findDebugSource(fiber);
  if (typeof debugSource?.fileName === 'string') source.file = debugSource.fileName;
  if (typeof debugSource?.lineNumber === 'number') source.line = debugSource.lineNumber;
  if (typeof debugSource?.columnNumber === 'number') source.column = debugSource.columnNumber;

  return Object.keys(source).length > 0 ? source : undefined;
}

function findFiber(element: Element): Fiber | undefined {
  // `getOwnPropertyNames`, not `keys`: React assigns the fiber as an enumerable property today, and
  // this costs nothing if a future version hides it.
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
  if (key === undefined) return undefined;

  const fiber = (element as unknown as Record<string, unknown>)[key];

  return isObject(fiber) ? (fiber as Fiber) : undefined;
}

/**
 * The host fiber is the `<button>`, not the component that rendered it, so walk owners upwards until
 * one has a name. Bounded: a deep tree must not turn a hover into a walk of the whole app.
 */
const MAX_OWNER_HOPS = 20;

function findComponentName(fiber: Fiber): string | undefined {
  let current: Fiber | undefined = fiber;

  for (let hop = 0; hop < MAX_OWNER_HOPS && current !== undefined; hop += 1) {
    const name = componentNameOf(current.type) ?? componentNameOf(current.elementType);
    if (name !== undefined) return name;

    current = current._debugOwner;
  }

  return undefined;
}

function componentNameOf(type: unknown): string | undefined {
  // A string type is the host element (`'button'`), which is the tag, not a component.
  if (typeof type === 'function') {
    const named = type as { displayName?: unknown; name?: unknown };

    return firstNonEmptyString(named.displayName, named.name);
  }
  if (isObject(type)) {
    // `memo`, `forwardRef` and friends wrap the real component.
    const wrapper = type as { displayName?: unknown; render?: unknown; type?: unknown };
    const own = firstNonEmptyString(wrapper.displayName);

    return own ?? componentNameOf(wrapper.render) ?? componentNameOf(wrapper.type);
  }

  return undefined;
}

function findDebugSource(fiber: Fiber): DebugSource | undefined {
  let current: Fiber | undefined = fiber;

  for (let hop = 0; hop < MAX_OWNER_HOPS && current !== undefined; hop += 1) {
    if (isObject(current._debugSource)) return current._debugSource;

    current = current._debugOwner;
  }

  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
