import type { Account, Answer, Invitation, Me, Site, Visibility, Workspace, Writers } from './api.ts';
import { NAME_PROBLEMS, WORKSPACE_NOT_CREATED, problemOf } from './problems.ts';
import { workspaceNameFrom } from './workspace-name.ts';

/**
 * Where the setup of a person is (FRU-239), decided from what the worker answers. No React and no
 * network here: the screen gives the calls (`SetupCalls`), and `setup-stage.test.ts` gives fakes.
 */

/**
 * The site of the setup. `fresh`: it was added in this visit, so nothing was noted on it yet.
 * `left`: a site that « Change » replaced and did not remove, which the Sites screen still lists.
 */
export type Added = { site: Site; fresh?: boolean; left?: Site };

export type Stage =
  | { kind: 'loading' }
  | { kind: 'email' }
  | { kind: 'sent'; email: string }
  /**
   * Signed in, and the workspace could not be made: the person tries again, with the name they like.
   * `problem`: what the worker said of the try that was made for them.
   */
  | { kind: 'unnamed'; account: Account; problem: string }
  /** The sites of the workspace could not be read. That is not « no site »: nothing is asked again. */
  | { kind: 'unread'; account: Account; workspace: Workspace }
  /** `replaces`: the site that « Change » opened again, with its values in the form. */
  | { kind: 'site'; account: Account; workspace: Workspace; replaces?: Added }
  | ({ kind: 'install'; account: Account; workspace: Workspace } & Added)
  /** An invitation waits for this person: they came to join a workspace, not to make one. */
  | { kind: 'invited' }
  /**
   * Signed in, with no workspace, and the invitations could not be read: none is made until they
   * are, as this person may have come to join one.
   */
  | { kind: 'unchecked'; account: Account }
  /**
   * A member or a guest of a workspace with no site: only an owner or an admin adds one. The Sites
   * screen says so, as the front door sends them there too.
   */
  | { kind: 'waiting'; workspace: Workspace };

export type Made = { workspace: Workspace; problem?: undefined } | { workspace?: undefined; problem: string };

/** What the setup asks of the worker and of the browser. */
export type SetupCalls = {
  /** `GET /console/me`, quiet: a person who is not signed in is no notice. */
  me: () => Promise<Answer<Me>>;
  invitations: () => Promise<Answer<Invitation[]>>;
  /** The first site of the workspace, or none: one page of one site (FRU-497). */
  sites: (workspace: Workspace) => Promise<Answer<{ sites: Site[] }>>;
  /** One site by its id (FRU-497), with its notes. */
  site: (workspace: Workspace, site: string) => Promise<Answer<Site>>;
  createWorkspace: (name: string) => Promise<Answer<Workspace>>;
  /** Runs `task` alone in every tab of the browser, when the browser has a lock. */
  alone: <T>(task: () => Promise<T>) => Promise<T>;
};

/**
 * What a site added by the setup is (FRU-610): seen by the members of the workspace, and noted by
 * them only. The setup asks no question of access: these are the safe answers, and the Sites screen
 * opens a site to every visitor. They are the defaults of the worker too, but they are sent, so a
 * worker that would default otherwise cannot open a new site behind the sentence of the setup.
 */
export const NEW_SITE: Readonly<{ visibility: Visibility; writers: Writers }> = {
  visibility: 'members',
  writers: 'members',
};

/** A way to put Fruitback on a site, as step 3 of the setup draws them: a card each. */
export type Way = 'extension' | 'script';

/**
 * The way step 3 recommends for a site (FRU-610). A site of members: the extension, as only members
 * see its notes and the extension needs nothing on the site. A site that every visitor sees: the
 * script tag, as a visitor has no extension.
 */
export function recommendedWay(site: Pick<Site, 'visibility'>): Way {
  return site.visibility === 'everyone' ? 'script' : 'extension';
}

/** Who changes the name of a workspace and adds a site: `can` of the worker says the same. */
export function manages(workspace: Workspace): boolean {
  return workspace.role === 'owner' || workspace.role === 'admin';
}

/**
 * The first workspace of a person, named after their address.
 *
 * WARNING: one at a time, in every tab of the browser. The tab that waited for the link and the tab
 * of the link can both arrive here in the same second, and each would make a workspace. `alone` is
 * the lock of the browser (`navigator.locks`); the tab that gets it second reads `/console/me` again
 * and finds the workspace of the first.
 */
export function firstWorkspace(calls: SetupCalls, account: Account, name?: string): Promise<Made> {
  return calls.alone(async (): Promise<Made> => {
    const again = await calls.me();
    const made = again.ok ? again.data.workspaces[0] : undefined;
    if (made !== undefined) return { workspace: made };
    const created = await calls.createWorkspace(name ?? workspaceNameFrom(account.email));

    return created.ok
      ? { workspace: created.data }
      : { problem: problemOf(created, NAME_PROBLEMS, WORKSPACE_NOT_CREATED) };
  });
}

/**
 * Where the setup of this person is: read from the worker at each visit, so it resumes anywhere.
 * `signedIn` hears the account, for the language of the person.
 */
