import { type KeyObject, createPrivateKey, sign } from 'node:crypto';
import {
  DEFAULT_SEED_STAGE,
  FRUITBACK_LABEL,
  type Seed,
  type SeedComment,
  type SeedIssue,
  type SeedStage,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  parseSeedFromDescription,
  seedIssueSchema,
} from '@fruitback/shared';
import { z } from 'zod';
import { type ClientConfig, type ClientPolicy, REPOSITORY_PATTERN } from './clients.ts';
import { type CreatedIssue, type SeedIssueQuery, type SeedStore, StoreError } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

/**
 * GitHub Issues, as a `SeedStore` (SKG-525).
 *
 * The worker signs in as a GitHub App, not with a personal token. A personal token does not expire
 * and reaches every repository of its owner. An installation token expires after one hour, and this
 * store asks for a token that reaches one repository only.
 *
 * GitHub has two issue states, so this store reports three stages and declares them in `stages`.
 */

const GITHUB_API = 'https://api.github.com';

/** Strawberry, like the Linear label. GitHub wants the hex value without `#`. */
const LABEL_COLOR = 'E53935';

/** GitHub refuses an app JWT whose `exp` is more than ten minutes ahead. */
const APP_JWT_LIFETIME_SECONDS = 9 * 60;

/** GitHub recommends this backdate of `iat`, because the two clocks can differ. */
const CLOCK_DRIFT_SECONDS = 60;

/** If a token has less time left than this, the store mints a new one before the call. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The largest page GitHub gives. */
const ISSUES_PAGE_SIZE = 100;

/**
 * The read stops after this many pages, the newest issues first. A client with more than 1,000
 * Fruitback issues loses its oldest pins from the page.
 */
const ISSUES_MAX_PAGES = 10;

/** Same cap as the Linear store. The thread keeps the newest comments. */
const COMMENTS_PER_ISSUE = 20;

const githubConfigSchema = z.object({
  /** The App ID, or its client ID. GitHub accepts both as `iss`. */
  appId: z.string().min(1),
  privateKey: z.string().transform((pem, context) => {
    try {
      // A `.env` file holds one line, so the PEM can arrive with its line breaks written as `\n`.
      const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
      if (key.asymmetricKeyType === 'rsa') return key;
    } catch {
      // The issue below names the variable. The key itself must never reach a message.
    }
    context.addIssue({ code: 'custom', message: 'not an RSA private key' });

    return z.NEVER;
  }),
  repository: z.string().regex(REPOSITORY_PATTERN),
});

export type GithubConfig = z.infer<typeof githubConfigSchema>;

export type GithubStoreOptions = {
  /** For the tests. The token cache and the JWT read the clock from here. */
  now?: () => number;
};

/** The stages `stageForGithubIssue` can return, in `SEED_STAGES` order. */
export const GITHUB_STAGES: readonly SeedStage[] = ['seeded', 'ripe', 'composted'];

/**
 * An issue's state and `state_reason`, projected onto the pin's ripeness.
 *
 * An issue closed before GitHub added `state_reason` has no reason. Closed then meant done, so it is
 * `ripe`. A state this store does not know gets the contract's default, so the pin stays visible.
 */
export function stageForGithubIssue(state: string, stateReason: string | null | undefined): SeedStage {
  if (state === 'open') return 'seeded';
  if (state !== 'closed') return DEFAULT_SEED_STAGE;

  return stateReason === 'not_planned' || stateReason === 'duplicate' ? 'composted' : 'ripe';
}

function stateNameFor(state: string, stateReason: string | null | undefined): string {
  if (state === 'open') return 'Open';
  if (state !== 'closed') return state;
  if (stateReason === 'not_planned') return 'Not planned';
  if (stateReason === 'duplicate') return 'Duplicate';

  return 'Closed';
}

/** A client's repository, or the worker's. */
export function repositoryFor(config: GithubConfig, client: ClientConfig | undefined): string {
  return client?.repository ?? config.repository;
}

/** An RS256 JWT that authenticates the App itself. It can only ask for an installation token. */
export function signAppJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({ iat: now - CLOCK_DRIFT_SECONDS, exp: now + APP_JWT_LIFETIME_SECONDS, iss: appId });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');

  return `${header}.${payload}.${signature}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A failed GitHub call. The message holds the status only, because `app.ts` sends it to the widget. */
class GithubResponseError extends StoreError {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`GitHub responded ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

type GithubCall = { method?: 'GET' | 'POST'; token: string; body?: unknown };

async function githubFetch(path: string, { method = 'GET', token, body }: GithubCall): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub refuses a request with no User-Agent.
        'User-Agent': 'fruitback-worker',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // A network failure is a store failure: the widget keeps the note and tries again.
    throw new StoreError('GitHub could not be reached');
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new GithubResponseError(response.status, payload);

  return payload;
}

