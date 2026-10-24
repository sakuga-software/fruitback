import { type KeyObject, createPrivateKey, sign, createHash } from 'node:crypto';
import {
  DEFAULT_NOTE_STAGE,
  FRUITBACK_LABEL,
  type Note,
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  parseNoteFromDescription,
  noteIssueSchema,
} from '@fruitback/shared';
import { z } from 'zod';
import { type ClientConfig, type ClientPolicy, REPOSITORY_PATTERN } from './clients.ts';
import { type CreatedIssue, type NoteIssueQuery, type NoteStore, StoreError, type TrackerState } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

/**
 * GitHub Issues, as a `NoteStore` (FRU-32).
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

/** A label name that GitHub keeps as written: lowercase, no comma, and 50 characters at most. */
const PLAIN_LABEL = /^[a-z0-9._:-]{1,50}$/;

/** The shape of a generated label. A plain name with this shape is hashed too. */
const HASHED_LABEL = /^fruitback:[0-9a-f]{32}$/;

/**
 * The name of a label on GitHub. The write and the read must both use it.
 *
 * GitHub compares label names without case, limits them to 50 characters, and splits the `labels`
 * query on commas. If `Acme` and `acme` used their own names, the two clients would share one label and
 * read each other's notes. So a name that is not a plain label becomes `fruitback:` and a hash of it.
 *
 * A client ID can be the 32 hex characters of another client's hash. That name is hashed as well, so
 * only the hash of a name can produce a label of that shape.
 */
export function githubLabelName(name: string): string {
  if (PLAIN_LABEL.test(name) && !HASHED_LABEL.test(name)) return name;

  return `${FRUITBACK_LABEL}:${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
}

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
export const COMMENTS_PER_ISSUE = 20;

/**
 * Comment lists fetched at the same time. GitHub's secondary rate limit counts concurrent requests,
 * and a page with many pins must not open one request per pin at once.
 */
const COMMENT_FETCHES_AT_ONCE = 4;

/**
 * The RSA private key of a GitHub App, from the PEM of a variable, or `undefined` for a value that is
 * not one. The store `github` and the connector `github` (FRU-359) read their key with this.
 *
 * A `.env` file holds one line, so the PEM can arrive with its line breaks written as `\n`. A PEM
 * with real line breaks is read as it is.
 */
export function readRsaPrivateKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(pem.replace(/\\n/g, '\n'));

    return key.asymmetricKeyType === 'rsa' ? key : undefined;
  } catch {
    // The caller names the variable. The key itself must never reach a message.
    return undefined;
  }
}

const githubConfigSchema = z.object({
  /** The App ID, or its client ID. GitHub accepts both as `iss`. */
  appId: z.string().min(1),
  privateKey: z.string().transform((pem, context) => {
    const key = readRsaPrivateKey(pem);
    if (key !== undefined) return key;
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

/** The stages `stageForGithubIssue` can return, in `NOTE_STAGES` order. */
export const GITHUB_STAGES: readonly NoteStage[] = ['new', 'done', 'closed'];

/**
 * An issue's state and `state_reason`, projected onto the stage of the pin.
 *
 * An issue closed before GitHub added `state_reason` has no reason. Closed then meant done, so it is
 * `done`. A state this store does not know gets the contract's default, so the pin stays visible.
 */
export function stageForGithubIssue(state: string, stateReason: string | null | undefined): NoteStage {
  if (state === 'open') return 'new';
  if (state !== 'closed') return DEFAULT_NOTE_STAGE;

  return stateReason === 'not_planned' || stateReason === 'duplicate' ? 'closed' : 'done';
}

/**
 * The status of an issue, as its key among `GITHUB_STATES` (FRU-369): what `state` and `state_reason`
 * say. A close with no reason, from before GitHub had one, is `closed:completed`, as its stage is
 * `done`; an issue reopened is `open`. `undefined` for a state GitHub does not have today: its pin is
 * drawn by its stage, as before.
 */
export function githubStateKey(state: string, stateReason: string | null | undefined): string | undefined {
  if (state === 'open') return 'open';
  if (state !== 'closed') return undefined;

  return stateReason === 'not_planned' || stateReason === 'duplicate' ? `closed:${stateReason}` : 'closed:completed';
}

/**
 * The four statuses of a GitHub issue (FRU-369, decision 4: no label is a status). Their names are the
 * words of `stateNameFor`, and their stages the ones `stageForGithubIssue` gives; a site renames,
 * recolours or re-stages each one in its statuses, as any other.
 */
export const GITHUB_STATES: readonly TrackerState[] = (
  [
    ['open', 'open', null],
    ['closed:completed', 'closed', 'completed'],
    ['closed:not_planned', 'closed', 'not_planned'],
    ['closed:duplicate', 'closed', 'duplicate'],
  ] as const
).map(([id, state, reason]) => ({ id, name: stateNameFor(state, reason), stage: stageForGithubIssue(state, reason) }));

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
export class GithubResponseError extends StoreError {
  readonly status: number;
  readonly payload: unknown;
  /**
   * GitHub answers a secondary rate limit with `403` and `retry-after`, or with `x-ratelimit-remaining: 0`
   * (the documentation of « Rate limits for the REST API »). That `403` is no refusal of access.
   */
  readonly rateLimited: boolean;

  constructor(status: number, payload: unknown, rateLimited = false) {
    super(`GitHub responded ${status}`);
    this.status = status;
    this.payload = payload;
    this.rateLimited = rateLimited;
  }
}

type GithubCall = { method?: 'GET' | 'POST'; token: string; body?: unknown };

/** `api` is for the tests: a GitHub on a port of the machine. */
export async function githubFetch(
  path: string,
  { method = 'GET', token, body }: GithubCall,
  api: string = GITHUB_API,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${api}${path}`, {
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
  if (!response.ok) {
    const rateLimited =
      response.headers.get('retry-after') !== null || response.headers.get('x-ratelimit-remaining') === '0';
    throw new GithubResponseError(response.status, payload, rateLimited);
  }

  return payload;
}

const installationSchema = z.object({ id: z.number() });
export const accessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string() });

