import {
  DEFAULT_SEED_STAGE,
  type Seed,
  type SeedComment,
  type SeedIssue,
  type SeedStage,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  pageQueryTerm,
  parseSeedFromDescription,
  seedIssueSchema,
} from '@fruitback/shared';
import { z } from 'zod';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { type BatchAnswer, type CreatedIssue, type SeedIssueQuery, type SeedStore, StoreError } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Strawberry, so a Fruitback issue is recognisable at a glance in the Linear inbox. */
const FRUITBACK_LABEL_COLOR = '#E53935';

/**
 * This connector's own configuration, read once at boot and held by the store (FRU-29).
 *
 * It used to take the whole `WorkerConfig` per call, which is how `linearApiKey`, `linearTeamId` and
 * `linearProjectId` came to sit in the worker's validated config where every other module could see
 * them. A store's credentials are its own business.
 */
const linearConfigSchema = z.object({
  apiKey: z.string().min(1),
  teamId: z.string().min(1),
  projectId: z.string().min(1).optional(),
});

export type LinearConfig = z.infer<typeof linearConfigSchema>;

/** Where this connector puts a client's issues. Meaningless to a store that is not an issue tracker. */
export type LinearRouting = { teamId: string; projectId: string | undefined };

/**
 * A client's Linear routing, or the worker-wide default.
 *
 * The `?? config` fallback lives here rather than in `resolveClient` because falling back to *the
 * worker's team* is a rule about teams, and only this file knows what a team is.
 */
export function linearRoutingFor(config: LinearConfig, client: ClientConfig | undefined): LinearRouting {
  return { teamId: client?.teamId ?? config.teamId, projectId: client?.projectId ?? config.projectId };
}

/** Linear answered, and what it said is that this key is not one it accepts. */
export class LinearKeyRefused extends StoreError {}

/** Linear accepts the key, and the key does not have the rights for what was asked. */
export class LinearKeyForbidden extends StoreError {}

