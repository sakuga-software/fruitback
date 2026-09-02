import {
  type Seed,
  type SeedIssue,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  FRUITBACK_LABEL,
} from '@fruitback/shared';
import type { ClientPolicy } from './clients.ts';
import { type IssueNode, toSeedIssue } from './linear.ts';
import type { CreatedIssue, SeedIssueQuery, SeedStore } from './store.ts';

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

/**
 * Keyed by **client id**, not by team (SKG-522). A team is Linear's way of separating tenants and
 * this store has no reason to borrow it — the client id is what both paths already carry.
 */
type StoredIssue = IssueNode & { labels: string[]; clientId: string | undefined };

const issues: StoredIssue[] = [];

/**
 * New issues walk through the workflow states rather than all landing in `backlog`, so the overlay
 * shows every pin colour without anyone having to triage a fake ticket. `stageForLinearState` maps
 * these to seeded / green / ripening / ripe / composted.
 */
/**
 * Canned replies, so the dev loop shows a pin that has been answered (SKG-502).
 *
 * Every third issue gets a thread. A playground where nothing ever has comments makes the feature
 * invisible, and one where everything does hides the empty case — which is the one the widget has to
 * render without looking broken.
 */
const DEV_COMMENTS = [
  { body: 'Bien vu, on regarde ça cette semaine.', author: 'Alice' },
  { body: 'Corrigé sur la préprod — tu peux revérifier ?', author: 'Bruno' },
];

const DEV_STATES = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
] as const;

async function createSeedIssue(seed: Seed): Promise<CreatedIssue> {
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
    // Deliberately newest-first, like Linear's own default: the ordering is `toSeedComments`'s job,
    // and a fake that hands back an already-sorted list would never exercise it.
    comments: {
      nodes:
        number % 3 === 0
          ? [...DEV_COMMENTS].reverse().map((comment, index) => ({
              id: `dev_comment_${number}_${index}`,
              body: comment.body,
              createdAt: new Date(Date.now() - index * 60_000).toISOString(),
              user: { name: comment.author },
            }))
          : [],
    },
    labels: buildIssueLabels(seed),
    clientId: seed.client?.id,
  });

  return { id: `dev_issue_${number}`, identifier, url: `http://localhost/dev-issue/${identifier}` };
}

async function fetchSeedIssues(query: SeedIssueQuery, policy: ClientPolicy): Promise<SeedIssue[]> {
  const required = query.clientId ? [FRUITBACK_LABEL, clientLabelName(query.clientId)] : [FRUITBACK_LABEL];

  return (
    issues
      // Same isolation as the real filter, by the key this store actually holds.
      .filter((issue) => issue.clientId === query.clientId)
      .filter((issue) => required.every((label) => issue.labels.includes(label)))
      // `contains`, like the real filter — the exact URL check is `toSeedIssue`'s job, here as there.
      .filter((issue) => (issue.description ?? '').includes(query.url))
      // Same `toSeedIssue` as production, the policy included — which is what makes the dev loop
      // show exactly what a client with replies switched off would see.
      .map((issue) => toSeedIssue(issue, query.url, policy))
      .filter((issue): issue is SeedIssue => issue !== null)
  );
}

/** Test seam, and what makes each playground run start from an empty page. */
export function resetMemoryLinear(): void {
  issues.length = 0;
}

/**
 * The dev-loop store, as a `SeedStore` (SKG-522).
 *
 * It stays in this file, and it stays built on `toSeedIssue` from the real connector. That coupling
 * is the feature: an issue is stored as the description `buildIssueDescription` produces and read
 * back through production's own mapping, so a broken round trip breaks the playground too. Renaming
 * the file to something provider-agnostic would advertise an independence it does not have, and
 * should not have.
 *
 * What did change is that `app.ts` no longer special-cases it through a `fakeLinear` boolean: it is
 * one implementation among several, selected the same way any other is.
 */
export function createMemoryStore(): SeedStore {
  return {
    name: 'memory',
    // The client id is already part of the worker's cache key, so there is nothing further to
    // distinguish here — unlike Linear, where two clients can share one team.
    scope: () => 'memory',
    create: (seed) => createSeedIssue(seed),
    findForPage: (query, _client, policy) => fetchSeedIssues(query, policy),
  };
}
