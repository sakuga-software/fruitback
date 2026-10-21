import type { Auth } from './auth.ts';
import { type ClientMap, type ClientPolicy, type ClientResolution, originsFromClients } from './clients.ts';
import type { AccountStore, Reach, Role } from './accounts.ts';
import type { AttachmentStore } from './attachments.ts';
import type { ConnectStore } from './connect.ts';
import type { TxtResolver } from './domain-proof.ts';
import type { WorkerConfig } from './env.ts';
import type { IdentityResult } from './identity.ts';
import type { InstanceAdminReads } from './instance-admin.ts';
import type { Kv } from './kv.ts';
import { seen } from './last-seen.ts';
import type { Mailer } from './mail.ts';
import type { NoteIndex } from './notes-index.ts';
import type { SessionIdentity, SessionStore } from './session.ts';
import type { ReplyAuthor, SeedStore } from './store.ts';

/**
 * What one request of `app.ts` reads, out of `app.ts` so that each module of routes names it
 * (FRU-363): what the transport knows (`RequestContext`), the configuration as the request reads it
 * (`Served`), and a token as a route checks it (`Verified`).
 */

/** What the transport knows and the request itself cannot say. */
export type RequestContext = {
  /** Already resolved against the trusted proxy chain — see `resolveClientIp`. */
  clientIp: string;
  /**
   * The store, built **once by the transport** rather than per request.
   *
   * This began as `storeFor(config)` inside the two handlers, which was invisible for Linear and the
   * in-memory one — both are stateless closures — and would have opened a SQLite connection per
   * request the moment FRU-31 landed. A refactor that exists to let a store hold a resource must
   * not reconstruct it on every call.
   *
   * Optional because `handleRequest` answers `/health` and the misconfigured diagnostic *before*
   * there is a validated config to build a store from, so the transport cannot always have one. When
   * it is absent the fallback builds one, which is also what a test driving this directly wants: a
   * fresh store per case.
   */
  store?: SeedStore;
  /** Same reason as `store`, for the sessions (FRU-42). A suite hands over a fresh file per case. */
  sessionStore?: SessionStore;
  /** Same reason, for the accounts, the workspaces and their sites (FRU-96). */
  accounts?: AccountStore;
  /** Same reason, for the requests of the extension that the console approves (FRU-238). */
  connectStore?: ConnectStore;
  /** What sends the sign-in links (FRU-98). A suite hands over one that keeps what it was given. */
  mailer?: Mailer;
  /** What asks the DNS for the proof of a domain (FRU-103). A suite hands over a double. */
  resolveTxt?: TxtResolver;
  /**
   * better-auth, for a worker that has it on (FRU-147). Absent, the handler takes the one instance of
   * the process (`authFor`), built when the server started. A suite hands over one on PGlite.
   */
  auth?: Auth | Promise<Auth>;
  /** Where the files of the notes wait for their tracker (FRU-331). A suite hands over one in memory. */
  attachments?: AttachmentStore;
  /**
   * Where the rate limiter and the read cache keep their state (FRU-49). When it is absent, the
   * handler uses `kvFor`, which gives the one instance of this process and never a new empty one.
   */
  kv?: Kv;
  /** The index of the notes (FRU-237). A suite hands over one on PGlite. */
  noteIndex?: NoteIndex;
  /** What the administrator of the instance reads (FRU-261). A suite hands over one on PGlite. */
  instanceAdmin?: InstanceAdminReads;
};

/**
 * The configuration with the sites of every workspace as its clients, and their origins allowed.
 *
 * An empty map stays an empty map: a worker with accounts and no site yet serves no client, and an
 * `undefined` here would turn it into a single-client worker that answers anybody.
 */
export async function withSites(config: WorkerConfig, accounts: AccountStore): Promise<Served> {
  const clients = await accounts.clientMap();

  return {
    ...config,
    clients,
    allowedOrigins: [...new Set([...config.allowedOrigins, ...originsFromClients(clients)])],
    roleIn: (workspace, account) => accounts.role(workspace, account),
    reachIn: (workspace, account) => accounts.reach(workspace, account),
    accountActive: async (account) => {
      const found = await accounts.account(account);

      return found !== undefined && found.suspended !== true;
    },
    seenIn: (workspace, account) => seen(accounts, workspace, account),
    suspendedIn: async (workspace) => (await accounts.suspension(workspace)) !== undefined,
  };
}

/**
 * The configuration as one request reads it: the sites of the accounts are its clients, each with
 * the places it can send to, and the role of a person in a workspace can be asked (FRU-123).
 */
export type Served = WorkerConfig & {
  clients?: ClientMap;
  /** Absent on a worker with no accounts: nobody is a member of anything there. */
  roleIn?: (workspace: string, account: string) => Promise<Role | undefined>;
  /** The role and the sites of a person in a workspace (FRU-250). Absent on a worker with no accounts. */
  reachIn?: (workspace: string, account: string) => Promise<Reach | undefined>;
  /**
   * Whether an account is still there (FRU-238), and not suspended (FRU-281). Absent on a worker with
   * no accounts.
   */
  accountActive?: (account: string) => Promise<boolean>;
  /** That a member was seen in a workspace today (FRU-249). Absent on a worker with no accounts. */
  seenIn?: (workspace: string, account: string) => Promise<void>;
  /** Whether an administrator of the instance suspended a workspace (FRU-282). Absent on a worker with no accounts. */
  suspendedIn?: (workspace: string) => Promise<boolean>;
};

/**
 * `session` is there only for a token the worker key verified, with the workspace of the client
 * (FRU-123). A site signs its own tokens and can write any claim in them, a workspace included: what
 * says that a caller is a person of the workspace is the key, never a claim.
 */
export type Verified = IdentityResult & { session?: true };

/** The checks of the caller that `app.ts` keeps, and that its modules of routes call. */
export type CallerChecks = {
  /** Which client a request belongs to, and what was decided for it: `routeFor` of `app.ts`. */
  routeFor: (request: Request, config: Served, clientId: string | undefined) => ClientResolution;
  /** Who writes a reply, or why nobody may: `replyAuthorFor` of `app.ts`. */
  replyAuthorFor: (
    request: Request,
    policy: ClientPolicy,
    workspace: string | undefined,
    typed: string | undefined,
    accounts: AccountStore | undefined,
  ) => Promise<{ ok: true; author: ReplyAuthor; account: boolean } | { ok: false; status: number; reason: string }>;
  /** The answer to a write of a session of an account that ended: `endedSession` of `app.ts`. */
  endedSession: (
    stillWrites: () => Promise<boolean>,
    corsHeaders: Record<string, string>,
  ) => Promise<Response | undefined>;
  /** The person of a session still valid in the store: `sessionWrites` of `app.ts`. */
  sessionWrites: (request: Request, config: Served, context: RequestContext) => Promise<SessionIdentity | undefined>;
  /** The account that writes in a workspace for a site: `writerIn` of `app.ts`. */
  writerIn: (
    request: Request,
    config: Served,
    context: RequestContext,
    workspace: string,
    site: string | undefined,
  ) => Promise<string | undefined>;
  /** Whether the caller is a guest, who reads no reference of a tracker: `hidesTracker` of `app.ts`. */
  hidesTracker: (request: Request, config: Served, policy: ClientPolicy) => Promise<boolean>;
  /** The longest reply: `REPLY_LENGTH` of `app.ts`, where the side panel of the extension reads it. */
  REPLY_LENGTH: number;
};
