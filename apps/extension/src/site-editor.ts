import { PATTERN_PROBLEM, type SiteFields, complaint, siteFrom } from './site-form.ts';
import { parseSitePattern } from './site-patterns.ts';
import type { SiteConfig } from './sites.ts';

/**
 * What the options page does when a button adds a rule or switches one on (SKG-536).
 *
 * Behind seams so `node --test` reaches it, the same split `bridge.ts` makes. Two rules hold here:
 *
 * - **`request` is called before anything is awaited.** A host permission may only be asked for while
 *   a click is handled, and one `await` in front of the request loses the click. So the duplicate
 *   check reads `current`, the list the page last drew, and not storage.
 * - **Nothing is written unless the request was granted.** An entry stored without its grant is shown
 *   as **On** while the background registers nothing for it.
 */

export const DUPLICATE_PROBLEM = 'A rule for that pattern already exists. Remove it first.';
export const NO_ACCESS_PROBLEM = 'Fruitback needs access to those sites to run there. Nothing was saved.';

/** A change the background did not confirm. It can still be stored if only the answer was lost. */
export const STORE_PROBLEM = 'Fruitback could not confirm that change. Check the list, then try again.';

export type EditorSeams = {
  request: (pattern: string) => Promise<boolean>;
  write: (pattern: string, site: SiteConfig) => Promise<void>;
  current: () => Record<string, SiteConfig>;
  /** Called after a rule is stored switched on: the tabs already open on it get the scripts. */
  activate: (pattern: string) => Promise<void>;
};

export type RuleFields = SiteFields & { sites: string };

export function createEditor({ request, write, current, activate }: EditorSeams): {
  add: (fields: RuleFields) => Promise<string>;
  switchOn: (pattern: string, site: SiteConfig) => Promise<boolean>;
} {
  return {
    /** Answers the problem to show, or `''` once the rule is stored. */
    add(fields) {
      const pattern = parseSitePattern(fields.sites);
      if (pattern === undefined) return Promise.resolve(PATTERN_PROBLEM);
      if (current()[pattern] !== undefined) return Promise.resolve(DUPLICATE_PROBLEM);
      const problem = complaint(fields);
      if (problem !== '') return Promise.resolve(problem);

      return request(pattern).then(
        async (granted) => {
          if (!granted) return NO_ACCESS_PROBLEM;
          try {
            await write(pattern, siteFrom(fields, true));
          } catch {
            return STORE_PROBLEM;
          }
          await activate(pattern);

          return '';
        },
        // A request the browser rejects rather than refuses. Nothing was stored either way.
        () => NO_ACCESS_PROBLEM,
      );
    },

    switchOn(pattern, site) {
      return request(pattern).then(
        async (granted) => {
          if (!granted) return false;
          await write(pattern, { ...site, enabled: true });
          await activate(pattern);

          return true;
        },
        // A request the browser rejects is a refusal too: nothing was stored, so it is not a failed write.
        () => false,
      );
    },
  };
}

/**
 * Tells an async render whether a newer one started after it.
 *
 * A storage change and a permission change can each start a render, and each render awaits. The
 * older one can finish last and draw a list that is no longer true.
 */
export function latestOnly(): () => () => boolean {
  let generation = 0;

  return () => {
    const mine = ++generation;

    return () => mine === generation;
  };
}
