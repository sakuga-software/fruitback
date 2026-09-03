import type { Seed, SeedIssue } from '@fruitback/shared';
import type { ClientConfig, ClientPolicy } from './clients.ts';

/**
 * Where a seed is stored, behind one interface (SKG-522).
 *
 * The seam already existed and was not named: `app.ts` selected between `linear.ts` and
 * `linear-memory.ts` through a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>`,
 * which is an interface discovered by accident. This is that interface written down, so a second
 * store — SQLite (SKG-524), GitHub Issues (SKG-525) — is an implementation rather than a rewrite.
 *
 * **What is deliberately not here: how to find the seeds of a page.** Linear can filter server-side
 * with `description: { contains: <canonical url> }`, GitHub searches issue bodies, a SQL store does a
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
 * (SKG-524). The widget does not read it — this travels in the `201` body, where an empty string
 * would be a URL the caller could follow to nowhere.
 */
export type CreatedIssue = { id: string; identifier: string; url?: string };

/** The read the worker asks for: every seed on one page, for one client. */
export type SeedIssueQuery = { url: string; clientId: string | undefined };

export type SeedStore = {
  /** For `/health` and the boot log. Never for an error code — see `StoreError`. */
  readonly name: string;
  /**
   * What tells one tenant's answers from another's, for the read cache.
   *
   * The worker used to build its cache key from `routing.teamId`, which meant the read path knew
   * Linear routes by team. Only the store knows what identifies a tenant — a team for Linear, an
   * `owner/repo` for GitHub, nothing at all for a single-file SQLite — so it says so here and the
   * worker just uses the string.
   */
  scope(client: ClientConfig | undefined): string;
  create(seed: Seed, client: ClientConfig | undefined, policy: ClientPolicy): Promise<CreatedIssue>;
  findForPage(query: SeedIssueQuery, client: ClientConfig | undefined, policy: ClientPolicy): Promise<SeedIssue[]>;
};
