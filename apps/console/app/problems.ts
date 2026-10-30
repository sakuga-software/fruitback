import { msg } from './i18n.ts';

/**
 * What a refused call says to the person (FRU-164).
 *
 * A screen used to have one sentence for every cause: a worker that answered `500` to a correct
 * address said « Paste the full address of the site ». The person then corrected an address that was
 * right. Each error says its own cause, and what to do: the proposition P7 of the first board.
 */

/**
 * No answer at all (FRU-516): no network, a server that is down, or no answer in time. The banner of
 * the root says the same while it lasts.
 */
export const UNREACHABLE_PROBLEM = msg('Fruitback could not be reached. Check your connection, then try again.');

/** An answer that is an error, a `5xx`: the server answered, so the connection is not the cause. */
export const SERVER_PROBLEM = msg('Fruitback hit an error. Try again in a moment.');

/**
 * The same two causes, beside a « Try again » button: the button is the action, so the sentence says
 * only the cause, and « Try again » is not said twice.
 */
export const UNREACHABLE_CAUSE = msg('Fruitback could not be reached. Check your connection.');
export const SERVER_CAUSE = msg('Fruitback hit an error.');

/** The sentence for a call that got no answer, or an error. Trying again can work in both cases. */
export function failureOf(failed: { status: number }): string {
  return failed.status === 0 ? UNREACHABLE_PROBLEM : SERVER_PROBLEM;
}

/** What the worker answers to a write of a suspended workspace (FRU-282), with `409`. */
export const WORKSPACE_SUSPENDED_ERROR = 'workspace-suspended';

/**
 * A write of a suspended workspace (FRU-328): the worker refuses it with `409 workspace-suspended`.
 * Trying again does not help, so the sentence says who can change it.
 */
export const WORKSPACE_SUSPENDED = msg(
  'This workspace is suspended, so nothing in it can change. Contact the administrator of this instance.',
);

/** `otherwise`, unless the call was refused because the workspace is suspended. */
export function writeProblemOf(failed: { error: string }, otherwise: string): string {
  return failed.error === WORKSPACE_SUSPENDED_ERROR ? WORKSPACE_SUSPENDED : otherwise;
}

/**
 * The sentence for a refused call.
 *
 * `named` holds a sentence for each code of the worker this screen knows. No answer (`status` 0) and
 * a `5xx` say what failed, not the person: see `failureOf`. Any other refusal says `otherwise`, a
 * sentence of the screen that blames no field.
 */
export function problemOf(
  failed: { status: number; error: string },
  named: Readonly<Record<string, string>>,
  otherwise: string,
): string {
  // Own keys only: a code named `constructor` must not find a method of `Object`.
  if (Object.hasOwn(named, failed.error)) return named[failed.error] as string;
  if (failed.status === 0 || failed.status >= 500) return failureOf(failed);

  return writeProblemOf(failed, otherwise);
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
