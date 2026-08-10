import {
  FRUITBACK_LABEL,
  type Seed,
  type SeedIssue,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  pageQueryTerm,
  parseSeedFromDescription,
  seedIssueSchema,
  stageForLinearState,
} from '@fruitback/shared';
import type { WorkerConfig } from './env.ts';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Strawberry, so a Fruitback issue is recognisable at a glance in the Linear inbox. */
const FRUITBACK_LABEL_COLOR = '#E53935';

export class LinearError extends Error {}

export type CreatedIssue = { id: string; identifier: string; url: string };

async function graphql<T>(config: WorkerConfig, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      // Personal API keys go in `Authorization` raw — no `Bearer` prefix (that is for OAuth tokens).
      Authorization: config.linearApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new LinearError(`Linear responded ${response.status}`);
  }

  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (payload.errors?.length) {
    throw new LinearError(payload.errors.map((error) => error.message).join('; '));
  }
  if (!payload.data) {
    throw new LinearError('Linear returned no data');
  }

  return payload.data;
}

const TEAM_LABELS_QUERY = `
  query FruitbackLabels($teamId: String!, $names: [String!]) {
    team(id: $teamId) {
      labels(filter: { name: { in: $names } }) {
        nodes { id name }
      }
    }
  }
`;

const CREATE_LABEL_MUTATION = `
  mutation FruitbackCreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      issueLabel { id name }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation FruitbackCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url }
    }
  }
`;

type TeamLabelsResult = { team: { labels: { nodes: { id: string; name: string }[] } } | null };
type CreateLabelResult = { issueLabelCreate: { issueLabel: { id: string; name: string } | null } };
type CreateIssueResult = { issueCreate: { success: boolean; issue: CreatedIssue | null } };

/**
 * Resolve label names to ids, creating the ones that do not exist yet — a new client site must not
 * require a manual Linear setup step before its first feedback.
 *
 * A label that cannot be resolved is dropped rather than failing the request: losing a label is a
 * triage annoyance, losing the client's feedback is a bug.
 */
async function resolveLabelIds(config: WorkerConfig, names: string[]): Promise<string[]> {
  const existing = await graphql<TeamLabelsResult>(config, TEAM_LABELS_QUERY, {
    teamId: config.linearTeamId,
    names,
  });

  const idsByName = new Map((existing.team?.labels.nodes ?? []).map((label) => [label.name, label.id]));
  const resolved: string[] = [];

  for (const name of names) {
    const known = idsByName.get(name);
    if (known !== undefined) {
      resolved.push(known);
      continue;
    }

    const created = await createLabel(config, name);
    if (created !== null) resolved.push(created);
  }

  return resolved;
}

async function createLabel(config: WorkerConfig, name: string): Promise<string | null> {
  try {
    const created = await graphql<CreateLabelResult>(config, CREATE_LABEL_MUTATION, {
      input: { name, teamId: config.linearTeamId, color: FRUITBACK_LABEL_COLOR },
    });

    return created.issueLabelCreate.issueLabel?.id ?? null;
  } catch {
    // Two concurrent first-feedbacks race here and one loses on the name uniqueness constraint.
    // The winner's label is what we wanted, so look it up again.
    const retry = await graphql<TeamLabelsResult>(config, TEAM_LABELS_QUERY, {
      teamId: config.linearTeamId,
      names: [name],
    }).catch(() => null);

    return retry?.team?.labels.nodes[0]?.id ?? null;
  }
}

/** Plant a seed in Linear: one issue, readable title, round-trip-able description, labels applied. */
export async function createSeedIssue(config: WorkerConfig, seed: Seed): Promise<CreatedIssue> {
  const labelIds = await resolveLabelIds(config, buildIssueLabels(seed));

  const created = await graphql<CreateIssueResult>(config, CREATE_ISSUE_MUTATION, {
    input: {
      teamId: config.linearTeamId,
      projectId: config.linearProjectId,
      title: buildIssueTitle(seed),
      description: buildIssueDescription(seed),
      labelIds,
    },
  });

  if (!created.issueCreate.success || created.issueCreate.issue === null) {
    throw new LinearError('Linear refused to create the issue');
  }

  return created.issueCreate.issue;
}