export type InstallationToken = { token: string; expiresAt: number };

/** The tokens of one store, by repository. */
export type TokenSource = { get(repository: string): Promise<string>; drop(repository: string, token: string): void };

/**
 * Installation tokens by key, shared by every request. A token is used until `TOKEN_REFRESH_MARGIN_MS`
 * before its end, and one mint at a time runs for a key.
 *
 * WARNING: the key must name everything the token reaches. A token of one repository that is served
 * under the key of another is a write in the wrong repository.
 */
export type TokenCache = {
  get(key: string, mint: () => Promise<InstallationToken>): Promise<string>;
  /** Forgets the token of `key` if it is still `token`. */
  drop(key: string, token: string): void;
};

export function createTokenCache(now: () => number): TokenCache {
  const tokens = new Map<string, Promise<InstallationToken>>();
  const issued = new WeakMap<Promise<InstallationToken>, string>();

  return {
    async get(key, mint) {
      for (;;) {
        const held = tokens.get(key);

        if (held === undefined) {
          const minting = mint();
          tokens.set(key, minting);
          // This handler runs before the callers that wait on the same promise. So a failed mint
          // leaves the map before any caller can see it, and the next request mints again.
          minting.then(
            (token) => issued.set(minting, token.token),
            () => {
              if (tokens.get(key) === minting) tokens.delete(key);
            },
          );

          return (await minting).token;
        }

        const token = await held;
        if (token.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return token.token;
        if (tokens.get(key) === held) tokens.delete(key);
      }
    },
    drop(key, token) {
      // A 401 can arrive late, for a token that a newer mint replaced. It must not evict the new token.
      const held = tokens.get(key);
      if (held !== undefined && issued.get(held) === token) tokens.delete(key);
    },
  };
}

/**
 * One installation token per repository, shared by every request.
 *
 * The store finds the installation from the repository, so a client repository in another
 * organisation needs no more configuration. The App must be installed there.
 */
function createTokenSource(config: GithubConfig, now: () => number): TokenSource {
  const tokens = createTokenCache(now);

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
    get: (repository) => tokens.get(repository, () => mint(repository)),
    drop: (repository, token) => tokens.drop(repository, token),
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
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  pull_request: z.unknown().optional(),
});

type IssueRow = z.infer<typeof issueRowSchema>;

function labelNames(issue: IssueRow): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
}

async function mapInBatches<T, R>(items: T[], size: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(map))));
  }

  return results;
}

const createdIssueSchema = z.object({ id: z.number(), number: z.number(), html_url: z.string().min(1) });

const commentRowSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

/**
 * Pages read after the last page that `count` predicts. `count` comes from the issue list, and a reply
 * can arrive after it. GitHub has no newest-first order for these comments.
 */
