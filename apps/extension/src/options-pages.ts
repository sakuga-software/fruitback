/**
 * The pages of the page of the extension (FRU-591): one page for each entry of the menu, in the one
 * `options.html`, chosen by the fragment of the address.
 *
 * The four sections stay in the DOM, and only the section of the page is shown. Thus a rule form
 * that is open, or a code that somebody typed, is still there when the person comes back. No
 * `browser` here: `entrypoints/options/main.ts` binds the fragment, and `options-pages.test.ts`
 * reads this on happy-dom.
 */

/** The pages, in the order of the menu. */
export const PAGES = ['sites', 'workers', 'share', 'prefs'] as const;

export type PageId = (typeof PAGES)[number];

/** The page of an address with no fragment, or with a fragment that names no page. */
export const DEFAULT_PAGE: PageId = 'sites';

/**
 * The page a fragment names. The fragment can carry a query after the name: the popup opens
 * `#workers?worker=…&code=…` for a pairing (`pairing.ts`, `rule-screens.ts`, `site-form.ts`).
 */
export function pageOf(hash: string): PageId {
  const name = hash.replace(/^#/, '').split('?')[0] ?? '';

  return PAGES.find((page) => page === name) ?? DEFAULT_PAGE;
}

/**
 * The id of the section of a page: `page-prefs`, never `prefs`. An element whose id is the fragment
 * makes the browser scroll to it at load, and at 390 px that hides the menu above the page.
 */
export function sectionId(page: PageId): string {
  return `page-${page}`;
}

/** The title of the tab for a page: « Preferences · Fruitback ». */
export function pageTitle(label: string): string {
  return `${label} · Fruitback`;
}

/**
 * Shows the section of `page` and hides the others, marks its entry in the menu, and sets the title
 * of the tab. A hidden section keeps its elements and their values.
 */
export function showPage(
  document: Document,
  options: { page: PageId; views: Record<PageId, HTMLElement>; labels: Record<PageId, string>; menu: HTMLElement },
): void {
  for (const page of PAGES) options.views[page].hidden = page !== options.page;
  for (const entry of options.menu.querySelectorAll<HTMLAnchorElement>('a.page-entry')) {
    if (entry.getAttribute('href') === `#${options.page}`) entry.setAttribute('aria-current', 'page');
    else entry.removeAttribute('aria-current');
  }
  document.title = pageTitle(options.labels[options.page]);
}
