import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { Fruitback as Widget, FruitbackOptions } from '@fruitback/widget';
import { StrictMode, act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { type FruitbackProps, createFruitback, mountKey } from './index.ts';

const BASE = { endpoint: 'https://feedback.acme.dev', clientId: 'acme' };
const globals = globalThis as Record<string, unknown>;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  for (const name of ['IS_REACT_ACT_ENVIRONMENT', 'window', 'document']) delete globals[name];
});

/** React in a page, over a mount that keeps what it received and counts what it destroyed. */
function app() {
  const view = new Window({ url: 'https://staging.acme.dev/' });
  // react-dom reads the page from the globals. They are removed after each case.
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.window = view;
  globals.document = view.document;
  const mounted: FruitbackOptions[] = [];
  const state = { destroyed: 0 };
  const Fruitback = createFruitback((options) => {
    mounted.push(options);

    return { destroy: () => void (state.destroyed += 1) } as unknown as Widget;
  });
  root = createRoot(view.document.body as unknown as Element);
  const render = (props: FruitbackProps, strict = false): Promise<void> =>
    act(async () =>
      root?.render(
        strict ? createElement(StrictMode, null, createElement(Fruitback, props)) : createElement(Fruitback, props),
      ),
    );

  return { mounted, state, render, live: () => mounted.length - state.destroyed };
}

describe('<Fruitback /> (FRU-127)', () => {
  it('mounts the widget with its props, and destroys it when it unmounts', async () => {
    const { mounted, state, render } = app();
    await render({ ...BASE, label: 'Feedback' });

    assert.deepEqual(mounted, [{ ...BASE, label: 'Feedback' }]);
    await act(async () => root?.unmount());
    root = undefined;
    assert.equal(state.destroyed, 1);
  });

  it('leaves one widget under StrictMode, which runs the effect twice', async () => {
    const { mounted, live, render } = app();
    await render(BASE, true);

    assert.equal(live(), 1);
    assert.equal(mounted.length, 2, 'the control: the effect did run twice');
  });

  it('does not mount again when a parent renders with the same values, written again', async () => {
    const { mounted, render } = app();
    await render({ ...BASE, theme: { 'color-accent': '#0055ff' }, ignore: () => false });
    await render({ ...BASE, theme: { 'color-accent': '#0055ff' }, ignore: () => false });

    assert.equal(mounted.length, 1);
  });

  it('mounts again when a value changes, and destroys the widget before', async () => {
    const { mounted, state, live, render } = app();
    await render(BASE);
    await render({ ...BASE, endpoint: 'https://other.acme.dev' });

    assert.equal(mounted.length, 2);
    assert.equal(state.destroyed, 1);
    assert.equal(live(), 1);
    assert.equal(mounted[1]?.endpoint, 'https://other.acme.dev');
  });

  it('calls the function of the last render, through the one the widget was given', async () => {
    const { mounted, render } = app();
    await render({ ...BASE, identityToken: () => 'first' });
    await render({ ...BASE, identityToken: () => 'second' });

    assert.equal(mounted.length, 1);
    assert.equal(await mounted[0]?.identityToken?.(), 'second');
  });

  it('hands the widget to onMount, and does not mount again when onMount changes', async () => {
    const { mounted, render } = app();
    const seen: unknown[] = [];
    await render({ ...BASE, onMount: (widget) => seen.push(widget) });
    await render({ ...BASE, onMount: () => undefined });

    assert.equal(seen.length, 1);
    assert.equal(mounted.length, 1);
    assert.equal('onMount' in (mounted[0] ?? {}), false, 'onMount is ours, not an option of init');
  });

  it('keys a function by its presence and an object by its value', () => {
    assert.equal(mountKey({ ...BASE, ignore: () => true }), mountKey({ ...BASE, ignore: () => false }));
    assert.notEqual(mountKey({ ...BASE, ignore: () => true }), mountKey(BASE));
    assert.notEqual(
      mountKey({ ...BASE, theme: { 'color-accent': '#000' } }),
      mountKey({ ...BASE, theme: { 'color-accent': '#fff' } }),
    );
  });
});