const COMMENT_PAGES_AFTER_COUNT = 2;

/** The pages that hold the newest `COMMENTS_PER_ISSUE` comments. GitHub sorts them oldest first. */
function commentPages(count: number): number[] {
  const last = Math.ceil(count / COMMENTS_PER_ISSUE);

  return count % COMMENTS_PER_ISSUE !== 0 && last > 1 ? [last - 1, last] : [last];
}

/**
 * Build a GitHub store. The configuration arrives validated by `createGithubStoreSpec`.
 *
 * **It takes no file of a note** (FRU-331): it has no `attachments`, so a site on it answers
 * `canAttach: false` and `409 attachments-not-taken`. The REST API of an issue takes text only
 * (`title`, `body`: documentation of « Create an issue », read on 2026-10-21), and has no route that
 * puts a file. The upload of the web interface of GitHub answers a browser with a cookie, not the
 * token of an App. The one way left is a commit of the file in the repository (`PUT /contents`),
 * which keeps it in the history of the code for ever, where nobody can delete it at the end of a
 * transit: refused. Not measured on a real repository: no App of a test repository is installed.
 */
export function createGithubStore(config: GithubConfig, options: GithubStoreOptions = {}): NoteStore {
  return createIssueStore({
    repositoryOf: (client) => repositoryFor(config, client),
    tokens: createTokenSource(config, options.now ?? Date.now),
  });
}

/**
 * What a store of GitHub issues needs, whoever holds the key: the store `github` of the worker, or the
 * connector `github` of a workspace (FRU-359).
 */
export type IssueStoreOptions = {
  /** The repository of the client. It throws a `StoreError` for a client that names none. */
  repositoryOf: (client: ClientConfig | undefined) => string;
  tokens: TokenSource;
  /** For the tests: a GitHub on a port of the machine. */
  api?: string;
  /**
   * The error to throw in place of a refusal of GitHub, or `undefined` to throw the refusal as it is.
   * The token of the call is dropped before this error is thrown.
   */
  refused?: (error: GithubResponseError) => StoreError | undefined;
  /**
   * The connector the issues are read through (FRU-369): each issue then says its status as
   * `<connector>:<key of GITHUB_STATES>`, and the store says the four states. The store of the worker's
   * own environment has none, and says neither.
   */
  statusSource?: string;
  /** The stage a site gives a status, by its key, over the one of `stageForGithubIssue` (FRU-369). */
  stages?: Readonly<Record<string, NoteStage>>;
  /**
   * FRU-382: told whether the repository is private, read with the token of the note once its issue
   * is made. A repository that turned public since its destination was written is then said in the
   * console. A read that fails is said in the log and costs the note nothing.
   */
  privacy?: (repository: string, isPrivate: boolean) => Promise<void>;
};

const repositoryPrivacySchema = z.object({ private: z.boolean() });

