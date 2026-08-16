import {
  type Seed,
  type SeedIssue,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  FRUITBACK_LABEL,
} from '@fruitback/shared';
import type { Routing } from './clients.ts';
import type { WorkerConfig } from './env.ts';
import { type CreatedIssue, type IssueNode, toSeedIssue } from './linear.ts';

/**
 * Linear, in memory, for the dev loop (SKG-511).
 *
 * The playground needs the whole round — capture, issue, pins coloured by state — and the real thing
 * needs an API key and writes into a workspace people actually triage. This stands in for it, behind
 * `FRUITBACK_FAKE_LINEAR` and never in production (see `usesFakeLinear`).
 *
 * It is deliberately not a mock: an issue is stored as the **description string**
 * `buildIssueDescription` produces, and read back through the same `toSeedIssue` the real path uses.
 * So the dev loop exercises the round trip for real, and a seed that stops parsing breaks the
 * playground the same way it would break production — which is the entire point of having one.
 *
 * `apps/worker/src/linear-stub.ts` is a different thing: it fakes `fetch` for the unit tests. This
 * one is a store the running process serves from.
 */

type StoredIssue = IssueNode & { labels: string[]; teamId: string };

const issues: StoredIssue[] = [];

/**
 * New issues walk through the workflow states rather than all landing in `backlog`, so the overlay
 * shows every pin colour without anyone having to triage a fake ticket. `stageForLinearState` maps
 * these to seeded / green / ripening / ripe / composted.
 */
const DEV_STATES = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
] as const;

export async function createSeedIssue(_config: WorkerConfig, routing: Routing, seed: Seed): Promise<CreatedIssue> {
  const number = issues.length + 1;
  const state = DEV_STATES[number % DEV_STATES.length] ?? DEV_STATES[0];
  const identifier = `DEV-${String(number).padStart(3, '0')}`;

  issues.push({
    id: `dev_issue_${number}`,
    identifier,
    // Deliberately not a linear.app URL: a dev pin must not offer a link that 404s on the real one.
    url: `http://localhost/dev-issue/${identifier}`,
    title: buildIssueTitle(seed),
    updatedAt: new Date().toISOString(),
    description: buildIssueDescription(seed),
    state: { name: state.name, type: state.type },
    labels: buildIssueLabels(seed),
    teamId: routing.teamId,
  });

  return { id: `dev_issue_${number}`, identifier, url: `http://localhost/dev-issue/${identifier}` };
}

export async function fetchSeedIssues(
  _config: WorkerConfig,
  routing: Routing,
  query: { url: string; clientId?: string },
): Promise<SeedIssue[]> {
  const required = query.clientId ? [FRUITBACK_LABEL, clientLabelName(query.clientId)] : [FRUITBACK_LABEL];

  return (
    issues
      // Same isolation as the real filter: a read only ever sees the team it routes to.
      .filter((issue) => issue.teamId === routing.teamId)
      .filter((issue) => required.every((label) => issue.labels.includes(label)))
      // `contains`, like the real filter — the exact URL check is `toSeedIssue`'s job, here as there.
      .filter((issue) => (issue.description ?? '').includes(query.url))
      .map((issue) => toSeedIssue(issue, query.url))
      .filter((issue): issue is SeedIssue => issue !== null)
  );
}

/** Test seam, and what makes each playground run start from an empty page. */
export function resetMemoryLinear(): void {
  issues.length = 0;
}
