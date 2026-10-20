/**
 * What the extension declares to Firefox that it sends out of the browser (FRU-333). AMO refuses a
 * new extension that does not declare it, and Firefox shows the list at install. Decided by Mathieu,
 * 2026-10-20. Each category is the name Mozilla gives it, for what this extension sends to its
 * worker:
 *
 * - `websiteContent`: the selector, up to 160 characters of the element text, the page title, and the
 *   picture of the page when the reviewer takes one.
 * - `browsingActivity`: the address of the page of the note.
 * - `personalCommunications`: the text of the note.
 * - `personallyIdentifyingInfo`: a typed name, or the name and the address of a member in team mode.
 * - `authenticationInfo`: the session of the account that the extension keeps.
 *
 * Each one is required: the extension does not work without it, and it asks for no optional
 * permission later. WARNING: a field that the extension starts to send must be checked against this
 * list, and `docs/privacy.md` must name it.
 */
export const DATA_COLLECTION_PERMISSIONS = {
  required: [
    'websiteContent',
    'browsingActivity',
    'personalCommunications',
    'personallyIdentifyingInfo',
    'authenticationInfo',
  ],
};

/**
 * The first Firefox that shows the declaration itself. An older one would need a consent screen of
 * the extension, which it does not have.
 */
export const FIREFOX_MIN_VERSION = '140.0';