const ISSUES_QUERY = `
  query FruitbackIssues($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        url
        title
        updatedAt
        description
        state { name type }
      }
    }
  }
`;

/** Exported so the in-memory Linear can hand back the same shape and share the mapping below. */
export type IssueNode = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  updatedAt: string;
  description: string | null;
  state: { name: string; type: string } | null;
};

type IssuesResult = {
  issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
};

/** Linear caps a page at 250; 50 keeps a single-page answer the common case for one screen. */
const ISSUES_PAGE_SIZE = 50;

/**
 * Stop walking after this many pages. A page with 500 pins is not a page the widget can render
 * anyway, and an unbounded loop turns one bad query into an outage of our own making.
 */
const ISSUES_MAX_PAGES = 10;

export type SeedIssueQuery = {
  /** Already canonical — the caller normalizes before it gets here. */
  url: string;
  clientId?: string;
};

/**
 * The seeds planted on one page, as the widget needs them to re-plant its pins.
 *
 * Everything is filtered server-side by Linear (label + `description contains <canonical url>`), so
 * the workspace can hold any number of issues without this walking them.
 */
export async function fetchSeedIssues(config: WorkerConfig, query: SeedIssueQuery): Promise<SeedIssue[]> {
  const filter = buildSeedIssueFilter(config, query);
  const found: SeedIssue[] = [];
  let after: string | null = null;

  for (let page = 0; page < ISSUES_MAX_PAGES; page += 1) {
    const result: IssuesResult = await graphql(config, ISSUES_QUERY, { filter, first: ISSUES_PAGE_SIZE, after });

    for (const node of result.issues.nodes) {
      const issue = toSeedIssue(node, query.url);
      if (issue !== null) found.push(issue);
    }

    after = result.issues.pageInfo.hasNextPage ? result.issues.pageInfo.endCursor : null;
    if (after === null) break;
  }

  return found;
}

function buildSeedIssueFilter(config: WorkerConfig, { url, clientId }: SeedIssueQuery): Record<string, unknown> {
  const labels = clientId ? [FRUITBACK_LABEL, clientLabelName(clientId)] : [FRUITBACK_LABEL];

  return {
    // The API key can see the whole workspace; a seed only ever lives on the configured team.
    team: { id: { eq: config.linearTeamId } },
    // One clause per label, each spelled `some`: a comparator placed directly on the collection
    // reads as "some label matches" too, but only implicitly. A single
    // `name: { in: [fruitback, fruitback:acme] }` would be a different query altogether — it matches
    // *either* label, and the client label is what keeps one client's pins off another's site.
    and: labels.map((name) => ({ labels: { some: { name: { eq: name } } } })),
    description: { contains: pageQueryTerm(url) },
  };
}

export function toSeedIssue(node: IssueNode, canonicalUrl: string): SeedIssue | null {
  const parsed = parseSeedFromDescription(node.description);
  // Someone edited the block away, or a newer Fruitback wrote it: a pin we cannot place is worse
  // than one we do not show.
  if (!parsed.ok) return null;

  // `description contains` is a substring match, so a query for `/pricing` also brings back the
  // seeds of `/pricing?tab=annual`. The seed itself is the authority on which page it belongs to.
  if (parsed.seed.page.url !== canonicalUrl) return null;

  const candidate = {
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    title: node.title,
    stage: stageForLinearState(node.state?.type ?? ''),
    stateName: node.state?.name ?? '',
    updatedAt: node.updatedAt,
    seed: parsed.seed,
  };

  // Validated against the shared contract rather than trusted: this is the exact shape the widget
  // parses on the other side, and a field Linear stopped returning must not reach it as `undefined`.
  const result = seedIssueSchema.safeParse(candidate);

  return result.success ? result.data : null;
}
