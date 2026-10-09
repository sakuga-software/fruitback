import { type Fruitback, type FruitbackOptions, init } from '@fruitback/widget';

/**
 * The widget as a custom element (FRU-126):
 *
 *     <fruitback-widget endpoint="https://feedback.acme.dev" client-id="acme"></fruitback-widget>
 *
 * It defines nothing of the contract: it reads its attributes, hands them to `init`, and calls
 * `destroy` when it leaves the page. The element draws nothing itself. The widget keeps its own host
 * at the origin of the document, because its pins are placed in document coordinates.
 */
export const FRUITBACK_TAG = 'fruitback-widget';

/** The attributes the element reads. Every other option of `init` goes through `options`. */
export const FRUITBACK_ATTRIBUTES = ['endpoint', 'client-id', 'label', 'locale', 'include-env'] as const;

/** What `init` cannot take from an attribute: a function, or an object. */
export type ElementOptions = Omit<FruitbackOptions, 'endpoint' | 'clientId' | 'label' | 'locale' | 'includeEnv'>;

export type FruitbackElement = HTMLElement & {
  /** The options an attribute cannot carry. Setting it mounts the widget again. */
  options: ElementOptions;
  /** The mounted widget, or `undefined` while the element has no `endpoint` and `client-id`. */
  readonly widget: Fruitback | undefined;
};

/**
 * The options of `init` from the attributes, or `undefined` when the two that `init` needs are not
 * both there. An element with no endpoint mounts nothing: it is how a page keeps the widget dormant.
 */
export function optionsFromAttributes(
  read: (name: (typeof FRUITBACK_ATTRIBUTES)[number]) => string | null,
  more: ElementOptions = {},
): FruitbackOptions | undefined {
  const endpoint = read('endpoint')?.trim();
  const clientId = read('client-id')?.trim();
  if (!endpoint || !clientId) return undefined;
  const label = read('label');
  const locale = read('locale');

  return {
    ...more,
    endpoint,
    clientId,
    ...(label === null || label === '' ? {} : { label }),
    ...(locale === null || locale === '' ? {} : { locale }),
    // Only the word `true` turns it on, as on the script tag (FRU-84).
    ...(read('include-env') === 'true' ? { includeEnv: true } : {}),
  };
}

type Mount = (options: FruitbackOptions) => Fruitback;

/**
 * The class of the element, for one window.
 *
 * A function, and not a class at the top of the module: `HTMLElement` is a global of a browser, and a
 * module that names it when it loads cannot be imported on a server that renders the page.
 */
export function createFruitbackElement(
  view: Window & typeof globalThis = window,
  mount: Mount = init,
): CustomElementConstructor {
  return class extends view.HTMLElement {
    static readonly observedAttributes = FRUITBACK_ATTRIBUTES;

    #widget: Fruitback | undefined;
    #options: ElementOptions = {};
    #scheduled = false;

    get widget(): Fruitback | undefined {
      return this.#widget;
    }

    get options(): ElementOptions {
      return this.#options;
    }

    set options(value: ElementOptions) {
      this.#options = value;
      this.#schedule();
    }

    connectedCallback(): void {
      this.#schedule();
    }

    disconnectedCallback(): void {
      this.#unmount();
    }

    attributeChangedCallback(_name: string, before: string | null, after: string | null): void {
      if (before !== after) this.#schedule();
    }

    /**
     * One mount for every change made in the same task. A page that sets two attributes, or the
     * parser that reads them one by one, must not build the widget twice: a second mount closes the
     * composer and loses what somebody was typing.
     */
    #schedule(): void {
      if (this.#scheduled) return;
      this.#scheduled = true;
      view.queueMicrotask(() => {
        this.#scheduled = false;
        this.#unmount();
        if (!this.isConnected) return;
        const options = optionsFromAttributes((name) => this.getAttribute(name), this.#options);
        if (options !== undefined) this.#widget = mount(options);
      });
    }

    #unmount(): void {
      this.#widget?.destroy();
      this.#widget = undefined;
    }
  };
}

/**
 * Registers the element. Safe to call twice, and on a page where another copy of this package already
 * did: a second `define` of one tag throws.
 */
export function defineFruitbackElement(tag: string = FRUITBACK_TAG, view: Window & typeof globalThis = window): void {
  if (view.customElements.get(tag) !== undefined) return;
  view.customElements.define(tag, createFruitbackElement(view));
}
