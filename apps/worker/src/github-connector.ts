import { type KeyObject, createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { REPOSITORY_PATTERN } from './clients.ts';
import {
  GithubResponseError,
  type InstallationToken,
  type TokenCache,
  accessTokenSchema,
  createIssueStore,
  createTokenCache,
  githubFetch,
  signAppJwt,
} from './github.ts';
import { open, seal } from './secrets.ts';
import { type SeedStore, StoreError } from './store.ts';

/**
 * The `github` connector of a workspace, on the Cloud (FRU-359, decision of Mathieu of 2026-10-21 on
 * FRU-188, option A).
 *
 * One public GitHub App of the worker (`FRUITBACK_GITHUB_CONNECTOR`). Each organisation of a client
 * installs it, and a connector keeps the id of that installation, sealed. The key of the App stays in
 * the environment: the database holds no key and no token.
 *
 * **A token reaches one repository.** Each token is asked for the repository of the destination only
 * (`repositories` of `POST /app/installations/{id}/access_tokens`), and the cache keys it by the
 * installation and the repository. GitHub says which repositories the token reaches, and a token that
 * does not name the repository of the destination is not used.
 *
 * The issues, the labels and the stages are the ones of the store `github` (`createIssueStore`).
 */

/** `FRUITBACK_GITHUB_CONNECTOR` and `FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY`, as `env.ts` reads them. */
export type GithubConnectorConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: KeyObject;
};

/** `<app id>:<client id>:<client secret>`, or `undefined` for a value that is not three parts. */
export function parseGithubConnector(value: string): Omit<GithubConnectorConfig, 'privateKey'> | undefined {
  const parts = value.split(':').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part === '')) return undefined;
  const [appId, clientId, clientSecret] = parts as [string, string, string];

  return /^[1-9][0-9]{0,19}$/.test(appId) ? { appId, clientId, clientSecret } : undefined;
}

/**
 * The repository of a destination, as GitHub names it, in lower case. GitHub compares the names
 * without case, so one repository has one destination. `undefined` for a value that is not one.
 *
 * Stricter than `REPOSITORY_PATTERN`: an owner of 39 characters at most, with no hyphen at its ends
 * and no two hyphens together, and a name of 100 characters at most.
 */
export function readGithubRepository(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repository = value.trim().toLowerCase();

  return GITHUB_REPOSITORY.test(repository) && REPOSITORY_PATTERN.test(repository) ? repository : undefined;
}

const GITHUB_REPOSITORY = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9._-]{1,100}$/;

/**
 * GitHub refuses the repository of a destination: the installation does not cover it, or no longer
 * has the permission. The connector needs attention (`key-lacks-access`).
 */
export class GithubRepositoryRefused extends StoreError {}

/** GitHub knows no such installation: the organisation removed the App. The connector needs a new one. */
export class GithubInstallationGone extends StoreError {}

/** An installation of the App that a person reaches, as `GET /user/installations` lists it (FRU-360). */
export type ReachedInstallation = { id: number; account: string };

/** The App of the worker, and its tokens, for the life of the process. */
export type GithubApp = {
  /** A token of `installation` that reaches `repository` and no other repository. */
  token(installation: number, repository: string): Promise<string>;
  drop(installation: number, repository: string, token: string): void;
  /** The slug of the App, from `GET /app`. It is asked once for the process. */
  slug(): Promise<string>;
  /**
   * The user token for the `code` of a person who installed the App (FRU-360). `undefined`: GitHub
   * gave none. The client secret goes to this one call, and the caller keeps the token nowhere.
   */
  userToken(code: string, redirectUri: string): Promise<string | undefined>;
  /**
   * `installation` among the installations that the person of `userToken` reaches, every page read,
   * or `undefined` when it is not one of them. It throws a `StoreError` when GitHub does not answer.
   */
  reachedBy(userToken: string, installation: number): Promise<ReachedInstallation | undefined>;
  /** For the tests: a GitHub on a port of the machine. */
  readonly api?: string;
};

