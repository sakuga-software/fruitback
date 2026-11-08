import type { AccountStore } from '../accounts.ts';
import type { StageExceptions } from '../linear.ts';
import type { OAuthClient } from '../oauth-client.ts';
import { open, seal } from '../secrets.ts';
import { type NoteStore, StoreError } from '../store.ts';
import type { PluginKind } from './kinds.ts';

/**
 * A connector that comes as a plugin (FRU-621): Jira, GitLab, Slack, ClickUp, Asana.
 *
 * Each one is one file of `trackers/`, which exports a `TrackerPlugin` or `undefined`. The routes,
 * the store of a site, the health of a connector and the OAuth flow read the plugin through
 * `pluginOf`, so that a new connector edits no list that another one edits too.
 *
 * **A plugin never holds a secret in the clear between two calls.** The worker opens the credential
 * at each call (`TrackerAccess.credential`), and refreshes a token of OAuth near its end there.
 */

/** What a plugin calls its service with. A test hands over a `fetch` that reaches its own server. */
export type Http = typeof fetch;

/** The tokens of OAuth that a service gives, with the moment the access token ends. */
export type OAuthTokens = { accessToken: string; refreshToken: string; expiresAt: number };

/**
 * What a connector keeps, sealed, as the plugin reads it. `extra` holds what the plugin needs beside
 * the secret (the address of a server, the id of a site), never a second secret.
 */
export type TrackerCredential =
  | { via: 'token'; token: string; extra: Readonly<Record<string, string>> }
  | ({ via: 'oauth'; extra: Readonly<Record<string, string>> } & OAuthTokens);

/** How a plugin reaches its service for one connector, during one request. */
export type TrackerAccess = {
  /** The credential of the connector, refreshed first when it is a token of OAuth near its end. */
  credential(): Promise<TrackerCredential>;
  http: Http;
  now: () => number;
};

/** A place of a tracker, for the person who chooses a destination: a project, a list, a channel. */
export type TrackerPlace = { id: string; name: string; detail?: string };

/** A page of places. `next` is what the next page is asked with; absent on the last one. */
export type TrackerPlaces = { places: TrackerPlace[]; next?: string };

/** The service refuses the credential: it is wrong, or it was revoked. The connector needs a new one. */
export class TrackerKeyRefused extends StoreError {}

/** The service knows the credential, and refuses what it was asked: a place it does not reach. */
export class TrackerKeyForbidden extends StoreError {}

/** The service refused to refresh a token of OAuth. It does not come back alone: connect again. */
export class TrackerConnectionEnded extends StoreError {}

/**
 * What a person typed to connect is refused, before anything is kept. `code` is the word the console
 * answers with (`400 { error: code }`), for example `invalid-address`.
 */
export class TrackerInputRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type TrackerOAuth = {
  /** The address of consent at the service. `challenge` is a PKCE challenge (S256), for a service that takes one. */
  authorize(request: { clientId: string; redirectUri: string; state: string; challenge: string }): string;
  /** The tokens for a code, or `undefined` when the service gave none. */
  exchange(
    request: { code: string; verifier: string; redirectUri: string; client: OAuthClient },
    http: Http,
    now: number,
  ): Promise<OAuthTokens | undefined>;
  /**
   * New tokens for a refresh token. `'ended'`: the service refuses that refresh token, and the
   * connector needs a new consent. It throws a `StoreError` when the service does not answer.
   */
  refresh(refreshToken: string, client: OAuthClient, http: Http, now: number): Promise<OAuthTokens | 'ended'>;
  /** What the connector is named after, and what it keeps beside the tokens. `undefined`: nothing usable. */
  identify(tokens: OAuthTokens, http: Http): Promise<{ label: string; extra?: Record<string, string> } | undefined>;
  /** Tells the service that the tokens are over. Best effort: the connector goes whatever it answers. */
  revoke?(credential: Extract<TrackerCredential, { via: 'oauth' }>, client: OAuthClient, http: Http): Promise<void>;
};

