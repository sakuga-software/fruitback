import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepActiveElement, focusables, holdFocus } from './focus.ts';
import { keyboardEventCtor, mountPage } from './dom.fixture.ts';

describe('focusables', () => {
  it('keeps what Tab reaches and drops what it does not', () => {
    const page = mountPage(`
      <div id="dialog">
        <button id="first">A</button>
        <button disabled>B</button>
        <div hidden><input id="hidden" /></div>
        <span tabindex="-1">C</span>
        <a>no href</a>
        <a id="link" href="#x">D</a>
        <textarea id="last"></textarea>
      </div>`);

    const ids = focusables(page.query('#dialog')).map((element) => element.id);

    assert.deepEqual(ids, ['first', 'link', 'last']);
  });
});

describe('deepActiveElement', () => {
  it('reads through a Shadow root, where the document answers the host', () => {
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const button = page.document.createElement('button');
    root.append(button);

    button.focus();

    assert.ok(page.document.activeElement === host, 'the document no longer answers the host');
    assert.ok(deepActiveElement(page.document) === button, 'the Shadow root was not read');
  });
});

describe('holdFocus with two dialogs open', () => {
  it('lets only the dialog opened last keep Tab, then gives it back', () => {
    const page = mountPage('<main><button id="outside">Page</button></main>');
    const dialog = (id: string) => {
      const root = page.document.createElement('div');
      root.setAttribute('aria-modal', 'true');
      const button = page.document.createElement('button');
      button.id = id;
      root.append(button);
      page.document.body.append(root);

      return { root, button };
    };
    const tab = (target: Element) =>
      target.dispatchEvent(new (keyboardEventCtor(page))('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const popover = dialog('in-popover');
    const panel = dialog('in-panel');
    // Built in the other order than they open, so the order of the listeners cannot decide for them.
    const panelHold = holdFocus(panel.root, () => {});
    const popoverHold = holdFocus(popover.root, () => {});

    popoverHold.remember();
    panelHold.remember();
    popover.button.focus();
    tab(popover.button);
    assert.ok(page.document.activeElement === panel.button, 'the popover opened first still keeps Tab');

    const outside = page.query('#outside') as HTMLButtonElement;
    outside.focus();
    tab(outside);
    assert.ok(page.document.activeElement === panel.button, 'a Tab from the page went to the popover opened first');

    panelHold.restore();
    popover.button.focus();
    tab(popover.button);
    assert.ok(page.document.activeElement === popover.button, 'the popover did not get Tab back');

    popoverHold.destroy();
    panelHold.destroy();
  });
});
