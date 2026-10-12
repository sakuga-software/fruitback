import { msg } from './i18n.ts';

/**
 * What a refused call says to the person (FRU-164).
 *
 * A screen used to have one sentence for every cause: a worker that answered `500` to a correct
 * address said « Paste the full address of the site ». The person then corrected an address that was
 * right. Each error says its own cause, and what to do: the proposition P7 of the first board.
 */

/** The worker did not answer, or it failed. Trying again can work. */
export const DID_NOT_ANSWER = msg('Fruitback did not answer. Try again.');

/**
 * The sentence for a refused call.
 *
 * `named` holds a sentence for each code of the worker this screen knows. No answer (`status` 0) and
 * a `5xx` say that Fruitback did not answer: the person did nothing wrong. Any other refusal says
 * `otherwise`, a sentence of the screen that blames no field.
 */
export function problemOf(
  failed: { status: number; error: string },
  named: Readonly<Record<string, string>>,
  otherwise: string,
): string {
  // Own keys only: a code named `constructor` must not find a method of `Object`.
  if (Object.hasOwn(named, failed.error)) return named[failed.error] as string;
  if (failed.status === 0 || failed.status >= 500) return DID_NOT_ANSWER;

  return otherwise;
}

/** What the worker refuses when a site is added, on the screen of the sites and in the setup. */
export const SITE_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-url': msg('Paste the full address of the site, starting with https://.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a site.'),
};
export const SITE_NOT_ADDED = msg('The site was not added. Try again.');

/** What the worker refuses when a workspace is named. */
export const NAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A workspace needs a name of one line, up to 80 characters.'),
};
export const WORKSPACE_NOT_CREATED = msg('The workspace was not created. Try again.');

/**
 * Puts a text in the clipboard, and says whether the browser took it.
 *
 * A browser can refuse: a permission that was denied, a page that is not in a secure context (then
 * `navigator.clipboard` does not exist, and reading it throws). The caller says so, and the text
 * stays on the screen to select by hand.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}
