/**
 * The « Frozen » mode of the gallery: a story stays in the state that its `play` gave, and nothing
 * on it reacts. The widget of Fruitback can then take a note on any element of the story.
 *
 * - The children of the root of the story are replaced by copies. A copy has no listener.
 * - The widget of the story is copied out of its shadow root into the page, with its styles, and
 *   then destroyed. Its elements are then in the document, where a selector finds them.
 */

export const FROZEN_CLASS = 'gallery-frozen';

const SOURCES = new WeakMap<CSSStyleSheet, string>();

/**
 * Keeps the text that each sheet of the document receives. Call it before the widget mounts.
 *
 * `cssText` of a rule loses a shorthand with `var()` that a longhand follows: `border: 1px solid
 * var(--x)` then `border-bottom-width: 2px` comes back as `border-bottom-width: 2px` alone. The copy
 * uses the text that the widget gave.
 */
export function keepSheetSources(): void {
  const prototype = CSSStyleSheet.prototype;
  const replaceSync = prototype.replaceSync;
  prototype.replaceSync = function (this: CSSStyleSheet, text: string) {
    SOURCES.set(this, text);
    replaceSync.call(this, text);
  };
}

/**
 * The rules of a shadow root, for a copy in the page. Out of the shadow root, a rule such as
 * `button { … }` applies to the whole page: so the text goes into `@scope` of the copy, and `:host`
 * becomes `:scope`, the copy. `@scope` cannot hold `@keyframes`, `@font-face` and `@property`, so
 * these are put outside too.
 */
export function scopedCss(texts: readonly string[], globals: readonly string[]): string {
  return [...globals, `@scope (.${FROZEN_CLASS}) {\n${texts.map(hostToScope).join('\n')}\n}`].join('\n');
}

/** `:host([a]) .b` → `:scope[a] .b`, and `:host` → `:scope`. A `:host()` holds one compound selector. */
export function hostToScope(css: string): string {
  return css.replace(/:host\(((?:[^()]|\([^()]*\))*)\)/g, ':scope$1').replace(/:host\b/g, ':scope');
}

function sheetsOf(root: ShadowRoot): { texts: string[]; globals: string[] } {
  const styles = [...root.querySelectorAll('style')];
  const sheets = [...root.adoptedStyleSheets, ...styles.map((style) => style.sheet)].filter(
    (sheet): sheet is CSSStyleSheet => sheet !== null,
  );
  const texts = [
    ...root.adoptedStyleSheets.map((sheet) => {
      const text = SOURCES.get(sheet);
      if (text === undefined) throw new Error('A sheet of the widget has no text: call keepSheetSources() first');

      return text;
    }),
    ...styles.map((style) => style.textContent ?? ''),
  ];
  const globals = sheets.flatMap((sheet) =>
    [...sheet.cssRules]
      .filter(
        (rule) =>
          rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule || rule instanceof CSSPropertyRule,
      )
      .map((rule) => rule.cssText),
  );

  return { texts, globals };
}

/** A copy keeps the attributes, not the values that a script or a person typed: these come along. */
function withValues<T extends Node>(source: T, copy: T): T {
  if (source instanceof Element && copy instanceof Element) {
    const fields = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    const copies = copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    fields.forEach((field, index) => {
      const target = copies[index];
      if (target === undefined) return;
      if (field instanceof HTMLTextAreaElement) target.textContent = field.value;
      else target.setAttribute('value', field.value);
    });
  }

  return copy;
}

/** A copy of `host` and of its shadow root, in the page, with no shadow root and no listener. */
export function flatten(host: HTMLElement): HTMLElement {
  const root = host.shadowRoot;
  const copy = host.ownerDocument.createElement('div');
  for (const { name, value } of host.attributes) {
    if (name !== 'data-fruitback-host') copy.setAttribute(name, value);
  }
  copy.classList.add(FROZEN_CLASS);
  // The layers of the copy keep their `z-index` inside the copy, under the layers of a live widget.
  copy.style.isolation = 'isolate';
  if (root === null) return copy;
  const style = host.ownerDocument.createElement('style');
  const { texts, globals } = sheetsOf(root);
  style.textContent = scopedCss(texts, globals);
  copy.append(
    style,
    ...[...root.childNodes]
      .filter((node) => node.nodeName !== 'STYLE')
      .map((node) => withValues(node, node.cloneNode(true))),
  );

  return copy;
}

/** The children of `root`, copied in place. */
export function freezeChildren(root: Element): void {
  root.replaceChildren(...[...root.childNodes].map((node) => withValues(node, node.cloneNode(true))));
}

/**
 * The corner of the dock of the copy: the other side of the dock of `beside`, the widget that stays
 * live. On the same corner, the dock of the copy covers the live one, and a click on « Leave a note »
 * reaches the copy, which does nothing. A host with no corner has its dock at the bottom right.
 */
export function cornerBeside(beside: string | undefined): string {
  const corner = beside ?? 'bottom-right';
  const [edge = 'bottom', side] = corner.split('-');

  return `${edge}-${side === 'left' ? 'right' : 'left'}`;
}