const installationSchema = z.object({ id: z.number() });
const accessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string() });

type InstallationToken = { token: string; expiresAt: number };

type TokenSource = { get(repository: string): Promise<string>; drop(repository: string): void };

/**
 * One installation token per repository, shared by every request.
 *
 * The store finds the installation from the repository, so a client repository in another
 * organisation needs no more configuration. The App must be installed there.
 */
function createTokenSource(config: GithubConfig, now: () => number): TokenSource {
  const tokens = new Map<string, Promise<InstallationToken>>();

  async function mint(repository: string): Promise<InstallationToken> {
    const jwt = signAppJwt(config.appId, config.privateKey, now());
    const installation = installationSchema.safeParse(
      await githubFetch(`/repos/${repository}/installation`, { token: jwt }),
    );
    if (!installation.success) throw new StoreError('GitHub returned no installation');

    const issued = accessTokenSchema.safeParse(
      await githubFetch(`/app/installations/${installation.data.id}/access_tokens`, {
        method: 'POST',
        token: jwt,
        body: { repositories: [repository.split('/')[1]] },
      }),
    );
    const expiresAt = issued.success ? Date.parse(issued.data.expires_at) : Number.NaN;
    if (!issued.success || Number.isNaN(expiresAt)) throw new StoreError('GitHub returned no installation token');

    return { token: issued.data.token, expiresAt };
  }

  return {
    async get(repository) {
      for (;;) {
        const held = tokens.get(repository);

        if (held === undefined) {
          const minting = mint(repository);
          tokens.set(repository, minting);
          // This handler runs before the callers that wait on the same promise. So a failed mint
          // leaves the map before any caller can see it, and the next request mints again.
          minting.catch(() => {
            if (tokens.get(repository) === minting) tokens.delete(repository);
          });

          return (await minting).token;
        }

        const token = await held;
        if (token.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return token.token;
        if (tokens.get(repository) === held) tokens.delete(repository);
      }
    },
    drop(repository) {
      tokens.delete(repository);
    },
  };
}

const issueRowSchema = z.object({
  id: z.number(),
  number: z.number(),
  html_url: z.string().min(1),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  state_reason: z.string().nullable().optional(),
  updated_at: z.string(),
  comments: z.number(),
  pull_request: z.unknown().optional(),
});

type IssueRow = z.infer<typeof issueRowSchema>;

const createdIssueSchema = z.object({ id: z.number(), number: z.number(), html_url: z.string().min(1) });

const commentRowSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

/** The pages that hold the newest `COMMENTS_PER_ISSUE` comments. GitHub sorts them oldest first. */
function commentPages(count: number): number[] {
  const last = Math.ceil(count / COMMENTS_PER_ISSUE);

  return count % COMMENTS_PER_ISSUE !== 0 && last > 1 ? [last - 1, last] : [last];
}

/**
 * Build a GitHub store. The configuration arrives validated by `createGithubStoreSpec`.
 */
export function createGithubStore(config: GithubConfig, options: GithubStoreOptions = {}): SeedStore {
  const now = options.now ?? Date.now;
  const tokens = createTokenSource(config, now);

  async function call(repository: string, path: string, init: Omit<GithubCall, 'token'> = {}): Promise<unknown> {
    const token = await tokens.get(repository);
    try {
      return await githubFetch(path, { ...init, token });
    } catch (error) {
      // GitHub revoked the token before its expiry, for example because the App was uninstalled.
      // The next request mints a new one instead of failing until the expiry.
      if (error instanceof GithubResponseError && error.status === 401) tokens.drop(repository);
      throw error;
    }
  }

  /**
   * A read filters on the labels, so an issue without them is lost to the page. For that reason, a
   * failure here stops the write, and the widget keeps the note.
   */
  async function ensureLabel(repository: string, name: string): Promise<void> {
    try {
      await call(repository, `/repos/${repository}/labels`, { method: 'POST', body: { name, color: LABEL_COLOR } });
    } catch (error) {
      if (error instanceof GithubResponseError && error.status === 422 && isAlreadyExists(error.payload)) return;
      throw error;
    }
  }

  async function fetchComments(repository: string, number: number, count: number): Promise<SeedComment[]> {
    if (count === 0) return [];

    const rows: unknown[] = [];
    for (const page of commentPages(count)) {
      const params = new URLSearchParams({ per_page: String(COMMENTS_PER_ISSUE), page: String(page) });
      const answer = await call(repository, `/repos/${repository}/issues/${number}/comments?${params}`);
      if (Array.isArray(answer)) rows.push(...answer);
    }

    return rows
      .flatMap((row) => {
        const comment = commentRowSchema.safeParse(row);

        return comment.success ? [comment.data] : [];
      })
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(-COMMENTS_PER_ISSUE)
      .map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? '',
        createdAt: comment.created_at,
        ...(comment.user?.login ? { author: comment.user.login } : {}),
      }));
  }

  async function listIssues(repository: string, labels: string[]): Promise<unknown[]> {
    const rows: unknown[] = [];

    for (let page = 1; page <= ISSUES_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        // An issue must carry every label in the list. Measured on cli/cli, 2026-09-14: `bug` gave
        // 100+ issues, `gh-codespace` 42, and `bug,gh-codespace` 22, each with both labels. The
        // client label is what keeps one client's pins off another client's site.
        labels: labels.join(','),
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: String(ISSUES_PAGE_SIZE),
        page: String(page),
      });
      const answer = await call(repository, `/repos/${repository}/issues?${params}`);
      if (!Array.isArray(answer)) throw new StoreError('GitHub returned no issue list');

      rows.push(...answer);
      if (answer.length < ISSUES_PAGE_SIZE) break;
    }

    return rows;
  }

  return {
    name: 'github',
    stages: GITHUB_STAGES,
    scope: (client) => repositoryFor(config, client),

    async create(seed: Seed, client: ClientConfig | undefined): Promise<CreatedIssue> {
      const repository = repositoryFor(config, client);
      const labels = buildIssueLabels(seed);

      for (const name of labels) await ensureLabel(repository, name);

      const created = createdIssueSchema.safeParse(
        await call(repository, `/repos/${repository}/issues`, {
          method: 'POST',
          body: { title: buildIssueTitle(seed), body: buildIssueDescription(seed), labels },
        }),
      );
      if (!created.success) throw new StoreError('GitHub returned no issue');

      return { id: String(created.data.id), identifier: `#${created.data.number}`, url: created.data.html_url };
    },

    async findForPage(query: SeedIssueQuery, client: ClientConfig | undefined, policy: ClientPolicy) {
      const repository = repositoryFor(config, client);
      const labels = query.clientId ? [FRUITBACK_LABEL, clientLabelName(query.clientId)] : [FRUITBACK_LABEL];

      const matched = (await listIssues(repository, labels)).flatMap((row) => {
        const match = matchPage(row, query.url);

        return match === null ? [] : [match];
      });

      // Comments are fetched only for the issues of this page, and only if the client shows them.
      const issues = await Promise.all(
        matched.map(async ({ issue, seed }) => {
          const comments = policy.showComments
            ? await fetchComments(repository, issue.number, issue.comments)
            : undefined;

          return seedIssueSchema.safeParse({
            id: String(issue.id),
            identifier: `#${issue.number}`,
            url: issue.html_url,
            title: issue.title,
            stage: stageForGithubIssue(issue.state, issue.state_reason),
            stateName: stateNameFor(issue.state, issue.state_reason),
            updatedAt: issue.updated_at,
            ...(comments === undefined ? {} : { comments }),
            seed,
          });
        }),
      );

      return issues.flatMap((result): SeedIssue[] => (result.success ? [result.data] : []));
    },
  };
}