export type TrackerPlugin = {
  kind: PluginKind;
  /** The name of the service in a label, untranslated: « Jira · Design ». */
  name: string;
  /**
   * The variable of the application of OAuth, `<client id>:<client secret>`, for a plugin with
   * `oauth`. Written as `envNames: { oauth: 'FRUITBACK_<KIND>_OAUTH' }`: `compose.test.ts` reads it.
   */
  envNames?: { oauth: string };
  /**
   * A connection by a token that a person types (`POST /connectors`, body of the console). It asks
   * the service before anything is kept: a token it refuses is a `TrackerKeyRefused`, and is never
   * stored. A field that is refused is a `TrackerInputRefused`.
   */
  connect?(
    body: Readonly<Record<string, unknown>>,
    context: { http: Http; now: () => number },
  ): Promise<{ label: string; token: string; extra?: Record<string, string> }>;
  /** A connection by OAuth, where the worker has the application of the service. */
  oauth?: TrackerOAuth;
  /** The places to choose a destination among: the ones whose name holds `search`, a page at a time. */
  places(access: TrackerAccess, query: { search?: string; after?: string }): Promise<TrackerPlaces>;
  /** The id of a place, as a destination keeps it (its `teamId`), or `undefined` for a value that is not one. */
  readPlace(value: unknown): string | undefined;
  /**
   * The name of a place, as the service says it now, or `undefined` when it does not reach it. No
   * page: a destination keeps the page of a team of Linear only (FRU-574).
   */
  placeName(access: TrackerAccess, place: string): Promise<{ name: string } | undefined>;
  /**
   * The store of the connector. The place of a note is the `teamId` of the client. `stages` are the
   * stages a site gives the states of the tracker (FRU-368), and `connector` names its statuses.
   */
  store(access: TrackerAccess, options: { connector: string; stages?: StageExceptions }): NoteStore;
  /** Best effort, before the connector goes: the service forgets the token. */
  disconnect?(access: TrackerAccess, client: OAuthClient | undefined): Promise<void>;
};

/** A token this close to its end is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1_000;

function stringsOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** The credential a sealed value holds, or `undefined` for one that is not a credential of a plugin. */
export function readTrackerCredential(plain: string): TrackerCredential | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const extra = stringsOf(parsed?.extra);
  if (parsed?.via === 'token' && typeof parsed.token === 'string' && parsed.token !== '') {
    return { via: 'token', token: parsed.token, extra };
  }
  const { accessToken, refreshToken, expiresAt } = parsed ?? {};
  if (
    parsed?.via === 'oauth' &&
    typeof accessToken === 'string' &&
    typeof refreshToken === 'string' &&
    typeof expiresAt === 'number'
  ) {
    return { via: 'oauth', accessToken, refreshToken, expiresAt, extra };
  }

  return undefined;
}

export function sealTrackerCredential(credential: TrackerCredential, secretsKey: string): string {
  return seal(JSON.stringify(credential), secretsKey);
}

/** One refresh at a time for a connector: two would spend one refresh token, and the second is refused. */
const refreshing = new Map<string, Promise<TrackerCredential>>();

/**
 * How a plugin reaches its service for `connector`, whose row holds `sealed` now.
 *
 * WARNING: a refresh changes the refresh token, and the new pair is written before it is used. What
 * the store holds is read again first: another request can have refreshed it since `sealed` was read.
 */
export function trackerAccess(
  plugin: TrackerPlugin,
  connector: string,
  sealed: string,
  {
    accounts,
    secretsKey,
    client,
    http = fetch,
    now = Date.now,
  }: {
    accounts: AccountStore;
    secretsKey: string | undefined;
    client: OAuthClient | undefined;
    http?: Http;
    now?: () => number;
  },
): TrackerAccess {
  const openOf = (value: string): TrackerCredential => {
    if (secretsKey === undefined) throw new StoreError('This worker has no key to open a connector with');
    const plain = open(value, secretsKey);
    const credential = plain === undefined ? undefined : readTrackerCredential(plain);
    if (credential === undefined) throw new StoreError('The credential of this connector could not be opened');

    return credential;
  };

  async function credential(): Promise<TrackerCredential> {
    const first = openOf(sealed);
    if (first.via === 'token' || first.expiresAt - now() > REFRESH_MARGIN_MS) return first;
    const running = refreshing.get(connector);
    if (running !== undefined) return running;
    const refresh = (async (): Promise<TrackerCredential> => {
      const kept = await accounts.sealedKey(connector);
      if (kept === undefined) throw new StoreError('The connector of this site is gone');
      const latest = openOf(kept.sealed);
      if (latest.via === 'token' || latest.expiresAt - now() > REFRESH_MARGIN_MS) return latest;
      if (plugin.oauth === undefined || client === undefined) {
        throw new StoreError(`This worker has no ${plugin.name} application to refresh a token with`);
      }
      const answer = await plugin.oauth.refresh(latest.refreshToken, client, http, now());
      if (answer === 'ended') {
        throw new TrackerConnectionEnded(`The connection to ${plugin.name} ended. Connect ${plugin.name} again.`);
      }
      const next: TrackerCredential = { via: 'oauth', ...answer, extra: latest.extra };
      await accounts.resealConnector(connector, sealTrackerCredential(next, secretsKey as string));

      return next;
    })().finally(() => refreshing.delete(connector));
    refreshing.set(connector, refresh);

    return refresh;
  }

  return { credential, http, now };
}