async function graphql<T>(config: LinearConfig, query: string, variables: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        // The value of the header as it goes: a personal API key raw, a token of OAuth with `Bearer`
        // in front (FRU-134). `linear-oauth.ts` builds the second.
        Authorization: config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    // A network failure is a store failure, so the widget keeps the note (FRU-34). A plain error
    // here reached the transport as a 500.
    throw new StoreError('Linear could not be reached');
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    errors?: { message: string; extensions?: { code?: unknown } }[];
  } | null;
  const message = payload?.errors?.map((error) => error.message).join('; ');

  // A key Linear does not accept, told apart from a Linear that is down (FRU-121): the first is for
  // the person who typed the key, the second is not their fault and not a reason to type it again.
  // Linear words a refusal as a status or as an error of the answer, so both are read.
  const refused =
    response.status === 401 ||
    payload?.errors?.some((error) => error.extensions?.code === 'AUTHENTICATION_ERROR') === true;
  if (refused) throw new LinearKeyRefused(message ?? `Linear responded ${response.status}`);
  // A key Linear knows and that may not do this: typing it again changes nothing.
  if (response.status === 403) throw new LinearKeyForbidden(message ?? 'Linear responded 403');

  if (!response.ok) {
    throw new StoreError(`Linear responded ${response.status}`);
  }
  if (message !== undefined && message !== '') {
    throw new StoreError(message);
  }
  if (!payload?.data) {
    throw new StoreError('Linear returned no data');
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
async function resolveLabelIds(config: LinearConfig, routing: LinearRouting, names: string[]): Promise<string[]> {
  const existing = await graphql<TeamLabelsResult>(config, TEAM_LABELS_QUERY, {
    teamId: routing.teamId,
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

    const created = await createLabel(config, routing, name);
    if (created !== null) resolved.push(created);
  }

  return resolved;
}

async function createLabel(config: LinearConfig, routing: LinearRouting, name: string): Promise<string | null> {
  try {
    const created = await graphql<CreateLabelResult>(config, CREATE_LABEL_MUTATION, {
      input: { name, teamId: routing.teamId, color: FRUITBACK_LABEL_COLOR },
    });

    return created.issueLabelCreate.issueLabel?.id ?? null;
  } catch {
    // Two concurrent first-feedbacks race here and one loses on the name uniqueness constraint.
    // The winner's label is what we wanted, so look it up again.
    const retry = await graphql<TeamLabelsResult>(config, TEAM_LABELS_QUERY, {
      teamId: routing.teamId,
      names: [name],
    }).catch(() => null);

    return retry?.team?.labels.nodes[0]?.id ?? null;
  }
}

/** Plant a seed in Linear: one issue, readable title, round-trip-able description, labels applied. */
export async function createSeedIssue(
  config: LinearConfig,
  routing: LinearRouting,
  seed: Seed,
  /** The language the description's prose is written in (FRU-39). English when nothing says. */
  locale?: string,
  /** The issue of the batch this seed belongs to (FRU-124): the seed becomes one of its sub-issues. */
  parentId?: string,
): Promise<CreatedIssue> {
  const labelIds = await resolveLabelIds(config, routing, buildIssueLabels(seed));

  const created = await graphql<CreateIssueResult>(config, CREATE_ISSUE_MUTATION, {
    input: {
      teamId: routing.teamId,
      projectId: routing.projectId,
      title: buildIssueTitle(seed),
      description: buildIssueDescription(seed, { locale }),
      labelIds,
      ...(parentId === undefined ? {} : { parentId }),
    },
  });

  if (!created.issueCreate.success || created.issueCreate.issue === null) {
    throw new StoreError('Linear refused to create the issue');
  }

  return created.issueCreate.issue;
}

/** The words of the parent of a batch, in the language of the team (FRU-39). */
const BATCH_WORDS: Record<'en' | 'fr', { title: (count: number, host: string) => string; lead: string }> = {
  en: {
    title: (count, host) => `${count} notes on ${host}`,
    lead: 'Sent together from Fruitback. Each note is a sub-issue, with its own state and its pin on the page.',
  },
  fr: {
    title: (count, host) => `${count} notes sur ${host}`,
    lead: 'Envoyées ensemble depuis Fruitback. Chaque note est un sous-ticket, avec son état et son pin sur la page.',
  },
};

/**
 * The parent of a batch (FRU-124): a title, a sentence and the list of the notes. **It holds no
 * seed**: `parseSeedFromDescription` finds none in it, so no read draws it as a pin. Its state is the
 * team's business, and the widget never reads it.
 */
export function batchParent(seeds: readonly Seed[], locale?: string): { title: string; description: string } {
  const words = BATCH_WORDS[locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en'];
  const hosts = [...new Set(seeds.map((seed) => new URL(seed.page.url).host))];
  const list = seeds.map((seed) => `- ${buildIssueTitle(seed)} (${seed.page.url})`);

  return { title: words.title(seeds.length, hosts.join(', ')), description: [words.lead, '', ...list].join('\n') };
}

/**
 * A batch in Linear (FRU-124): one parent issue, then one sub-issue for each seed, in order. A
 * parent that Linear refuses throws, and nothing is written. A sub-issue that it refuses is answered
 * as such, and the next ones are still sent: each one is a note somebody wrote.
 */
export async function createSeedBatch(
  config: LinearConfig,
  routing: LinearRouting,
  seeds: readonly Seed[],
  locale?: string,
): Promise<BatchAnswer[]> {
  const parent = batchParent(seeds, locale);
  const labelIds = await resolveLabelIds(config, routing, buildIssueLabels(seeds[0] as Seed));
  const created = await graphql<CreateIssueResult>(config, CREATE_ISSUE_MUTATION, {
    input: { teamId: routing.teamId, projectId: routing.projectId, ...parent, labelIds },
  });
  if (!created.issueCreate.success || created.issueCreate.issue === null) {
    throw new StoreError('Linear refused to create the issue of the batch');
  }
  const parentId = created.issueCreate.issue.id;

  const answers: BatchAnswer[] = [];
  for (const seed of seeds) {
    try {
      answers.push({ issue: await createSeedIssue(config, routing, seed, locale, parentId) });
    } catch (error) {
      // WARNING: nothing is thrown from here. The parent exists, and the notes before this one are
      // kept: an error that left this loop would answer `500`, lose their answers, and the next
      // attempt would write a second parent. An error that is not Linear's is said in the log.
      if (!(error instanceof StoreError)) console.error('[fruitback] a note of a batch failed', error);
      answers.push({ error: 'store-unavailable' });
    }
  }

  return answers;
}

const ISSUES_QUERY = `
  query FruitbackIssues($filter: IssueFilter!, $first: Int!, $after: String, $comments: Int!) {
    issues(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        url
        title
        updatedAt
        description
        state { id name type }
        comments(first: $comments) {
          nodes { id body createdAt user { name } }
        }
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
  /** `id` is what a connector's exceptions name (FRU-102). The in-memory Linear has none. */
  state: { id?: string; name: string; type: string } | null;
  comments?: { nodes: CommentNode[] } | null;
};

export type CommentNode = {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string } | null;
};

type IssuesResult = {
  issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
};

/** Linear caps a page at 250; 50 keeps a single-page answer the common case for one screen. */
const ISSUES_PAGE_SIZE = 50;

/** Spread, so "not asked for" stays absent rather than becoming an empty list that means "none". */
function optionalComments(comments: SeedComment[] | undefined): { comments?: SeedComment[] } {
  return comments === undefined ? {} : { comments };
}

/**
 * Comments fetched per issue (FRU-13).
 *
 * Bounded because this rides along with every read of every pin on a page: fifty issues with an
 * unbounded comment list is a payload nobody asked for and a Linear bill somebody pays. A thread
 * longer than this belongs in Linear, which the pin links to.
 */
export const COMMENTS_PER_ISSUE = 20;

/**
 * Stop walking after this many pages. A page with 500 pins is not a page the widget can render
 * anyway, and an unbounded loop turns one bad query into an outage of our own making.
 */
const ISSUES_MAX_PAGES = 10;

/**
 * The seeds planted on one page, as the widget needs them to re-plant its pins.
 *
 * Linear filters by team and by `description contains <canonical url>`, so the workspace can hold
 * any number of issues without this walking them. **The client is read from the seed, never from a
 * label** (FRU-138): a label is put on an issue when Linear allows it, and a team can refuse that to
 * the key or to the application. An issue found by its labels only was a note that Linear kept and
 * no page showed again.
 */
export async function fetchSeedIssues(
  config: LinearConfig,
  routing: LinearRouting,
  query: SeedIssueQuery,
  policy: ClientPolicy,
  stages: StageExceptions = {},
): Promise<SeedIssue[]> {
  const filter = buildSeedIssueFilter(routing, query);
  const found: SeedIssue[] = [];
  let after: string | null = null;

  for (let page = 0; page < ISSUES_MAX_PAGES; page += 1) {
    const result: IssuesResult = await graphql(config, ISSUES_QUERY, {
      filter,
      first: ISSUES_PAGE_SIZE,
      after,
      // One, not zero, when this client has replies turned off. `toSeedIssue` is what keeps the
      // promise — it drops them whatever comes back — so this number only decides how much is
      // fetched. `first: 0` may or may not be accepted by Linear, and a read that fails outright for
      // those clients would be a far worse bug than one wasted comment on the wire.
      comments: policy.showComments ? COMMENTS_PER_ISSUE : 1,
    });

    for (const node of result.issues.nodes) {
      const issue = toSeedIssue(node, query.url, policy, stages);
      // The write path stores the normalized client id in the seed, so the two are equal for every
      // note of this client. A read that names no client gets every seed of the page, as before.
      if (issue === null || (query.clientId !== undefined && issue.seed.client?.id !== query.clientId)) continue;
      found.push(issue);
    }

    after = result.issues.pageInfo.hasNextPage ? result.issues.pageInfo.endCursor : null;
    if (after === null) break;
  }

  return found;
}

function buildSeedIssueFilter(routing: LinearRouting, { url, clientId }: SeedIssueQuery): Record<string, unknown> {
  return {
    // The API key can see the whole workspace; a seed only ever lives on the team its client routes
    // to, which on a multi-tenant worker is what keeps one client's read off another's issues.
    team: { id: { eq: routing.teamId } },
    // No clause on the labels: see `fetchSeedIssues`. The page and the client are both looked for
    // in the description, where the seed is written. The client narrows what Linear sends, so the
    // notes of another client of the team do not fill the pages this read walks. It is a substring,
    // like the page: `fetchSeedIssues` compares both exactly.
    and: [
      { description: { contains: pageQueryTerm(url) } },
      ...(clientId === undefined ? [] : [{ description: { contains: clientId } }]),
    ],
  };
}

/**
 * Oldest first, which is how a conversation reads.
 *
 * Linear returns comments newest-first by default and the widget renders what it is given, so the
 * order is settled here rather than in two places later.
 */
function toSeedComments(node: IssueNode): SeedComment[] | undefined {
  if (node.comments == null) return undefined;

  return node.comments.nodes
    .map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.user?.name ? { author: comment.user.name } : {}),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Linear's workflow state types, projected onto the pin's ripeness.
 *
 * This is the connector's half of the status story, and it lives here rather than in
 * `@fruitback/shared` because it is Linear's vocabulary (FRU-23). The contract owns `SeedStage`;
 * every connector owns the projection onto it. GitHub's projection gives three stages, not five: see
 * `stageForGithubIssue` in `github.ts` (FRU-32).
 */
export const LINEAR_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  // Real state type on the SKG team ("Duplicate"), and absent from Linear's documented list.
  'duplicate',
] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

const STAGE_BY_STATE_TYPE: Record<LinearStateType, SeedStage> = {
  triage: 'seeded',
  backlog: 'seeded',
  unstarted: 'green',
  started: 'ripening',
  completed: 'ripe',
  canceled: 'composted',
  duplicate: 'composted',
};

/** An unrecognised state colours the pin rather than hiding it — see `DEFAULT_SEED_STAGE`. */
export function stageForLinearState(stateType: string): SeedStage {
  return STAGE_BY_STATE_TYPE[stateType as LinearStateType] ?? DEFAULT_SEED_STAGE;
}

/**
 * The stages a connector gives to some states, by the **id** of the state (FRU-102). A state with no
 * entry takes the stage of its type.
 */
export type StageExceptions = Readonly<Record<string, SeedStage>>;

/**
 * The stage of a state: its exception, or the stage of its type. `Object.hasOwn`, so a state whose
 * id is `constructor` is not read from the prototype.
 */
function stageOf(state: IssueNode['state'], stages: StageExceptions): SeedStage {
  const id = state?.id;
  if (id !== undefined && Object.hasOwn(stages, id)) return stages[id] as SeedStage;

  return stageForLinearState(state?.type ?? '');
}

/**
 * `routing` decides whether replies come back, and it decides here — the one function both the real
 * Linear and the in-memory one go through.
 *
 * Applied on this side rather than only through the query's `first:` argument, because `first: 0` is
 * an assumption about what Linear accepts, and the promise — a client that turned replies off never
 * has them returned — should not rest on a backend behaving a particular way. The query still asks
 * for none, so nothing is fetched only to be discarded.
 */
export function toSeedIssue(
  node: IssueNode,
  canonicalUrl: string,
  policy?: Pick<ClientPolicy, 'showComments'>,
  stages: StageExceptions = {},
): SeedIssue | null {
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
    stage: stageOf(node.state, stages),
    stateName: node.state?.name ?? '',
    updatedAt: node.updatedAt,
    ...optionalComments(policy?.showComments === false ? undefined : toSeedComments(node)),
    seed: parsed.seed,
  };

  // Validated against the shared contract rather than trusted: this is the exact shape the widget
  // parses on the other side, and a field Linear stopped returning must not reach it as `undefined`.
  const result = seedIssueSchema.safeParse(candidate);

  return result.success ? result.data : null;
}

export type LinearTeam = { id: string; name: string; key: string; projects: { id: string; name: string }[] };

const TEAMS_QUERY = `
  query FruitbackTeams {
    viewer { name }
    organization { name }
    teams(first: 100) {
      nodes { id name key projects(first: 50) { nodes { id name } } }
    }
  }
`;

/**
 * Who this key belongs to and the teams it reaches (FRU-121): what the console needs to offer a
 * destination. Throws a `StoreError` for a key Linear refuses.
 */
export async function listLinearTeams(
  apiKey: string,
): Promise<{ viewer: string; organization: string; teams: LinearTeam[] }> {
  const data = await graphql<{
    viewer?: { name?: unknown };
    organization?: { name?: unknown };
    teams?: {
      nodes?: {
        id?: unknown;
        name?: unknown;
        key?: unknown;
        projects?: { nodes?: { id?: unknown; name?: unknown }[] };
      }[];
    };
  }>({ apiKey, teamId: 'none' }, TEAMS_QUERY, {});

  return {
    viewer: typeof data.viewer?.name === 'string' ? data.viewer.name : '',
    // The workspace of Linear. A connector made with OAuth is named after it: its actor is the application.
    organization: typeof data.organization?.name === 'string' ? data.organization.name : '',
    teams: (data.teams?.nodes ?? []).flatMap((team) => {
      if (typeof team.id !== 'string' || typeof team.name !== 'string') return [];

      return [
        {
          id: team.id,
          name: team.name,
          key: typeof team.key === 'string' ? team.key : '',
          projects: (team.projects?.nodes ?? []).flatMap((project) =>
            typeof project.id === 'string' && typeof project.name === 'string'
              ? [{ id: project.id, name: project.name }]
              : [],
          ),
        },
      ];
    }),
  };
}

/** A workflow state of a team, as the panel of a connector shows it (FRU-102). */
export type LinearState = { id: string; name: string; type: string; teamId: string; team: string; stage: SeedStage };

const STATES_QUERY = `
  query FruitbackStates($teams: [ID!]) {
    workflowStates(first: 250, filter: { team: { id: { in: $teams } } }) {
      nodes { id name type position team { id name } }
    }
  }
`;

/**
 * The workflow states of these teams, each with the stage of its type: what the panel of a connector
 * offers to change. In the order of each team's board. Throws a `StoreError` for a key Linear refuses.
 */
export async function listLinearStates(apiKey: string, teamIds: readonly string[]): Promise<LinearState[]> {
  if (teamIds.length === 0) return [];
  const data = await graphql<{
    workflowStates?: {
      nodes?: {
        id?: unknown;
        name?: unknown;
        type?: unknown;
        position?: unknown;
        team?: { id?: unknown; name?: unknown };
      }[];
    };
  }>({ apiKey, teamId: 'none' }, STATES_QUERY, { teams: [...teamIds] });

  const states = (data.workflowStates?.nodes ?? []).flatMap((node) => {
    const { id, name, type, position, team } = node;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') return [];
    if (typeof team?.id !== 'string' || !teamIds.includes(team.id)) return [];

    return [
      {
        id,
        name,
        type,
        teamId: team.id,
        team: typeof team.name === 'string' ? team.name : '',
        stage: stageForLinearState(type),
        position: typeof position === 'number' ? position : 0,
      },
    ];
  });

  return states
    .sort((a, b) => teamIds.indexOf(a.teamId) - teamIds.indexOf(b.teamId) || a.position - b.position)
    .map(({ position: _position, ...state }) => state);
}

/**
 * Linear, as a `SeedStore` (FRU-29).
 *
 * Everything above already existed; this is the adapter that lets `app.ts` stop importing it by
 * name. Bound to its configuration at construction rather than handed the worker's config per call,
 * which is what a store holding a connection — SQLite (FRU-31) — is going to need.
 */
export function createLinearStore(config: LinearConfig, stages: StageExceptions = {}): SeedStore {
  return {
    name: 'linear',
    // The team, because that is what separates one tenant's issues from another's here. The worker
    // used to reach for `routing.teamId` itself, which meant the read cache knew how Linear routes.
    scope: (client) => linearRoutingFor(config, client).teamId,
    create: (seed, client, policy) => createSeedIssue(config, linearRoutingFor(config, client), seed, policy.locale),
    createBatch: (seeds, client, policy) =>
      createSeedBatch(config, linearRoutingFor(config, client), seeds, policy.locale),
    findForPage: (query, client, policy) =>
      fetchSeedIssues(config, linearRoutingFor(config, client), query, policy, stages),
  };
}

/**
 * Linear as a selectable store (FRU-33): `FRUITBACK_STORE=linear`, which is also the default.
 *
 * The three variables are named **here** rather than in `env.ts`. They were in the worker's own
 * validated config, which meant every deployment was checked for a Linear key — including the ones
 * that will not have one. A store's credentials are its own business, and so is saying which
 * variable an operator forgot.
 */
export function createLinearStoreSpec(): StoreSpec {
  return defineStore({
    provider: 'linear',
    envNames: { apiKey: 'LINEAR_API_KEY', teamId: 'LINEAR_TEAM_ID', projectId: 'LINEAR_PROJECT_ID' },
    read: (env) => ({
      apiKey: env.LINEAR_API_KEY,
      teamId: env.LINEAR_TEAM_ID,
      // An empty string is an operator who left the line in their .env, not a project id.
      projectId: env.LINEAR_PROJECT_ID || undefined,
    }),
    schema: linearConfigSchema,
    create: createLinearStore,
  });
}
