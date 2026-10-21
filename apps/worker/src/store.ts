import type { Seed, SeedComment, SeedIssue, SeedStage } from '@fruitback/shared';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import type { OutgoingFile } from './attachments.ts';

/**
 * Where a seed is stored, behind one interface (FRU-29).
 *
 * The seam already existed and was not named: `app.ts` selected between `linear.ts` and
 * `linear-memory.ts` through a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>`,
 * which is an interface discovered by accident. This is that interface written down, so a second
 * store — SQLite (FRU-31), GitHub Issues (FRU-32) — is an implementation rather than a rewrite.
 *
 * **What is deliberately not here: how to find the seeds of a page.** Linear can filter server-side
 * with `description: { contains: <canonical url> }`, GitHub lists issues by label, a SQL store does a
 * `WHERE`, and a store with no search at all would have to walk everything. So `findForPage` states
 * the *intention* and each store picks its method. Exposing a `contains` filter would have made
 * Linear's trick the contract.
 */

/**
 * Upstream failed, and the widget should keep the note and retry.
 *
 * Named for the role, not the vendor: `app.ts` turns this into `502 store-unavailable`, and an error
 * code the widget reads is a promise we make to it — "this was not your fault" — which must not
 * change meaning when the store behind it does.
 */
export class StoreError extends Error {}

/**
 * What a store hands back after planting a seed.
 *
 * `url` is optional for the same reason it is on `SeedIssue`: a store may have no interface to open
 * (FRU-31). The widget does not read it — this travels in the `201` body, where an empty string
 * would be a URL the caller could follow to nowhere.
 */
export type CreatedIssue = { id: string; identifier: string; url?: string };

/**
 * What became of the files of a note (FRU-331), by their ids in transit, for a store that takes them.
 *
 * - `sent`: the tracker has the file. The worker removes it from the transit.
 * - `lost`: the note is written, and the tracker refused the file. The worker removes it too: the
 *   note is not sent again for it.
 * - `waiting`: a delivery carries the file later. It stays in transit until that delivery arrives.
 */
export type FilesAnswer = { sent: string[]; lost: string[]; waiting: string[] };

/** A note planted with its files. */
export type CreatedWithFiles = CreatedIssue & { files?: FilesAnswer };

/** What became of one seed of a batch: its issue, or a store that did not keep it. */
export type BatchAnswer = { issue: CreatedIssue } | { error: 'store-unavailable' };

/**
 * What a store may remember of a batch from one attempt to the next (FRU-195). The worker holds it,
 * for the seeds of the batch and the minutes a seed is remembered; a store with no parent ignores it.
 *
 * Nothing here may throw: a memory that does not answer only costs the reuse of a parent.
 */
export type BatchMemory = {
  /** The parent an earlier attempt wrote for one of these seeds. */
  parent(): Promise<string | undefined>;
  /** Remembers the parent of these seeds. */
  keepParent(id: string): Promise<void>;
  /** Forgets it: the next attempt writes a new one. */
  forgetParent(): Promise<void>;
};

/** The read the worker asks for: every seed on one page, for one client. */
export type SeedIssueQuery = { url: string; clientId: string | undefined };

