import {
  type Note,
  type NoteComment,
  type NoteIssue,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
} from '@fruitback/shared';
import { z } from 'zod';
import type { ClientPolicy } from './clients.ts';
import { ATTACHMENT_SUBTITLE, type IssueNode, stageForLinearState, toNoteIssue } from './linear.ts';
import type { OutgoingFile } from './attachments.ts';
import { checkText, replyText } from './reply-text.ts';
import type { CheckAnswer, CreatedWithFiles, NewCheck, NewReply, NoteIssueQuery, NoteStore } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

/**
 * Linear, in memory, for the dev loop (FRU-19).
 *
 * The playground needs the whole round — capture, issue, pins coloured by state — and the real thing
 * needs an API key and writes into a workspace people actually triage. This stands in for it, behind
 * `FRUITBACK_STORE=memory` and never in production — see `createMemoryStoreSpec` below, whose
 * `devOnly` flag is the whole of that guard since FRU-33.
 *
 * It is deliberately not a mock: an issue is stored as the **description string**
 * `buildIssueDescription` produces, and read back through the same `toNoteIssue` the real path uses.
 * So the dev loop exercises the round trip for real, and a seed that stops parsing breaks the
 * playground the same way it would break production — which is the entire point of having one.
 *
 * `apps/worker/src/linear-stub.ts` is a different thing: it fakes `fetch` for the unit tests. This
 * one is a store the running process serves from.
 */

/**
 * Keyed by **client id**, not by team (FRU-29). A team is Linear's way of separating tenants and
 * this store has no reason to borrow it — the client id is what both paths already carry.
 */
type StoredIssue = IssueNode & { labels: string[]; clientId: string | undefined; page: string };

const issues: StoredIssue[] = [];

/**
 * New issues walk through the workflow states rather than all landing in `backlog`, so the overlay
 * shows every pin colour without anyone having to triage a fake ticket. `stageForLinearState` maps
 * these to new / todo / progress / done / closed.
 */
/**
 * Canned replies, so the dev loop shows a pin that has been answered (FRU-13).
 *
 * Every third issue gets a thread. A playground where nothing ever has comments makes the feature
 * invisible, and one where everything does hides the empty case — which is the one the widget has to
 * render without looking broken.
 */
const DEV_COMMENTS = [
  { body: 'Bien vu, on regarde ça cette semaine.', author: 'Alice' },
  { body: 'Corrigé sur la préprod — tu peux revérifier ?', author: 'Bruno' },
];

const DEV_STATES = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
] as const;

async function createNoteIssue(
  seed: Note,
  locale?: string,
  files: readonly OutgoingFile[] = [],
): Promise<CreatedWithFiles> {
  const number = issues.length + 1;
  // The state and the replies follow the rank of the issue on its page, not in the whole store. The
  // E2E specs run side by side and each keeps to its own page (FRU-268): five notes on one page get
  // five states, and the third gets replies, whatever the other specs write at the same moment.
  const onPage = issues.filter((issue) => issue.page === seed.page.url).length + 1;
  const state = DEV_STATES[onPage % DEV_STATES.length] ?? DEV_STATES[0];
  const identifier = `DEV-${String(number).padStart(3, '0')}`;

  issues.push({
    id: `dev_issue_${number}`,
    identifier,
    // Deliberately not a linear.app URL: a dev pin must not offer a link that 404s on the real one.
    url: `http://localhost/dev-issue/${identifier}`,
    title: buildIssueTitle(seed),
    updatedAt: new Date().toISOString(),
    description: buildIssueDescription(seed, { locale }),
    state: { name: state.name, type: state.type },
    // Deliberately newest-first, like Linear's own default: the ordering is `toNoteComments`'s job,
    // and a fake that hands back an already-sorted list would never exercise it.
    comments: {
      nodes:
        onPage % 3 === 0
          ? [...DEV_COMMENTS].reverse().map((comment, index) => ({
              id: `dev_comment_${number}_${index}`,
              body: comment.body,
              createdAt: new Date(Date.now() - index * 60_000).toISOString(),
              user: { name: comment.author },
            }))
          : [],
    },
    // FRU-331: the files as Linear lists them on an issue. The bytes are not kept: the dev loop shows
    // that a note has its files, and no address here opens one.
    attachments: {
      nodes: files.map((file) => ({
        title: file.name,
        url: `http://localhost/dev-issue/${identifier}/attachments/${encodeURIComponent(file.name)}`,
        subtitle: ATTACHMENT_SUBTITLE,
      })),
    },
    labels: buildIssueLabels(seed),
    clientId: seed.client?.id,
    page: seed.page.url,
  });
  const issue = { id: `dev_issue_${number}`, identifier, url: `http://localhost/dev-issue/${identifier}` };

  return files.length === 0
    ? issue
    : { ...issue, files: { sent: files.map((file) => file.id), lost: [], waiting: [] } };
}