export async function resolveStage(calls: SetupCalls, signedIn: (me: Me) => void = () => {}): Promise<Stage> {
  const me = await calls.me();
  if (!me.ok) return { kind: 'email' };
  signedIn(me.data);
  const { account } = me.data;

  let workspace = me.data.workspaces[0];
  if (workspace === undefined) {
    // Somebody who was invited joins a workspace: none is made for them behind their back.
    // A worker with no invitations at all answers 404: nobody can have been invited there.
    const invitations = await calls.invitations();
    if (!invitations.ok && invitations.status !== 404) return { kind: 'unchecked', account };
    if (invitations.ok && invitations.data.length > 0) return { kind: 'invited' };
    const made = await firstWorkspace(calls, account);
    if (made.workspace === undefined) return { kind: 'unnamed', account, problem: made.problem };
    workspace = made.workspace;
  }

  return siteStage(calls, account, workspace);
}

/** The step of a person who has a workspace: its first site, or the form that adds one. */
export async function siteStage(calls: SetupCalls, account: Account, workspace: Workspace): Promise<Stage> {
  const listed = await calls.sites(workspace);
  if (!listed.ok) return { kind: 'unread', account, workspace };
  const site = listed.data.sites[0];
  if (site !== undefined) return { kind: 'install', account, workspace, site };

  return manages(workspace) ? { kind: 'site', account, workspace } : { kind: 'waiting', workspace };
}

/**
 * Whether a first note reached the site (FRU-242, FRU-237): a count of the index above zero, or the
 * day of a last note. A worker of before says neither, and the setup then waits as it did.
 */
export function noted(site: Site): boolean {
  const counted = Object.values(site.notes ?? {}).reduce((sum, count) => sum + count, 0);

  return counted > 0 || site.lastNoteAt !== undefined;
}

/**
 * The site as the worker reads it now, to see whether its first note came: the same site by its id,
 * or `undefined` when it was not read or is gone.
 */
export async function siteNow(calls: SetupCalls, workspace: Workspace, site: Site): Promise<Site | undefined> {
  const read = await calls.site(workspace, site.id);

  return read.ok && read.data?.id === site.id ? read.data : undefined;
}

/** Where a stage sends the person, away from the setup: none for a stage the setup shows. */
export function leaveFor(stage: Stage): string | undefined {
  if (stage.kind === 'invited') return '/invitations';
  if (stage.kind === 'waiting') return `/w/${stage.workspace.id}/sites`;

  return undefined;
}

/** The first note of the site, as the end of the setup shows it (FRU-610): what the index keeps of it. */
export type FirstNote = {
  /** Its first 64 characters: the index keeps no more of a text (FRU-237). */
  excerpt: string;
  page: { url: string; host: string; path: string };
  /** The id the widget gave it, which `#fruitback-note=` opens on its page (FRU-253). */
  note?: string;
};

/** The address of the list that holds the first note of a site: one page, with no count. */
export function firstNotePath(workspace: Workspace, site: Site): string {
  const query = new URLSearchParams({ site: site.id, limit: '8', counts: 'none' });

  return `/console/workspaces/${workspace.id}/notes?${query.toString()}`;
}

/**
 * The first note of the site, from one page of its list, the newest first: the last note of a page
 * that is the whole list. A page with a `next` holds only the newest notes: its last one is not the
 * first, so there is none to show (review of #834). The setup reads this list at its first note, so
 * a page of 8 holds them all unless notes came fast or the site was in use before.
 *
 * `undefined` too for a list that did not come, or a note that is not what the index answers. The
 * end of the setup is drawn without it then: a worker with no index (no database) answers `404`.
 */
export function firstNoteOf(answer: Answer<unknown>): FirstNote | undefined {
  if (!answer.ok) return undefined;
  const { notes, next } = (answer.data ?? {}) as { notes?: unknown; next?: unknown };
  if (!Array.isArray(notes) || next !== undefined) return undefined;
  const last: unknown = notes.at(-1);
  if (typeof last !== 'object' || last === null) return undefined;
  const { excerpt, page, note } = last as { excerpt?: unknown; page?: unknown; note?: unknown };
  if (typeof excerpt !== 'string' || typeof page !== 'object' || page === null) return undefined;
  const { url, host, path } = page as { url?: unknown; host?: unknown; path?: unknown };
  if (typeof url !== 'string' || typeof host !== 'string' || typeof path !== 'string') return undefined;

  return { excerpt, page: { url, host, path }, ...(typeof note === 'string' && note !== '' ? { note } : {}) };
}

/**
 * Where a link to the first note leads: its page, opened on the note when the worker gave its id.
 * `undefined` for a page that is not on the site: a console draws no link it did not check.
 */
export function firstNoteLink(first: FirstNote, site: Pick<Site, 'origin'>): string | undefined {
  let origin: string;
  try {
    origin = new URL(first.page.url).origin;
  } catch {
    return undefined;
  }
  if (origin !== site.origin) return undefined;

  return first.note === undefined
    ? first.page.url
    : `${first.page.url}#fruitback-note=${encodeURIComponent(first.note)}`;
}

/** The length of an excerpt of the index (`EXCERPT_LENGTH` of the worker), in characters. */
const EXCERPT_LENGTH = 64;

/** An excerpt as the list of the notes shows it: cut with « … » when the index cut it. */
export function excerptShown(excerpt: string): string {
  return [...excerpt].length >= EXCERPT_LENGTH ? `${excerpt.trimEnd()}…` : excerpt;
}
