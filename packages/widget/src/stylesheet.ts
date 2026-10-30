export type AdoptedStyles = {
  /** True for the `<style>` element of the fallback, which is a node of ours in the page. */
  owns(node: Node): boolean;
  remove(): void;
};

/**
 * Gives `css` to the Shadow root or the document that holds `host`, after the stylesheets it has.
 *
 * A page whose CSP says `style-src 'self'` refuses a `<style>` element, also in a Shadow root, and the
 * widget then shows the browser's own styles (FRU-522). The CSP does not apply to an adopted
 * stylesheet. A root without `adoptedStyleSheets` gets a `<style>` element in `host`.
 */
export function adoptStyles(host: Element | ShadowRoot, css: string): AdoptedStyles {
  const document = host.ownerDocument ?? (host as unknown as Document);
  const root = host.getRootNode() as Document | ShadowRoot;
  const Sheet = document.defaultView?.CSSStyleSheet;
  if (!('adoptedStyleSheets' in root) || Sheet === undefined || !('replaceSync' in Sheet.prototype)) {
    const style = document.createElement('style');
    style.textContent = css;
    host.append(style);

    return { owns: (node) => node === style, remove: () => style.remove() };
  }

  // A sheet of another window throws at the adoption: `Sheet` is the one of the document of `host`.
  const sheet = new Sheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];

  return {
    owns: () => false,
    remove: () => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    },
  };
}
