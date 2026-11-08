import { z } from 'zod';
import { parseTargetUrl } from './rest-connector.ts';
import { open, seal } from './secrets.ts';
import { StoreError } from './store.ts';

/**
 * The REST API v4 of GitLab (FRU-623), on gitlab.com or on an instance that a team hosts.
 *
 * Read in the documentation of GitLab on 2026-11-08: « REST API troubleshooting » (the statuses),
 * « Issues API », « Notes API », « Project markdown uploads API », « Projects API », « Users API ».
 *
 * **The token is an access token**: a project access token, a group access token or a personal one,
 * with the `api` scope and the Reporter role at least. GitLab ignores the labels of an issue that a
 * Guest creates, and a read here filters on the labels. OAuth is not used: an application of OAuth is
 * registered on each instance, and a self-managed instance has none for Fruitback.
 *
 * WARNING: the address of a self-managed instance is the workspace's word. Every call goes through
 * `http`, which the worker builds on `createGuardedFetch`: the name is checked when it is resolved,
 * so a workspace cannot make the worker read a service of its own network.
 */

export const GITLAB_COM = 'https://gitlab.com';

/** A `fetch` of the worker. In production it refuses the internal networks (`guarded-fetch.ts`). */
export type Http = (url: string, init: RequestInit) => Promise<Response>;

/** What a `gitlab` connector keeps, sealed: the instance and the token. */
export type GitlabTarget = { url: string; token: string };

/** How long a read waits for GitLab. A write waits longer: a note GitLab made late would be sent again. */
export const GITLAB_READ_TIMEOUT_MS = 10_000;
export const GITLAB_WRITE_TIMEOUT_MS = 30_000;

/**
 * The instance as the worker keeps it: `https://gitlab.com` when nothing is given, else an https
 * address that the internet reaches, with no query, no fragment and no trailing slash. A path is kept:
 * an instance can live under one (`https://acme.dev/gitlab`). `undefined` for a value that is not one.
 */
export function parseGitlabUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return GITLAB_COM;
  const parsed = parseTargetUrl(value);
  if (parsed === undefined) return undefined;
  const url = new URL(parsed);
  if (url.search !== '') return undefined;
  // A person pastes the page of a project, or the API: the instance is what comes before.
  const path = url.pathname.replace(/\/(-\/.*|api\/v4.*)$/, '').replace(/\/+$/, '');

  return `${url.origin}${path}`;
}

/** What the console shows of a connector: its instance, never the token. */
export function gitlabLabel(url: string): string {
  const { host, pathname } = new URL(url);

  return `GitLab · ${host}${pathname === '/' ? '' : pathname}`;
}

const TOKEN = /^[\x21-\x7e]{20,255}$/;

/** A token as GitLab gives one: printable, with no space. `glpat-` is the default prefix, not a rule. */
export function isAcceptableGitlabToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN.test(token);
}

export function sealGitlab(target: GitlabTarget, secretsKey: string): string {
  return seal(JSON.stringify(target), secretsKey);
}

/** The target, or a `StoreError` for a value this key does not open. */
export function openGitlab(sealed: string, secretsKey: string | undefined): GitlabTarget {
  if (secretsKey === undefined) throw new StoreError('This worker has no key to open a connector with');
  const plain = open(sealed, secretsKey);
  try {
    const { url, token } = JSON.parse(plain ?? 'null') as Partial<GitlabTarget>;
    if (typeof url === 'string' && isAcceptableGitlabToken(token)) return { url, token };
  } catch {
    // Said below.
  }
  throw new StoreError('The token of this GitLab connector could not be opened');
}

/** A call that GitLab answered with an error. The message holds the status only: the widget reads it. */
export class GitlabResponseError extends StoreError {
  readonly status: number;
  /** `429`, or `403` with `Retry-After`: no refusal of the token. */
  readonly rateLimited: boolean;

