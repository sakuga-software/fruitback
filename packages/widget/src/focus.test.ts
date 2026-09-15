import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepActiveElement, focusables } from './focus.ts';
import { mountPage } from './dom.fixture.ts';

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
