import { DUPLICATE_PROBLEM, NO_ACCESS_PROBLEM, STORE_PROBLEM } from './site-editor.ts';
import { PATTERN_PROBLEM, STALE_TEAM_WILDCARD, WILDCARD_TEAM_PROBLEM } from './site-form.ts';
import type { PairFailure } from './session.ts';
import type { SitesImport } from './site-transfer.ts';

/**
 * What a reviewer does next about a problem (FRU-90).
 *
 * A message that states a problem and stops leaves the reviewer to guess. Each problem the popup and
 * the options page can say is in `PROBLEMS`, with the one thing to do about it, or with the reason
 * there is none. `showProblem` draws the button from this table, so the two pages cannot drift.
 */

/** What a failed pairing is, in the words of the reviewer. */
export const PAIRING_PROBLEM: Record<PairFailure | 'blocked', string> = {
  'code-spent-or-expired': 'That code has been used or has expired. Ask for a new one.',
  unavailable: 'The worker did not answer. Try again.',
  'insecure-endpoint': 'That worker is on plain http. A session must not cross it.',
  blocked: 'Fruitback needs permission to reach that worker.',
};

export const PAIRING_NEEDS_HTTPS = 'Pairing needs https (localhost excepted): a session must not cross http.';
export const PAIRING_CODE_REQUIRED = 'The pairing code is required.';

export const IMPORT_PROBLEM: Record<Extract<SitesImport, { ok: false }>['reason'], string> = {
  'not-json': 'That file is not JSON.',
  'not-a-sites-file': 'That file is not a Fruitback rules file.',
  'newer-version': 'That file comes from a newer Fruitback. Update the extension, then import it again.',
};

/** Where the guide says how a pairing code is made. */
export const PAIRING_GUIDE = 'https://sakuga-software.github.io/fruitback/reviewing.html#3-pair-in-team-mode';

export type Remedy =
  /** Do the same thing again. The click on the button is the gesture a permission prompt needs. */
  | 'retry'
  /** The same, named for what the browser asks next. */
  | 'grant'
  /** Open the fields of the rule: the worker it names is what is wrong. */
  | 'change'
  /** Read the list of rules: the change can be stored although its answer was lost. */
  | 'list'
  /** Read about it. The reviewer cannot fix it from the browser. */
  | 'guide';

/** The words on the button. One word for one remedy, on both pages. */
export const REMEDY_LABEL: Record<Remedy, string> = {
  retry: 'Try again',
  grant: 'Grant access',
  change: 'Change the worker',
  list: 'Check the list',
  guide: 'How to get a code',
};

export type Problem = { text: string } & ({ remedy: Remedy } | { remedy: null; why: string });

/** Every problem the two pages can say. A message that is not here gets no button. */
export const PROBLEMS: readonly Problem[] = [
  { text: PAIRING_PROBLEM['code-spent-or-expired'], remedy: 'guide' },
  { text: PAIRING_PROBLEM.unavailable, remedy: 'retry' },
  { text: PAIRING_PROBLEM['insecure-endpoint'], remedy: 'change' },
  { text: PAIRING_PROBLEM.blocked, remedy: 'grant' },
  { text: PAIRING_NEEDS_HTTPS, remedy: 'change' },
  { text: PAIRING_CODE_REQUIRED, remedy: null, why: 'The field to fill in is beside the message.' },
  { text: NO_ACCESS_PROBLEM, remedy: 'grant' },
  { text: STORE_PROBLEM, remedy: 'list' },
  { text: DUPLICATE_PROBLEM, remedy: null, why: 'The rule to remove is in the list above the form.' },
  { text: PATTERN_PROBLEM, remedy: null, why: 'The field to correct is beside the message.' },
  { text: WILDCARD_TEAM_PROBLEM, remedy: null, why: 'The field to correct is beside the message.' },
  { text: STALE_TEAM_WILDCARD, remedy: null, why: 'The row offers Remove, and nothing else can run that rule.' },
  { text: IMPORT_PROBLEM['not-json'], remedy: null, why: 'Only another file changes the answer.' },
  { text: IMPORT_PROBLEM['not-a-sites-file'], remedy: null, why: 'Only another file changes the answer.' },
  { text: IMPORT_PROBLEM['newer-version'], remedy: null, why: 'The browser updates the extension, not this page.' },
];

export function remedyFor(text: string): Remedy | null {
  return PROBLEMS.find((problem) => problem.text === text)?.remedy ?? null;
}