export type SeedStore = {
  /** For `/health` and the boot log. Never for an error code — see `StoreError`. */
  readonly name: string;
  /**
   * The stages this store can report. Absent means every stage in `SEED_STAGES`.
   *
   * `GET /feedback` sends this list, and the settings panel offers a filter only for these stages
   * (FRU-32). A filter for a stage that no pin can have does nothing.
   */
  readonly stages?: readonly SeedStage[];
  /**
   * The stages for one client, when they depend on it (FRU-188): a worker whose sites send to the
   * trackers of their workspaces reports the stages of the tracker of each site, not its own.
   * Absent: `stages`, for every client.
   */
  stagesFor?(client: ClientConfig | undefined): Promise<readonly SeedStage[] | undefined>;
  /**
   * What tells one tenant's answers from another's, for the read cache.
   *
   * The worker used to build its cache key from `routing.teamId`, which meant the read path knew
   * Linear routes by team. Only the store knows what identifies a tenant — a team for Linear, an
   * `owner/repo` for GitHub, nothing at all for a single-file SQLite — so it says so here and the
   * worker just uses the string.
   */
  scope(client: ClientConfig | undefined): string;
  /**
   * Plant one seed. `files` are its attachments in transit (FRU-331), for a store that takes them
   * (`attachments`): the store sends them to its tracker, and says what became of each.
   *
   * A store throws `StoreError` when the note is not written: the files then stay in transit, and the
   * widget sends the note again. Once the note is written, a file that fails is `lost`, never a throw.
   */
  create(
    seed: Seed,
    client: ClientConfig | undefined,
    policy: ClientPolicy,
    files?: readonly OutgoingFile[],
  ): Promise<CreatedWithFiles>;
  /**
   * `true` on a store that sends the files of a note to its tracker (FRU-331). Absent: it takes
   * none, as a store with no tracker (« Kept in Fruitback ») and GitHub, whose API takes no file.
   */
  readonly attachments?: true;
  /** Whether the store of this client takes files, for a store that routes by client. */
  attachmentsFor?(client: ClientConfig | undefined): Promise<boolean>;
  /**
   * Plant several seeds as one batch (FRU-124): a tracker groups them under one parent, and each
   * seed is still its own issue, with its own state. One answer for each seed, in order.
   *
   * It throws `StoreError` only when nothing was written. A store without it gets one `create` for
   * each seed: `createAll` in `batch.ts`. `memory` is absent when the caller keeps none.
   */
  createBatch?(
    seeds: readonly Seed[],
    client: ClientConfig | undefined,
    policy: ClientPolicy,
    memory?: BatchMemory,
  ): Promise<BatchAnswer[]>;
  findForPage(query: SeedIssueQuery, client: ClientConfig | undefined, policy: ClientPolicy): Promise<SeedIssue[]>;
  /**
   * Delete the seeds that `which` selects, and the replies to them (FRU-85, FRU-111).
   *
   * Only a store that holds the rows itself has this. A tracker keeps the issues in the team's own
   * workspace, and the team deletes them there. `node server.mjs forget` refuses a store without it.
   */
  forget?(which: ForgetSelector, options: { dryRun: boolean }): Promise<ForgottenSeed[]>;
  /**
   * Write a reply under one note (FRU-257), as the text of `replyText`, and answer it as a read will
   * show it. `undefined`: this store holds no such note for this client. Absent: this store takes no
   * reply. A tracker writes it under the identity of its key.
   */
  reply?(
    target: ReplyTarget,
    reply: NewReply,
    client: ClientConfig | undefined,
    policy: ClientPolicy,
  ): Promise<SeedComment | undefined>;
  /**
   * Whether the store of this client takes a reply, for a store that routes by client. Absent: the
   * answer is whether `reply` is there.
   */
  repliesFor?(client: ClientConfig | undefined): Promise<boolean>;
  /**
   * The verdict of a person on a note that the team marked done (FRU-294), as a marked reply under
   * the note (`checkText`). `wrong` then reopens the note in this store. The answer is the reply
   * and the stage the note has now. `undefined`: this store holds no such note for this client.
   * Absent: this store takes no verdict. A store with `check` has `reply` too.
   */
  check?(
    target: ReplyTarget,
    check: NewCheck,
    client: ClientConfig | undefined,
    policy: ClientPolicy,
  ): Promise<CheckAnswer | undefined>;
  /** Whether the store of this client takes a verdict, for a store that routes by client. */
  checksFor?(client: ClientConfig | undefined): Promise<boolean>;
};

/** What a person says of a note that the team marked done (FRU-294). */
export type CheckVerdict = 'fixed' | 'wrong';

/** A verdict to write. Only a member gives one: the route refuses everybody else. */
export type NewCheck = {
  verdict: CheckVerdict;
  author: Extract<ReplyAuthor, { kind: 'member' }>;
  /** What the person typed with « Still wrong », if anything. */
  body?: string;
};

/** The marked reply that a verdict wrote, and the stage of the note after it. */
export type CheckAnswer = { comment: SeedComment; stage: SeedStage };

/**
 * Who writes a reply, as the worker knows it (FRU-257). A member is a session of the workspace of the
 * site, named by its account. A visitor is anybody else, and the name they typed is their word.
 */
export type ReplyAuthor = { kind: 'member'; name: string; workspace: string } | { kind: 'visitor'; name?: string };

/** The note a reply goes under: the `id` of its issue, and the client whose note it must be. */
export type ReplyTarget = { issue: string; clientId: string | undefined };

/** A reply to write: what somebody typed, and who they are. */
export type NewReply = { body: string; author: ReplyAuthor };

/** Whether a store takes the files of a note for this client (FRU-331). */
export async function takesAttachments(store: SeedStore, client: ClientConfig | undefined): Promise<boolean> {
  return store.attachmentsFor === undefined ? store.attachments === true : store.attachmentsFor(client);
}

/** Whether a store takes a reply for this client. */
export async function takesReplies(store: SeedStore, client: ClientConfig | undefined): Promise<boolean> {
  return store.repliesFor === undefined ? store.reply !== undefined : store.repliesFor(client);
}

/**
 * Whether a store takes a verdict for this client (FRU-294): it has `check`, and it takes a reply
 * there. A store that hides its replies would write a verdict that no read shows.
 */
export async function takesChecks(store: SeedStore, client: ClientConfig | undefined): Promise<boolean> {
  if (store.checksFor !== undefined) return store.checksFor(client);

  return store.check !== undefined && (await takesReplies(store, client));
}

/**
 * Which seeds to forget.
 *
 * An address and a name are what the reporter typed, so each one is a claim. An identifier names
 * one seed, and it is what an operator uses after reading the list.
 */
export type ForgetSelector = { email: string } | { name: string } | { identifiers: readonly string[] };

/** One seed that `forget` found, as the operator reads it before it goes. */
/** A note `forget` found. `seed` is the id the widget gave it, which the index of the notes is keyed on. */
export type ForgottenSeed = { identifier: string; seed: string; createdAt: string; pageUrl: string; note: string };
