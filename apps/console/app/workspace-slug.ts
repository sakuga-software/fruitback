import { msg } from './i18n.ts';

/**
 * The short name of a workspace as a person types it in « General » (FRU-715): the `acme` of
 * `/w/acme`. The rule is the worker's (`workspace-slug.ts` of `apps/worker`): `[a-z0-9-]`, 3 to 40
 * characters, a letter or a digit at each end. The console checks the form before it sends, so a typo
 * is said at once; the reserved words and the names other workspaces hold are the worker's to say.
 */

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

export const MAX_SLUG = 40;

/** What the worker refuses when a short name is given, each with its sentence. */
export const SLUG_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-slug': msg('Use 3 to 40 lowercase letters, digits or hyphens, with a letter or a digit at each end.'),
  'reserved-slug': msg('This address is reserved for Fruitback. Choose another one.'),
  'slug-taken': msg('Another workspace already has this address. Choose another one.'),
};

/** The short name as it is sent: lower case, no space around. */
export function slugOf(typed: string): string {
  return typed.trim().toLowerCase();
}

/** The code of what is wrong with a typed short name, as the worker would say it, or `undefined`. */
export function slugRefusal(typed: string): 'invalid-slug' | undefined {
  return SLUG.test(slugOf(typed)) ? undefined : 'invalid-slug';
}
