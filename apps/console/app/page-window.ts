/** A page number of a list, or « … » for the pages between two that are not shown. */
export type PageLink = number | 'gap';

/**
 * The pages a list offers to go to directly (FRU-587): the first, the one before, the one shown, the
 * one after, and the last. One page alone between two of them is shown, not « … ». `reach` says
 * which page has an address: a list read by a cursor knows the cursors of the pages it walked
 * through, and of the next one, and of no other. A page it cannot reach is not shown, and « … »
 * stands where it would be.
 */
export function pageWindow(at: number, count: number, reach: (page: number) => boolean = () => true): PageLink[] {
  const last = Math.max(count, at, 1);
  const wanted = new Set([1, at - 1, at, at + 1, last].filter((page) => page >= 1 && page <= last));
  const sorted = [...wanted].sort((one, other) => one - other);
  for (const [index, page] of sorted.entries()) {
    const before = sorted[index - 1];
    if (before !== undefined && page - before === 2) wanted.add(page - 1);
  }
  const shown = [...wanted].filter((page) => page === at || reach(page)).sort((one, other) => one - other);
  const links: PageLink[] = [];
  let previous = 0;
  for (const page of shown) {
    if (page - previous > 1) links.push('gap');
    links.push(page);
    previous = page;
  }
  if (previous < last) links.push('gap');

  return links;
}