/**
 * The issue and its seed, if the row is a seed of this page.
 *
 * The list endpoint also returns pull requests. The label filter cannot tell a page apart from
 * another, so the seed itself decides, as in the Linear store.
 */
function matchPage(row: unknown, canonicalUrl: string): { issue: IssueRow; seed: Seed } | null {
  const issue = issueRowSchema.safeParse(row);
  if (!issue.success || issue.data.pull_request !== undefined) return null;

  const parsed = parseSeedFromDescription(issue.data.body);
  if (!parsed.ok || parsed.seed.page.url !== canonicalUrl) return null;

  return { issue: issue.data, seed: parsed.seed };
}

function isAlreadyExists(payload: unknown): boolean {
  const errors = (payload as { errors?: { code?: unknown }[] } | null)?.errors;

  return Array.isArray(errors) && errors.some((error) => error?.code === 'already_exists');
}

/** GitHub as a selectable store: `FRUITBACK_STORE=github`. */
export function createGithubStoreSpec(): StoreSpec {
  return defineStore({
    provider: 'github',
    envNames: {
      appId: 'FRUITBACK_GITHUB_APP_ID',
      privateKey: 'FRUITBACK_GITHUB_PRIVATE_KEY',
      repository: 'FRUITBACK_GITHUB_REPOSITORY',
    },
    read: (env) => ({
      appId: env.FRUITBACK_GITHUB_APP_ID || undefined,
      privateKey: env.FRUITBACK_GITHUB_PRIVATE_KEY || undefined,
      repository: env.FRUITBACK_GITHUB_REPOSITORY || undefined,
    }),
    schema: githubConfigSchema,
    create: (options) => createGithubStore(options),
  });
}
