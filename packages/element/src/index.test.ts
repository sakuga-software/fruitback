import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Aliased: an unqualified `Window` in this file must keep meaning the DOM's.
import { Window as HappyDomWindow } from 'happy-dom';
import type { Fruitback, FruitbackOptions } from '@fruitback/widget';
import {
  FRUITBACK_TAG,
  type FruitbackElement,
  createFruitbackElement,
  defineFruitbackElement,
  optionsFromAttributes,
} from './index.ts';

/** A page with the element defined over a mount that keeps what it was given. */
function page() {
  const view = new HappyDomWindow({ url: 'https://staging.acme.dev/' }) as unknown as Window & typeof globalThis;
  const mounted: FruitbackOptions[] = [];
  let destroyed = 0;
  const mount = (options: FruitbackOptions): Fruitback =>
    ({
      destroy: () => void (destroyed += 1),
      refresh: async () => undefined,
      feedbackAsText: () => '',
      options,
    }) as unknown as Fruitback;
  view.customElements.define(
    FRUITBACK_TAG,
    createFruitbackElement(view, (options) => {
      mounted.push(options);

      return mount(options);
    }),
  );
  /** Every microtask the element queued has run after this. */
  const settled = (): Promise<void> => new Promise((resolve) => view.setTimeout(resolve, 0));
  const add = (html: string): FruitbackElement => {
    view.document.body.innerHTML = html;

    return view.document.querySelector(FRUITBACK_TAG) as unknown as FruitbackElement;
  };

  return { view, mounted, destroyedCount: () => destroyed, settled, add };
}

describe('<fruitback-widget> (FRU-126)', () => {
  it('mounts the widget once, with what its attributes say', async () => {
    const { mounted, settled, add } = page();
    add(
      '<fruitback-widget endpoint="https://feedback.acme.dev" client-id="acme" label="Feedback" locale="fr" include-env="true"></fruitback-widget>',
    );
    await settled();

    assert.deepEqual(mounted, [
      { endpoint: 'https://feedback.acme.dev', clientId: 'acme', label: 'Feedback', locale: 'fr', includeEnv: true },
    ]);
  });

  it('mounts nothing without an endpoint and a client id, and mounts when they arrive', async () => {
    const { mounted, settled, add } = page();
    const element = add('<fruitback-widget client-id="acme"></fruitback-widget>');
    await settled();
    assert.deepEqual(mounted, []);
    assert.equal(element.widget, undefined);

    element.setAttribute('endpoint', 'https://feedback.acme.dev');
    await settled();

    assert.equal(mounted.length, 1);
    assert.ok(element.widget !== undefined);
  });

  it('mounts once for several changes of one task, and destroys the widget it replaces', async () => {
    const { mounted, destroyedCount, settled, add } = page();
    const element = add('<fruitback-widget endpoint="https://a.dev" client-id="acme"></fruitback-widget>');
    await settled();

    element.setAttribute('endpoint', 'https://b.dev');
    element.setAttribute('label', 'Notes');
    element.options = { theme: { 'color-accent': '#0055ff' } };
    await settled();

    assert.equal(mounted.length, 2, 'three changes, one new mount');
    assert.equal(destroyedCount(), 1);
    assert.deepEqual(mounted[1], {
      theme: { 'color-accent': '#0055ff' },
      endpoint: 'https://b.dev',
      clientId: 'acme',
      label: 'Notes',
    });
  });

  it('does not mount again for an attribute set to the value it has', async () => {
    const { mounted, settled, add } = page();
    const element = add('<fruitback-widget endpoint="https://a.dev" client-id="acme"></fruitback-widget>');
    await settled();

    element.setAttribute('endpoint', 'https://a.dev');
    await settled();

    assert.equal(mounted.length, 1);
  });

  it('destroys the widget when the element leaves the page, and mounts none after', async () => {
    const { mounted, destroyedCount, settled, add } = page();
    const element = add('<fruitback-widget endpoint="https://a.dev" client-id="acme"></fruitback-widget>');
    await settled();

    element.remove();
    await settled();

    assert.equal(destroyedCount(), 1);
    assert.equal(element.widget, undefined);
    assert.equal(mounted.length, 1);
  });

  /**
   * happy-dom upgrades a tag by building a new element, so the own property of a real upgrade cannot
   * be made here by defining the tag late. It is made by hand, and `e2e/package.spec.ts` does the
   * real thing in Chromium.
   */
  it('takes back an options that hides its accessor, as one set before the tag was defined does', async () => {
    const { mounted, settled, add, view } = page();
    const element = add('<fruitback-widget endpoint="https://a.dev" client-id="acme"></fruitback-widget>');
    await settled();
    element.remove();
    Object.defineProperty(element, 'options', {
      value: { theme: { 'color-accent': '#0055ff' } },
      configurable: true,
      enumerable: true,
      writable: true,
    });

    view.document.body.append(element as unknown as Node);
    await settled();

    assert.deepEqual(mounted.at(-1), {
      theme: { 'color-accent': '#0055ff' },
      endpoint: 'https://a.dev',
      clientId: 'acme',
    });
    assert.equal(Object.hasOwn(element, 'options'), false, 'the accessor is reachable again');
  });

  it('turns the environment on for the word true only, as the script tag does', () => {
    const read = (value: string) => (name: string) =>
      ({ endpoint: 'https://a.dev', 'client-id': 'acme', 'include-env': value })[name] ?? null;

    assert.equal(optionsFromAttributes(read('true'))?.includeEnv, true);
    assert.equal('includeEnv' in (optionsFromAttributes(read('')) ?? {}), false);
    assert.equal('includeEnv' in (optionsFromAttributes(read('yes')) ?? {}), false);
  });

  it('defines the tag once, however many times it is asked', () => {
    const view = new HappyDomWindow() as unknown as Window & typeof globalThis;

    defineFruitbackElement(FRUITBACK_TAG, view);
    const first = view.customElements.get(FRUITBACK_TAG);
    defineFruitbackElement(FRUITBACK_TAG, view);

    assert.ok(first !== undefined && view.customElements.get(FRUITBACK_TAG) === first);
  });
});
