import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cornerBeside, hostToScope, keepSheetSources, scopedCss, sourceOf } from '../gallery/freeze.ts';

describe('the frozen copy of the widget in the gallery (FRU-579)', () => {
  it('makes each :host the root of the scope, with the attributes it tests', () => {
    assert.equal(hostToScope(':host { all: initial; }'), ':scope { all: initial; }');
    assert.equal(
      hostToScope(":host([data-fruitback-position$='-left']) .fruitback-dock { left: 24px; }"),
      ":scope[data-fruitback-position$='-left'] .fruitback-dock { left: 24px; }",
    );
    assert.equal(hostToScope(':host(:not([hidden])) .a {}'), ':scope:not([hidden]) .a {}');
    assert.equal(hostToScope('.fruitback-host-launch {}'), '.fruitback-host-launch {}');
    assert.equal(hostToScope(':host(:not(:has(a))) b {}'), ':scope:not(:has(a)) b {}');
    assert.equal(hostToScope(':host-context(.dark) {}'), ':host-context(.dark) {}');
    assert.equal(hostToScope(':host([a]), :host([b]) c {}'), ':scope[a], :scope[b] c {}');
  });

  it('keeps the text of each sheet, from replaceSync and from replace, and patches the prototype once', async () => {
    const calls: string[] = [];
    class Sheet {
      replaceSync(text: string): void {
        calls.push(`sync ${text}`);
      }
      async replace(text: string): Promise<this> {
        calls.push(`async ${text}`);
        return this;
      }
    }
    const prototype = Sheet.prototype as unknown as CSSStyleSheet;
    keepSheetSources(prototype);
    const patched = { replaceSync: prototype.replaceSync, replace: prototype.replace };
    keepSheetSources(prototype);
    assert.equal(prototype.replaceSync, patched.replaceSync);
    assert.equal(prototype.replace, patched.replace);
    const one = new Sheet() as unknown as CSSStyleSheet;
    const two = new Sheet() as unknown as CSSStyleSheet;
    one.replaceSync('a {}');
    await two.replace('b {}');
    assert.equal(sourceOf(one), 'a {}');
    assert.equal(sourceOf(two), 'b {}');
    assert.deepEqual(calls, ['sync a {}', 'async b {}']);
  });

  it('keeps every rule of the widget inside the copy, and the at-rules that a scope cannot hold outside', () => {
    const css = scopedCss(
      ['button { border: 0; }', ':host { color: red; }'],
      ['@keyframes spin { to { rotate: 1turn; } }'],
    );
    assert.equal(
      css,
      '@keyframes spin { to { rotate: 1turn; } }\n@scope (.gallery-frozen) {\nbutton { border: 0; }\n:scope { color: red; }\n}',
    );
  });

  it('puts the dock of the copy on the other side of the dock of the live widget', () => {
    assert.equal(cornerBeside(undefined), 'bottom-left');
    assert.equal(cornerBeside('bottom-right'), 'bottom-left');
    assert.equal(cornerBeside('bottom-left'), 'bottom-right');
    assert.equal(cornerBeside('top-left'), 'top-right');
    assert.equal(cornerBeside('top-right'), 'top-left');
  });
});
