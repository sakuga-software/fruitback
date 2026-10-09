import { type Fruitback as Widget, type FruitbackOptions, init } from '@fruitback/widget';
import { useEffect, useRef } from 'react';

/**
 * The widget in a React application (FRU-127):
 *
 *     <Fruitback endpoint="https://feedback.acme.dev" clientId="acme" />
 *
 * It renders nothing. It calls `init` when it mounts and `destroy` when it unmounts, and it defines
 * nothing of the contract: its props are the options of `init`.
 */
export type FruitbackProps = FruitbackOptions & {
  /** Called with the widget each time it is mounted, for `refresh()` or `feedbackAsText()`. */
  onMount?: (widget: Widget) => void;
};

/** The options that are functions. A component gets a new one on every render. */
const CALLBACKS = ['identityToken', 'captureScreenshot', 'ignore'] as const;

/**
 * What decides whether the widget is mounted again.
 *
 * WARNING: a second mount closes the composer and loses what somebody was typing. A parent that
 * renders again must not cause one, and an object or a function written inline is new on every
 * render. So an object is compared by its value, and a function only by whether it is there:
 * the widget always calls the function of the last render.
 */
export function mountKey(options: FruitbackOptions): string {
  return JSON.stringify(options, (_key, value: unknown) => (typeof value === 'function' ? 'function' : value));
}

type Mount = (options: FruitbackOptions) => Widget;

/** The component over a given `init`, so a test can hand it one that keeps what it received. */
export function createFruitback(mount: Mount = init): (props: FruitbackProps) => null {
  return function Fruitback(props: FruitbackProps): null {
    const latest = useRef(props);
    latest.current = props;
    const { onMount: _onMount, ...options } = props;
    const key = mountKey(options);

    useEffect(() => {
      const { onMount, ...current } = latest.current;
      const stable: Record<string, unknown> = { ...current };
      for (const name of CALLBACKS) {
        if (current[name] === undefined) continue;
        // The function of the last render, behind one that never changes.
        stable[name] = (...args: unknown[]) =>
          (latest.current[name] as ((...inner: unknown[]) => unknown) | undefined)?.(...args);
      }
      const widget = mount(stable as FruitbackOptions);
      onMount?.(widget);

      // StrictMode runs this effect twice. The first widget is destroyed here before the second is
      // built, so one stays.
      return () => widget.destroy();
    }, [key]);

    return null;
  };
}

export const Fruitback = createFruitback();

export type { FruitbackOptions } from '@fruitback/widget';
