import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { adoptStyles } from './stylesheet.ts';
import { mountPage, stylesIn } from './dom.fixture.ts';

describe('adoptStyles (FRU-522)', () => {
  it('adopts the CSS into the Shadow root of the host, with no <style> element', () => {
    // A <style> element is what a CSP `style-src 'self'` refuses: `e2e/csp.spec.ts` measures it.
    const page = mountPage('<div id="shell"></div>');
    const root = page.query('#shell').attachShadow({ mode: 'open' });
    const inner = page.document.createElement('div');
    root.append(inner);

    adoptStyles(root, '.a { color: red; }');
    adoptStyles(inner, '.b { color: blue; }');

    assert.equal(root.querySelector('style'), null);
    assert.equal(root.adoptedStyleSheets.length, 2);
    assert.equal(stylesIn(root), '.a { color: red; }\n.b { color: blue; }');
  });

  it('takes back its own sheet, and leaves the others', () => {
    const page = mountPage('<div id="shell"></div>');
    const root = page.query('#shell').attachShadow({ mode: 'open' });
    const first = adoptStyles(root, '.a { color: red; }');
    adoptStyles(root, '.b { color: blue; }');

    first.remove();

    assert.equal(stylesIn(root), '.b { color: blue; }');
  });

  it('writes a <style> element into a host whose root adopts no sheet', () => {
    // A detached element is its own root, and an element has no `adoptedStyleSheets`.
    const page = mountPage('');
    const host = page.document.createElement('div');

    const styles = adoptStyles(host, '.a { color: red; }');
    const style = host.querySelector('style');

    assert.equal(style?.textContent, '.a { color: red; }');
    assert.ok(style !== null && styles.owns(style));
    styles.remove();
    assert.equal(host.querySelector('style'), null);
  });

  it('is the one module that writes a <style> element', () => {
    const directory = new URL('./', import.meta.url);
    const writers = readdirSync(directory)
      .filter((file) => file.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(file))
      .filter((file) => /createElement\(\s*['"]style['"]\s*\)/.test(readFileSync(new URL(file, directory), 'utf8')));

    assert.deepEqual(writers, ['stylesheet.ts']);
  });
});
