import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedStage } from '@fruitback/shared';
import { type ConfigPanel, createConfigPanel, createOfferedStages } from './panel.ts';
import { createConfigStore, type WidgetConfig } from './config.ts';
import { type MountedPage, mountPage } from './dom.fixture.ts';

const DEFAULTS: WidgetConfig = {
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

function toggle(input: HTMLInputElement, checked: boolean, document: Document): void {
  input.checked = checked;
  input.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
}

describe('what the panel looks like (FRU-36)', () => {
  it('titles itself in words and closes with a drawing', () => {
    // The title opened with a sprout and the close button was a multiplication sign set at 18px —
    // one a character we do not control, the other a character standing in for an icon. The dialog
    // still names itself through aria-label, which is what a screen reader reads.
    const { page } = mount();
    const close = page.document.querySelector('.fruitback-config-close');

    assert.equal(page.document.querySelector('.fruitback-config-title')?.textContent, 'Settings');
    assert.ok(close?.querySelector('svg.fruitback-icon'), 'the close button is not drawn');
    assert.equal(close?.textContent, '', 'the close button still carries a character');
    assert.equal(close?.getAttribute('aria-label'), 'Close settings');
  });
});

describe('createConfigPanel', () => {
  it('starts closed, because the widget is not a settings screen', () => {
    const { page } = mount();

    assert.equal((page.document.querySelector('[data-fruitback-config]') as HTMLElement).hidden, true);
    assert.equal(panel?.isOpen, false);
  });

  it('shows what the store holds when it opens', () => {
    const { input } = mount({ hiddenStages: ['composted'], screenshot: false });

    panel?.open();

    assert.equal(input('stage-composted').checked, false, 'a hidden stage is an unticked box');
    assert.equal(input('stage-ripe').checked, true);
  });

  it('holds no field to type in: where the notes go is not for the reporter to say (FRU-89)', () => {
    const { page } = mount();
    panel?.open();

    const inputs = [...page.document.querySelectorAll('[data-fruitback-config] input')] as HTMLInputElement[];

    assert.ok(inputs.length > 0, 'the panel holds no control at all, so the check below proves nothing');
    assert.deepEqual([...new Set(inputs.map((input) => input.type))], ['checkbox']);
    assert.equal(page.document.querySelector('[data-fruitback-config] textarea, [data-fruitback-config] select'), null);
  });

  it('puts the focus on its first control when it opens', () => {
    const { page, input } = mount();

    panel?.open();

    assert.ok(page.document.activeElement === input('stage-seeded'));
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

    store.set({ hiddenStages: ['green'] });

    assert.equal(input('stage-green').checked, false);
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

describe('copying the feedback as text (FRU-109)', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function mountCopying(clipboard: { writeText(text: string): Promise<void> } | undefined) {
    const page: MountedPage = mountPage('<main></main>');
    Object.defineProperty(page.view.navigator, 'clipboard', { value: clipboard, configurable: true });
    const store = createConfigStore({ defaults: DEFAULTS, storage: null });
    let asked = 0;
    panel = createConfigPanel({
      host: page.document.body,
      store,
      document: page.document,
      exportText: () => `# Feedback, asked ${++asked}`,
    });
    panel.open();

    const button = page.document.querySelector('.fruitback-config-copy-button') as HTMLButtonElement;
    const status = () => page.document.querySelector('.fruitback-config-copy-status')?.textContent;
    const manual = () => page.document.querySelector('.fruitback-config-copy-text') as HTMLTextAreaElement | null;

    return { page, button, status, manual };
  }

  it('has no button when it was given nothing to copy', () => {
    const { page } = mount();

    assert.equal(page.document.querySelector('.fruitback-config-copy-button'), null);
  });

  it('writes the text to the clipboard and says so', async () => {
    const written: string[] = [];
    const { button, status, manual } = mountCopying({ writeText: async (text) => void written.push(text) });

    assert.equal(button.textContent, 'Copy the feedback as text');
    button.click();
    await settle();

    assert.deepEqual(written, ['# Feedback, asked 1']);
    assert.equal(status(), 'Copied');
    assert.equal(manual(), null, 'a field showed for a copy that worked');
  });

  it('reads the text again at each click, because the pins change', async () => {
    const written: string[] = [];
    const { button } = mountCopying({ writeText: async (text) => void written.push(text) });

    button.click();
    await settle();
    button.click();
    await settle();

    assert.deepEqual(written, ['# Feedback, asked 1', '# Feedback, asked 2']);
  });

  for (const [refusal, clipboard] of [
    ['refuses', { writeText: async () => Promise.reject(new Error('NotAllowedError')) }],
    ['is absent', undefined],
  ] as const) {
    it(`shows the text to copy by hand when the clipboard ${refusal}`, async () => {
      const { page, button, status, manual } = mountCopying(clipboard);

      button.click();
      await settle();

      assert.equal(status(), 'Copy the text from here');
      assert.equal(manual()?.value, '# Feedback, asked 1');
      assert.equal(manual()?.readOnly, true);
      assert.equal(manual()?.getAttribute('aria-label'), 'Copy the text from here');
      assert.ok(page.document.activeElement === manual(), 'the field with the text has no focus');
    });
  }

  it('takes the field away when a later copy works', async () => {
    let allowed = false;
    const { button, status, manual } = mountCopying({
      writeText: async () => (allowed ? undefined : Promise.reject(new Error('refused'))),
    });
    button.click();
    await settle();
    assert.notEqual(manual(), null);

    allowed = true;
    button.click();
    await settle();

    assert.equal(manual(), null);
    assert.equal(status(), 'Copied');
  });
});

describe('the stages a store can report (FRU-32)', () => {
  const GITHUB: SeedStage[] = ['seeded', 'ripe', 'composted'];

  function mountOffering(stages: SeedStage[], defaults: WidgetConfig = DEFAULTS) {
    const page: MountedPage = mountPage('<main></main>');
    const store = createConfigStore({ defaults, storage: null });
    const offered = createOfferedStages();
    offered.set(stages);
    panel = createConfigPanel({ host: page.document.body, store, document: page.document, stages: offered });

    const input = (name: string) => page.document.querySelector(`[name="${name}"]`) as HTMLInputElement;
    const label = (name: string) => input(name).closest('label') as HTMLLabelElement;

    return { page, store, offered, input, label };
  }

  it('offers a box only for the stages the store reports', () => {
    const { label } = mountOffering(GITHUB);

    assert.equal(label('stage-green').hidden, true);
    assert.equal(label('stage-ripening').hidden, true);
    for (const stage of GITHUB) assert.equal(label(`stage-${stage}`).hidden, false, stage);
    assert.equal(label('hide-resolved').hidden, false);
  });

  it('offers every stage if nothing says otherwise', () => {
    const { page } = mount();

    const hidden = [...page.document.querySelectorAll('.fruitback-config-check')].filter(
      (element) => (element as HTMLElement).hidden,
    );
    assert.deepEqual(hidden, []);
  });

  it('follows a later read that reports other stages', () => {
    const { offered, label } = mountOffering([...GITHUB]);

    offered.set(['seeded']);

    assert.equal(label('stage-ripe').hidden, true);
    // The shortcut controls only resolved stages. With none to offer, it would do nothing.
    assert.equal(label('hide-resolved').hidden, true);
  });

  it('keeps a stage the reporter hid, when the store stops reporting it', () => {
    const { page, store, input } = mountOffering(GITHUB, { ...DEFAULTS, hiddenStages: ['green'] });

    toggle(input('stage-ripe'), false, page.document);

    assert.deepEqual(store.get().hiddenStages, ['green', 'ripe']);
  });

  it('leaves a resolved stage the store does not offer as the reporter set it', () => {
    // Found in review: unticking the shortcut also showed `composted` again, with no box to say so.
    const { page, store, input } = mountOffering(['seeded', 'ripe'], {
      ...DEFAULTS,
      hiddenStages: ['ripe', 'composted'],
    });

    toggle(input('hide-resolved'), false, page.document);
    assert.deepEqual(store.get().hiddenStages, ['composted']);

    toggle(input('hide-resolved'), true, page.document);
    assert.deepEqual(store.get().hiddenStages, ['ripe', 'composted']);
  });

  it('ticks the shortcut from the resolved stages the store offers', () => {
    const { input } = mountOffering(['seeded', 'ripe'], { ...DEFAULTS, hiddenStages: ['ripe'] });

    assert.equal(input('hide-resolved').checked, true);
  });

  it('draws no hidden box, whatever display the class sets', () => {
    // The class sets display:flex, which beats the browser's own rule for the hidden attribute.
    // happy-dom does no layout, so the rule is read from the stylesheet.
    const { page } = mount();
    const css = [...page.document.querySelectorAll('style')].map((style) => style.textContent).join('\n');

    assert.match(css, /\.fruitback-config-check\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });
});

describe('the panel as a dialog (FRU-51)', () => {
  function keyOn(page: MountedPage, target: Element, key: string, shiftKey = false): KeyboardEvent {
    const KeyboardEventCtor = (page.view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    const event = new KeyboardEventCtor('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    return event;
  }

  it('is a modal dialog', () => {
    const { page } = mount();
    const root = page.document.querySelector('[data-fruitback-config]');

    assert.equal(root?.getAttribute('role'), 'dialog');
    assert.equal(root?.getAttribute('aria-modal'), 'true');
  });

  it('closes on Escape and gives focus back to what opened it', () => {
    const { page, input } = mount();
    const gear = page.document.createElement('button');
    page.document.body.append(gear);
    gear.focus();

    panel?.open();
    assert.ok(page.document.activeElement === input('stage-seeded'), 'the first box has no focus after the open');
    keyOn(page, input('stage-seeded'), 'Escape');

    assert.equal(panel?.isOpen, false);
    assert.ok(page.document.activeElement === gear, 'focus did not go back to the gear');
  });

  it('brings Tab back in after a click moved focus to the page, and only while open', () => {
    const { page, input } = mount();
    const outside = page.document.createElement('button');
    page.document.body.append(outside);
    panel?.open();
    const close = page.document.querySelector('.fruitback-config-close') as HTMLButtonElement;

    outside.focus();
    assert.equal(keyOn(page, outside, 'Tab').defaultPrevented, true);
    assert.ok(page.document.activeElement === close, 'Tab from the page left the panel behind');

    outside.focus();
    keyOn(page, outside, 'Tab', true);
    assert.ok(page.document.activeElement === input('hide-resolved'), 'Shift+Tab from the page did not come back');

    panel?.close();
    outside.focus();
    assert.equal(keyOn(page, outside, 'Tab').defaultPrevented, false, 'a closed panel still takes Tab');
  });

  it('keeps Tab inside, in both directions', () => {
    const { page, input } = mount();
    panel?.open();
    const close = page.document.querySelector('.fruitback-config-close') as HTMLButtonElement;

    close.focus();
    keyOn(page, close, 'Tab', true);
    assert.ok(
      page.document.activeElement === input('hide-resolved'),
      'Shift+Tab on the first control did not go to the last',
    );

    keyOn(page, input('hide-resolved'), 'Tab');
    assert.ok(page.document.activeElement === close, 'Tab on the last control did not go back to the first');
  });
});