async function fetchNoteIssues(query: NoteIssueQuery, policy: ClientPolicy): Promise<NoteIssue[]> {
  return (
    issues
      // Same isolation as the real filter, by the key this store actually holds. A read that names no
      // client gets every seed on the page, as on the other stores (FRU-34).
      .filter((issue) => query.clientId === undefined || issue.clientId === query.clientId)
      // `contains`, like the real filter — the exact URL check is `toNoteIssue`'s job, here as there.
      .filter((issue) => (issue.description ?? '').includes(query.url))
      // Same `toNoteIssue` as production, the policy included — which is what makes the dev loop
      // show exactly what a client with replies switched off would see.
      .map((issue) => toNoteIssue(issue, query.url, policy))
      .filter((issue): issue is NoteIssue => issue !== null)
  );
}

/** A reply under an issue of this client (FRU-257), as Linear would keep it: the dev author is the key's. */
async function createReply(
  id: string,
  reply: NewReply,
  clientId: string | undefined,
  locale?: string,
): Promise<NoteComment | undefined> {
  const issue = issues.find((each) => each.id === id && (clientId === undefined || each.clientId === clientId));
  if (issue === undefined) return undefined;
  const comment = {
    id: `dev_reply_${issue.id}_${issue.comments?.nodes.length ?? 0}`,
    body: replyText(reply, locale),
    createdAt: new Date().toISOString(),
    user: { name: 'Fruitback' },
  };
  issue.comments = { nodes: [comment, ...(issue.comments?.nodes ?? [])] };

  return { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.user.name };
}

/**
 * A verdict on an issue of this client (FRU-294). « Still wrong » puts the issue back in Backlog
 * first, as the real store picks the first state of the team that is not started.
 */
async function createCheck(
  id: string,
  check: NewCheck,
  clientId: string | undefined,
  locale?: string,
): Promise<CheckAnswer | undefined> {
  const issue = issues.find((each) => each.id === id && (clientId === undefined || each.clientId === clientId));
  if (issue === undefined) return undefined;
  if (check.verdict === 'wrong') issue.state = { name: 'Backlog', type: 'backlog' };
  const comment = {
    id: `dev_reply_${issue.id}_${issue.comments?.nodes.length ?? 0}`,
    body: checkText(check, locale),
    createdAt: new Date().toISOString(),
    user: { name: 'Fruitback' },
  };
  issue.comments = { nodes: [comment, ...(issue.comments?.nodes ?? [])] };

  return {
    comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.user.name },
    stage: stageForLinearState(issue.state?.type ?? ''),
  };
}

/** Test seam: the state of the issue `id`, as a team would move it in Linear. */
export function setMemoryIssueState(id: string, state: { name: string; type: string }): void {
  const issue = issues.find((each) => each.id === id);
  if (issue === undefined) throw new Error(`no issue ${id} in the dev store`);
  issue.state = state;
}

/** Test seam, and what makes each playground run start from an empty page. */
export function resetMemoryLinear(): void {
  issues.length = 0;
}

/**
 * The issues this store holds, for the tests.
 *
 * The description is what the playground reads its pins back from, and the read path answers seeds
 * rather than prose — so nothing else can see what was written into it.
 */
export function memoryIssues(): { description?: string | null }[] {
  return issues;
}

/**
 * The dev-loop store, as a `NoteStore` (FRU-29).
 *
 * It stays in this file, and it stays built on `toNoteIssue` from the real connector. That coupling
 * is the feature: an issue is stored as the description `buildIssueDescription` produces and read
 * back through production's own mapping, so a broken round trip breaks the playground too. Renaming
 * the file to something provider-agnostic would advertise an independence it does not have, and
 * should not have.
 *
 * What did change is that `app.ts` no longer special-cases it through a `fakeLinear` boolean: it is
 * one implementation among several, selected the same way any other is.
 */
export function createMemoryStore(): NoteStore {
  return {
    name: 'memory',
    // The client id is already part of the worker's cache key, so there is nothing further to
    // distinguish here — unlike Linear, where two clients can share one team.
    scope: () => 'memory',
    // FRU-331: it stands in for Linear, which takes the files of a note.
    attachments: true,
    create: (seed, _client, policy, files) => createNoteIssue(seed, policy.locale, files),
    findForPage: (query, _client, policy) => fetchNoteIssues(query, policy),
    reply: (target, reply, _client, policy) => createReply(target.issue, reply, target.clientId, policy.locale),
    check: (target, check, _client, policy) => createCheck(target.issue, check, target.clientId, policy.locale),
  };
}

/**
 * The dev-loop store as a selectable provider (FRU-33): `FRUITBACK_STORE=memory`.
 *
 * `devOnly`, and that flag is the whole of the guard FRU-19 wrote by hand. It reads no environment
 * of its own — there is nothing to configure about a list in a variable — so its `envNames` map is
 * empty and it can never be the reason a boot diagnostic names a variable.
 */
export function createMemoryStoreSpec(): StoreSpec {
  return defineStore({
    provider: 'memory',
    devOnly: true,
    envNames: {},
    read: () => ({}),
    schema: z.object({}),
    create: () => createMemoryStore(),
  });
}