  constructor(status: number, rateLimited: boolean) {
    super(`GitLab responded ${status}`);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

/** `401`: GitLab knows no such token, or it expired, or it was revoked. The connector needs a new one. */
export class GitlabTokenRefused extends StoreError {}

/** `403` or `404` on a project: the token does not reach it, or its role is too low. */
export class GitlabProjectRefused extends StoreError {}

type Call = {
  method?: 'GET' | 'POST';
  /** A JSON body. */
  json?: unknown;
  /** A multipart body, for an upload. */
  form?: FormData;
};

/** One call of the API, `/api/v4` and `path`, with the token. It throws a `StoreError` on any failure. */
export async function gitlabCall(
  http: Http,
  target: GitlabTarget,
  path: string,
  { method = 'GET', json, form }: Call = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await http(`${target.url}/api/v4${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': target.token,
        'User-Agent': 'fruitback-worker',
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      ...(form === undefined ? {} : { body: form }),
      redirect: 'error',
      signal: AbortSignal.timeout(method === 'GET' ? GITLAB_READ_TIMEOUT_MS : GITLAB_WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new StoreError('GitLab did not answer in time');
    }
    throw new StoreError('GitLab could not be reached');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;
  if (response.status === 401) throw new GitlabTokenRefused('GitLab refused the token');
  const rateLimited = response.status === 429 || response.headers.get('retry-after') !== null;
  throw new GitlabResponseError(response.status, rateLimited);
}

const userSchema = z.object({ username: z.string() });

/**
 * Who the token is (`GET /user`), before a connector is kept: `200` is a token that works. A token
 * that GitLab refuses throws `GitlabTokenRefused`, and is never kept. A `403` is a valid token that
 * cannot read its user: it is taken, and a call without the `api` scope says it later.
 */
export async function readGitlabUser(http: Http, target: GitlabTarget): Promise<string | undefined> {
  try {
    const user = userSchema.safeParse(await gitlabCall(http, target, '/user'));

    return user.success ? user.data.username : undefined;
  } catch (error) {
    if (error instanceof GitlabResponseError && error.status === 403) return undefined;
    throw error;
  }
}

/** A project that the token reaches, as the console offers it for a destination. */
export type GitlabProject = { id: string; path: string; url: string };

const projectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string(),
  web_url: z.string(),
});

/** One page of a list, and whether there is another. */
export type GitlabProjects = { projects: GitlabProject[]; next?: string };

const PROJECTS_PAGE = 50;

/** The role a token needs on a project: Reporter. GitLab ignores the labels a Guest sets. */
export const GITLAB_MIN_ACCESS = 20;

/**
 * The projects where the token is Reporter or more (`GET /projects`, `membership`, `min_access_level`),
 * the ones whose path or name holds `search` when there is one. `after` is the `next` of the page
 * before. A project access token reaches its project only.
 */
export async function listGitlabProjects(
  http: Http,
  target: GitlabTarget,
  { search, after }: { search?: string; after?: string } = {},
): Promise<GitlabProjects> {
  const page = after === undefined ? 1 : Number(after);
  if (!Number.isSafeInteger(page) || page < 1) throw new StoreError('Not a page of projects');
  const params = new URLSearchParams({
    membership: 'true',
    min_access_level: String(GITLAB_MIN_ACCESS),
    simple: 'true',
    order_by: 'last_activity_at',
    per_page: String(PROJECTS_PAGE),
    page: String(page),
    ...(search === undefined ? {} : { search }),
  });
  const answer = await gitlabCall(http, target, `/projects?${params}`);
  if (!Array.isArray(answer)) throw new StoreError('GitLab returned no list of projects');
  const projects = answer.flatMap((row) => {
    const project = projectSchema.safeParse(row);

    return project.success ? [projectOf(project.data)] : [];
  });

  return { projects, ...(answer.length < PROJECTS_PAGE ? {} : { next: String(page + 1) }) };
}

function projectOf(row: z.infer<typeof projectSchema>): GitlabProject {
  return { id: String(row.id), path: row.path_with_namespace, url: row.web_url };
}

/** The id of a project, as a destination keeps it: GitLab's number, which a rename does not change. */
export const GITLAB_PROJECT_ID = /^[1-9][0-9]{0,18}$/;

/** One project by its id, or `undefined` when the token does not reach it (`403`, `404`). */
export async function readGitlabProject(
  http: Http,
  target: GitlabTarget,
  id: string,
): Promise<GitlabProject | undefined> {
  if (!GITLAB_PROJECT_ID.test(id)) return undefined;
  try {
    const project = projectSchema.safeParse(await gitlabCall(http, target, `/projects/${id}`));
    if (!project.success || String(project.data.id) !== id) throw new StoreError('GitLab returned no project');

    return projectOf(project.data);
  } catch (error) {
    if (error instanceof GitlabResponseError && !error.rateLimited && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}