export function createIssueStore({
  repositoryOf,
  tokens,
  api,
  refused,
  statusSource,
  stages = {},
  privacy,
}: IssueStoreOptions): NoteStore {
  async function call(repository: string, path: string, init: Omit<GithubCall, 'token'> = {}): Promise<unknown> {
    const token = await tokens.get(repository);
    try {
      return await githubFetch(path, { ...init, token }, api);
    } catch (error) {
      if (!(error instanceof GithubResponseError)) throw error;
      // GitHub revoked the token before its expiry, for example because the App was uninstalled.
      // The next request mints a new one instead of failing until the expiry.
      if (error.status === 401) tokens.drop(repository, token);
      const instead = refused?.(error);
      if (instead === undefined) throw error;
      tokens.drop(repository, token);
      throw instead;
    }
  }

  /** What GitHub says of the repository now, told to `privacy`. Nothing of it stops the note. */
  async function notePrivacy(
    repository: string,
    privacy: (repository: string, isPrivate: boolean) => Promise<void>,
  ): Promise<void> {
    try {
      const token = await tokens.get(repository);
      const read = repositoryPrivacySchema.safeParse(await githubFetch(`/repos/${repository}`, { token }, api));
      if (!read.success) throw new StoreError('GitHub returned no repository');
      await privacy(repository, read.data.private);
    } catch (error) {
      console.error(
        `[fruitback] whether a repository is private was not read again: ${error instanceof Error ? error.message : String(error)}`,
      );
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

  async function fetchComments(repository: string, number: number, count: number): Promise<NoteComment[]> {
    if (count === 0) return [];

    const rows: unknown[] = [];
    const pages = commentPages(count);
    const last = pages.at(-1) ?? 1;
    for (let page = pages[0] ?? 1; page <= last + COMMENT_PAGES_AFTER_COUNT; page += 1) {
      const params = new URLSearchParams({ per_page: String(COMMENTS_PER_ISSUE), page: String(page) });
      const answer = await call(repository, `/repos/${repository}/issues/${number}/comments?${params}`);
      const received = Array.isArray(answer) ? answer : [];
      rows.push(...received);
      if (page >= last && received.length < COMMENTS_PER_ISSUE) break;
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
    scope: (client) => repositoryOf(client),

    async create(seed: Note, client: ClientConfig | undefined, policy: ClientPolicy): Promise<CreatedIssue> {
      const repository = repositoryOf(client);
      const labels = buildIssueLabels(seed).map(githubLabelName);

      for (const name of labels) await ensureLabel(repository, name);

      const created = createdIssueSchema.safeParse(
        await call(repository, `/repos/${repository}/issues`, {
          method: 'POST',
          body: { title: buildIssueTitle(seed), body: buildIssueDescription(seed, { locale: policy.locale }), labels },
        }),
      );
      if (!created.success) throw new StoreError('GitHub returned no issue');
      if (privacy !== undefined) await notePrivacy(repository, privacy);

      return { id: String(created.data.id), identifier: `#${created.data.number}`, url: created.data.html_url };
    },

    // FRU-369: the four states, for the statuses of a site that sends here. Read from no call to GitHub.
    ...(statusSource === undefined ? {} : { trackerStates: async () => [...GITHUB_STATES] }),

    async findForPage(query: NoteIssueQuery, client: ClientConfig | undefined, policy: ClientPolicy) {
      const repository = repositoryOf(client);
      const labels = (query.clientId ? [FRUITBACK_LABEL, clientLabelName(query.clientId)] : [FRUITBACK_LABEL]).map(
        githubLabelName,
      );

      const matched = (await listIssues(repository, labels)).flatMap((row) => {
        const match = matchPage(row, query.url, labels, query.clientId);

        return match === null ? [] : [match];
      });

      // Comments are fetched only for the issues of this page, and only if the client shows them.
      const issues = await mapInBatches(matched, COMMENT_FETCHES_AT_ONCE, async ({ issue, seed }) => {
        const key = githubStateKey(issue.state, issue.state_reason);
        const comments = policy.showComments
          ? await fetchComments(repository, issue.number, issue.comments)
          : undefined;

        return noteIssueSchema.safeParse({
          id: String(issue.id),
          identifier: `#${issue.number}`,
          url: issue.html_url,
          title: issue.title,
          stage:
            key !== undefined && Object.hasOwn(stages, key)
              ? stages[key]
              : stageForGithubIssue(issue.state, issue.state_reason),
          stateName: stateNameFor(issue.state, issue.state_reason),
          ...(statusSource === undefined || key === undefined ? {} : { status: `${statusSource}:${key}` }),
          updatedAt: issue.updated_at,
          ...(comments === undefined ? {} : { comments }),
          seed,
        });
      });

      return issues.flatMap((result): NoteIssue[] => (result.success ? [result.data] : []));
    },
  };
}

/**
 * The issue and its seed, if the row is a seed of this page.
 *
 * The list endpoint also returns pull requests. The label filter cannot tell a page apart from
 * another, so the seed itself decides, as in the Linear store. The labels are checked again, without
 * case as GitHub compares them, so the client isolation does not rest on the query alone.
 */
function matchPage(
  row: unknown,
  canonicalUrl: string,
  labels: string[],
  clientId: string | undefined,
): { issue: IssueRow; seed: Note } | null {
  const issue = issueRowSchema.safeParse(row);
  if (!issue.success || issue.data.pull_request !== undefined) return null;

  const carried = labelNames(issue.data).map((name) => name.toLowerCase());
  if (!labels.every((name) => carried.includes(name.toLowerCase()))) return null;

  const parsed = parseNoteFromDescription(issue.data.body);
  if (!parsed.ok || parsed.note.page.url !== canonicalUrl) return null;
  // The labels select the issues, and the seed confirms the client. The write path stores the
  // normalized client ID in the seed, so the two values are equal for every note of this client.
  if (clientId && parsed.note.client?.id !== clientId) return null;

  return { issue: issue.data, seed: parsed.note };
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
