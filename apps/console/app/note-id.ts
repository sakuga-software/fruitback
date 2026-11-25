/**
 * The site of a note from its id in the console (FRU-658): the worker makes the id `base64url` of
 * `[site, note]` (`noteIdOf` of `console-notes.ts`). For a note the list does not hold, whose panel
 * was opened by its link. Empty for an id that is not one.
 */
export function siteOfId(id: string): string {
  try {
    const read: unknown = JSON.parse(atob(id.replace(/-/gu, '+').replace(/_/gu, '/')));

    return Array.isArray(read) && read.length === 2 && typeof read[0] === 'string' ? read[0] : '';
  } catch {
    return '';
  }
}
