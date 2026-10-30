import { msg } from './i18n.ts';
import { DID_NOT_ANSWER, WORKSPACE_SUSPENDED, WORKSPACE_SUSPENDED_ERROR } from './problems.ts';

/**
 * What « Connect an agent » does with a refused « Allow » or « Deny » (FRU-467).
 *
 * Only a `404` means that the request is gone: it is unknown, it ended, or it was answered. A `409`
 * is a choice the worker refused before it spent the request (too many agents, a suspended
 * workspace, another account), so the page stays and says why (review of #664).
 */
export type AnswerRefusal = { is: 'signed-out' } | { is: 'gone' } | { is: 'refused'; problem: string };

const ANOTHER_ACCOUNT = msg(
  'This tab was open for another account, so it stopped: nothing was sent from it. Load it again to go on.',
);

const REFUSALS: Record<string, string> = {
  'too-many-keys': msg('This workspace holds 20 agents already. Revoke one in Agents, then start again.'),
  'unknown-site': msg('A site you ticked is gone. Read the page again.'),
  forbidden: msg('Only an owner or an admin of this workspace can connect an agent to it.'),
  [WORKSPACE_SUSPENDED_ERROR]: WORKSPACE_SUSPENDED,
  'account-changed': ANOTHER_ACCOUNT,
  'tab-left': ANOTHER_ACCOUNT,
};

export function refusalOf(failed: { status: number; error: string }): AnswerRefusal {
  if (failed.status === 401) return { is: 'signed-out' };
  if (failed.status === 404) return { is: 'gone' };

  return { is: 'refused', problem: REFUSALS[failed.error] ?? DID_NOT_ANSWER };
}
