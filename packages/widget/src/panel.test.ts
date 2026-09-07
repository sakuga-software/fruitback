import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ConfigPanel, createConfigPanel } from './panel.ts';
import { createConfigStore, type WidgetConfig } from './config.ts';
import { type MountedPage, mountPage } from './dom.fixture.ts';

const DEFAULTS: WidgetConfig = {
  endpoint: 'http://localhost:8788',
  clientId: 'playground',
  hiddenStages: [],
  screenshot: false,
};

let panel: ConfigPanel | null = null;

afterEach(() => {
  panel?.destroy();
  panel = null;
});

function mount(defaults: WidgetConfig = DEFAULTS) {
  const page: MountedPage = mountPage('<main></main>');
  const store = createConfigStore({ defaults, storage: null });
  panel = createConfigPanel({ host: page.document.body, store, document: page.document });

  const input = (name: string) => page.document.querySelector(`[name="${name}"]`) as HTMLInputElement;

  return { page, store, input };
}

/** happy-dom does not fire input events by itself, so a typed value says so explicitly. */
function type(input: HTMLInputElement, value: string, document: Document): void {
  input.value = value;
  input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
}

function toggle(input: HTMLInputElement, checked: boolean, document: Document): void {
  input.checked = checked;
  input.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
}

describe('what the panel looks like (SKG-529)', () => {
  it('titles itself in words and closes with a drawing', () => {
    // The title opened with a sprout and the close button was a multiplication sign set at 18px —
    // one a character we do not control, the other a character standing in for an icon. The dialog
    // still names itself through aria-label, which is what a screen reader reads.
    const { page } = mount();
    const close = page.document.querySelector('.fruitback-config-close');

    assert.equal(page.document.querySelector('.fruitback-config-title')?.textContent, 'Réglages');
    assert.ok(close?.querySelector('svg.fruitback-icon'), 'the close button is not drawn');
    assert.equal(close?.textContent, '', 'the close button still carries a character');
    assert.equal(close?.getAttribute('aria-label'), 'Fermer les réglages');
  });
});

describe('createConfigPanel', () => {
  it('starts closed, because the widget is not a settings screen', () => {
    const { page } = mount();

    assert.equal((page.document.querySelector('[data-fruitback-config]') as HTMLElement).hidden, true);
    assert.equal(panel?.isOpen, false);
  });

  it('shows what the store holds when it opens', () => {
    const { input } = mount({
      endpoint: 'https://fb.acme.test',
      clientId: 'acme',
      hiddenStages: ['composted'],
      screenshot: false,
    });

    panel?.open();

    assert.equal(input('endpoint').value, 'https://fb.acme.test');
    assert.equal(input('client').value, 'acme');
    assert.equal(input('stage-composted').checked, false, 'a hidden stage is an unticked box');
    assert.equal(input('stage-ripe').checked, true);
  });

  it('writes a typed endpoint straight through, trimmed', () => {
    const { page, store, input } = mount();
    panel?.open();

    type(input('endpoint'), '  https://fb.acme.test  ', page.document);

    assert.equal(store.get().endpoint, 'https://fb.acme.test');
  });

  it('hides a stage when its box is unticked', () => {
    const { page, store, input } = mount();
    panel?.open();

    toggle(input('stage-ripe'), false, page.document);

    assert.deepEqual(store.get().hiddenStages, ['ripe']);
  });

  it('hides both resolved stages from the one shortcut', () => {
    const { page, store, input } = mount();
    panel?.open();

    toggle(input('hide-resolved'), true, page.document);

    assert.deepEqual(store.get().hiddenStages, ['ripe', 'composted']);
  });

  it('leaves the stages the reporter chose alone when the shortcut is used', () => {
    // The shortcut owns the two resolved stages and nothing else. Rewriting the whole set from it
    // would silently undo a choice made two clicks earlier.
    const { page, store, input } = mount({ ...DEFAULTS, hiddenStages: ['seeded'] });
    panel?.open();

    toggle(input('hide-resolved'), true, page.document);

    assert.deepEqual(store.get().hiddenStages, ['seeded', 'ripe', 'composted']);
  });

  it('repaints when the config changes from somewhere else', () => {
    // An open panel showing stale values overwrites the change on the next keystroke.
    const { store, input } = mount();
    panel?.open();

    store.set({ clientId: 'acme' });

    assert.equal(input('client').value, 'acme');
  });

  it('closes from its own button', () => {
    const { page } = mount();
    panel?.open();

    (page.document.querySelector('.fruitback-config-close') as HTMLElement).click();

    assert.equal(panel?.isOpen, false);
  });

  it('takes its DOM and its stylesheet with it when destroyed', () => {
    const { page } = mount();

    panel?.destroy();
    panel = null;

    assert.equal(page.document.querySelector('[data-fruitback-config]'), null);
    assert.equal(page.document.querySelector('style'), null);
  });
});