/** `web` is the host of `/login/oauth/access_token`: `github.com`, not the host of the API. */
export type GithubAppOptions = { now?: () => number; api?: string; web?: string };

const GITHUB_WEB = 'https://github.com';
const CALL_TIMEOUT_MS = 10_000;
/** The most that GitHub gives in one page. */
const PER_PAGE = 100;
/** 10,000 installations. A person who reaches more is not a case this worker serves. */
const MAX_PAGES = 100;

const appSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,100}$/) });
const userTokenSchema = z.object({ access_token: z.string().min(1) });
const installationsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(z.object({ id: z.number().int().positive(), account: z.object({ login: z.string() }) })),
});

const tokenSchema = accessTokenSchema.extend({
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

/** A refusal of the token, as the trouble it is. A rate limit and a `5xx` are not refusals. */
function refusalOfMint(error: unknown): StoreError | undefined {
  if (!(error instanceof GithubResponseError) || error.rateLimited) return undefined;
  if (error.status === 404) return new GithubInstallationGone('GitHub knows no such installation of the App');
  if (error.status === 403 || error.status === 422) {
    return new GithubRepositoryRefused('The installation of the GitHub App does not cover this repository');
  }

  return undefined;
}

export function createGithubApp(config: GithubConnectorConfig, options: GithubAppOptions = {}): GithubApp {
  const now = options.now ?? Date.now;
  const api = options.api;
  const tokens: TokenCache = createTokenCache(now);
  // WARNING: the key names the installation and the repository. See `TokenCache`.
  const keyOf = (installation: number, repository: string): string => `${installation}\n${repository.toLowerCase()}`;

  async function mint(installation: number, repository: string): Promise<InstallationToken> {
    const jwt = signAppJwt(config.appId, config.privateKey, now());
    const name = repository.split('/')[1] as string;
    let answer: unknown;
    try {
      answer = await githubFetch(
        `/app/installations/${installation}/access_tokens`,
        { method: 'POST', token: jwt, body: { repositories: [name] } },
        api,
      );
    } catch (error) {
      throw refusalOfMint(error) ?? error;
    }
    const issued = tokenSchema.safeParse(answer);
    const expiresAt = issued.success ? Date.parse(issued.data.expires_at) : Number.NaN;
    if (!issued.success || Number.isNaN(expiresAt)) throw new StoreError('GitHub returned no installation token');
    // The installation can belong to another owner, with a repository of the same name.
    const reached = (issued.data.repositories ?? []).map((each) => each.full_name.toLowerCase());
    if (reached.length !== 1 || reached[0] !== repository.toLowerCase()) {
      throw new GithubRepositoryRefused('The token of the GitHub App does not name this repository alone');
    }

    return { token: issued.data.token, expiresAt };
  }

  let slug: Promise<string> | undefined;
  async function askSlug(): Promise<string> {
    const parsed = appSchema.safeParse(
      await githubFetch('/app', { token: signAppJwt(config.appId, config.privateKey, now()) }, api),
    );
    if (!parsed.success) throw new StoreError('GitHub returned no slug for the App');

    return parsed.data.slug;
  }

  async function userToken(code: string, redirectUri: string): Promise<string | undefined> {
    const response = await fetch(`${options.web ?? GITHUB_WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => undefined);
    // GitHub answers a code it refuses with `200` and an `error` field.
    const parsed = response?.ok ? userTokenSchema.safeParse(await response.json().catch(() => null)) : undefined;

    return parsed?.success ? parsed.data.access_token : undefined;
  }

  async function reachedBy(token: string, installation: number): Promise<ReachedInstallation | undefined> {
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const parsed = installationsSchema.safeParse(
        await githubFetch(`/user/installations?per_page=${PER_PAGE}&page=${page}`, { token }, api),
      );
      if (!parsed.success) throw new StoreError('GitHub returned no list of installations');
      const found = parsed.data.installations.find((each) => each.id === installation);
      if (found !== undefined) return { id: found.id, account: found.account.login };
      seen += parsed.data.installations.length;
      // The count, not the size of a page: GitHub can give fewer than `per_page` before the end.
      if (parsed.data.installations.length === 0 || seen >= parsed.data.total_count) return undefined;
    }

    return undefined;
  }

  return {
    token: (installation, repository) =>
      tokens.get(keyOf(installation, repository), () => mint(installation, repository)),
    drop: (installation, repository, token) => tokens.drop(keyOf(installation, repository), token),
    slug() {
      // A failure is not kept: the next start asks again.
      slug ??= askSlug().catch((error: unknown) => {
        slug = undefined;
        throw error;
      });

      return slug;
    },
    userToken,
    reachedBy,
    ...(api === undefined ? {} : { api }),
  };
}

const apps = new Map<string, GithubApp>();

/**
 * The one `GithubApp` of the process for this configuration. `readConfig` runs at each request, and
 * the tokens must outlive a request.
 */
export function githubAppFor(config: GithubConnectorConfig): GithubApp {
  const pem = config.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const key = createHash('sha256').update(`${config.appId}\n${pem}`).digest('hex');
  let app = apps.get(key);
  if (app === undefined) {
    app = createGithubApp(config);
    apps.set(key, app);
  }

  return app;
}

const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;

/** What a `github` connector keeps: the id of the installation, sealed, and nothing more. */
export function sealInstallation(installation: number, secretsKey: string): string {
  if (!Number.isSafeInteger(installation) || installation < 1) throw new RangeError('not an installation id');

  return seal(String(installation), secretsKey);
}

/**
 * What says that two connectors hold the same installation (FRU-360): an HMAC of its id, keyed by
 * `FRUITBACK_SECRETS_KEY`. The id stays sealed, and the column can still be unique.
 */
export function installationFingerprint(installation: number, secretsKey: string): string {
  return createHmac('sha256', secretsKey).update(`github-installation\n${installation}`).digest('hex');
}

/** The installation of a `github` connector. It throws a `StoreError` for a value that does not open. */
export function openInstallation(sealed: string, secretsKey: string | undefined): number {
  if (secretsKey === undefined) throw new StoreError('This worker has no key to open a connector with');
  const plain = open(sealed, secretsKey);
  if (plain === undefined || !INSTALLATION_ID.test(plain)) {
    throw new StoreError('The installation of this connector could not be opened');
  }

  return Number(plain);
}

/**
 * The store of a `github` connector. The repository of a note is the `teamId` of its destination.
 *
 * A client with no repository, or with one that is not `owner/name`, is a `StoreError`: there is no
 * repository by default. A refusal of a repository (`403`, `404`) is a `GithubRepositoryRefused`, and
 * the token of the call is dropped. A `422` on an issue call is a refusal of that note, not of the
 * connector: `ensureLabel` reads its own `422`.
 */
export function createGithubConnectorStore(app: GithubApp, installation: number): SeedStore {
  return createIssueStore({
    repositoryOf: (client) => {
      const repository = client?.teamId;
      // The value comes from a row. It goes into the path of each call, so it is checked again here.
      if (repository === undefined || readGithubRepository(repository) !== repository) {
        throw new StoreError('This destination names no GitHub repository');
      }

      return repository;
    },
    tokens: {
      get: (repository) => app.token(installation, repository),
      drop: (repository, token) => app.drop(installation, repository, token),
    },
    ...(app.api === undefined ? {} : { api: app.api }),
    refused: (error) =>
      !error.rateLimited && (error.status === 403 || error.status === 404)
        ? new GithubRepositoryRefused(`GitHub responded ${error.status} for this repository`)
        : undefined,
  });
}
