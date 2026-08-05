import { type Seed, buildIssueDescription, buildIssueLabels, buildIssueTitle } from '@fruitback/shared';
import type { WorkerConfig } from './env';

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
