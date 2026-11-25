import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The stylesheets of the console hold no rule of a class (FRU-678). The kit and the screens draw with
 * Tailwind classes, in their components. `app.css` keeps the imports of HeroUI, its theme, the rules
 * of every element, the view transitions and the keyframes. `preview-scene.css` keeps the colours of
 * the example shop, named on `.scene`, and nothing else.
 */
const APP = new URL('./', import.meta.url);

/** The selectors of the rules of `source` that name a class, outside its comments and its keyframes. */
function classRules(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // A step of keyframes (`0%`, `from`) is no selector, and a value may hold a dot (`0.5`).
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const selectors = [...code.matchAll(/(?:^|[{};])\s*([^\s{};@][^{};]*?)\s*\{/g)].map((found) =>
    (found[1] as string).replace(/\s+/g, ' '),
  );

  return selectors.filter((selector) => /\.[a-z_-]/i.test(selector.replace(/\([^)]*\)/g, '')));
}

describe('the stylesheets of the console (FRU-678)', () => {
  it('app.css names no class: a component carries its classes', () => {
    assert.deepEqual(classRules(readFileSync(new URL('app.css', APP), 'utf8')), []);
  });

  it('preview-scene.css only names the colours of the shop, on .scene', () => {
    const source = readFileSync(new URL('preview-scene.css', APP), 'utf8');
    assert.deepEqual(classRules(source), ['.scene']);
    const declarations = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([a-z-]+)\s*:/g)].map(
      (found) => found[1] as string,
    );
    assert.ok(declarations.length > 5, 'no colour of the shop was read');
    assert.deepEqual(
      declarations.filter((name) => !name.startsWith('--scene-')),
      [],
    );
  });

  it('finds a rule of a class, and passes over a keyframe, a pseudo-element and a comment (the control)', () => {
    assert.deepEqual(
      classRules(
        [
          '/* .kit-button is drawn in ui.tsx */',
          ':focus-visible { outline: 2px solid; }',
          '::view-transition-old(rail) { display: none; }',
          '@keyframes x { 0% { opacity: 0.5; } to { opacity: 1; } }',
          '@media (prefers-reduced-motion: reduce) { ::view-transition-new(*) { animation: none; } }',
          '.kit-chip { padding: 0 14px; }',
          '@media (width < 640px) { .kit-browser__page:has(> .kit-browser__empty) { height: 280px; } }',
          'button, [role=switch] { white-space: nowrap; }',
        ].join('\n'),
      ),
      ['.kit-chip', '.kit-browser__page:has(> .kit-browser__empty)'],
    );
  });
});
