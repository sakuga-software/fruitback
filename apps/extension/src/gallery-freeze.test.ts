import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { cornerBeside, freezeChildren } from '../gallery/freeze.ts';

describe('the frozen copy of the widget in the gallery (FRU-579)', () => {
  it('keeps in the copy the state that a play gave to each field: text, box, choice and option', () => {
    const window = new HappyDomWindow();
    const previous = globalThis.Node;
    globalThis.Node = window.Node as unknown as typeof Node;
    try {
      const root = window.document.createElement('div');
      root.innerHTML = `<form><input name="text" value="before"><input type="checkbox" name="box" value="yes"><input type="radio" name="pick" value="a" checked><input type="radio" name="pick" value="b"><textarea></textarea><select><option>one</option><option>two</option></select></form>`;
      const field = <T>(selector: string): T => root.querySelector(selector) as T;
      field<HTMLInputElement>('[name=text]').value = 'typed';
      field<HTMLInputElement>('[name=box]').checked = true;
      field<HTMLInputElement>('[value=b]').checked = true;
      field<HTMLTextAreaElement>('textarea').value = 'a reply';
      field<HTMLSelectElement>('select').selectedIndex = 1;

      freezeChildren(root as unknown as Element);

      assert.equal(field<HTMLInputElement>('[name=text]').value, 'typed');
      assert.equal(field<HTMLInputElement>('[name=box]').checked, true);
      assert.equal(field<HTMLInputElement>('[name=box]').value, 'yes');
      assert.equal(field<HTMLInputElement>('[value=a]').checked, false);
      assert.equal(field<HTMLInputElement>('[value=b]').checked, true);
      assert.equal(field<HTMLTextAreaElement>('textarea').value, 'a reply');
      assert.equal(field<HTMLSelectElement>('select').value, 'two');
    } finally {
      globalThis.Node = previous;
      void window.happyDOM.close();
    }
  });

  it('puts the dock of the copy on the other side of the dock of the live widget', () => {
    assert.equal(cornerBeside(undefined), 'bottom-left');
    assert.equal(cornerBeside('bottom-right'), 'bottom-left');
    assert.equal(cornerBeside('bottom-left'), 'bottom-right');
    assert.equal(cornerBeside('top-left'), 'top-right');
    assert.equal(cornerBeside('top-right'), 'top-left');
  });
});
