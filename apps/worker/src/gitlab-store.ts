import {
  FRUITBACK_LABEL,
  type Note,
  type NoteAttachment,
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  clientLabelName,
  noteIssueSchema,
  parseNoteFromDescription,
} from '@fruitback/shared';
import { z } from 'zod';
import type { OutgoingFile } from './attachments.ts';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { COMMENTS_PER_ISSUE, githubLabelName, mapInBatches, searchPhrase } from './github.ts';
import {
  GITLAB_PROJECT_ID,
  type GitlabTarget,
  GitlabProjectRefused,
  GitlabResponseError,
  type Http,
  gitlabCall,
} from './gitlab-api.ts';
import { type CreatedWithFiles, type NoteIssueQuery, type NoteStore, StoreError, type TrackerState } from './store.ts';

/**
 * The issues of a GitLab project, as a `NoteStore` (FRU-623). The project of a note is the `teamId`
 * of its destination: the number of the project, which a rename or a move does not change.
 *
 * It follows the store of GitHub (`github.ts`): the same labels, the same note in the description,
 * the same read of the newest issues then a search. What differs is GitLab's:
 *
 * - **The labels are made by the issue.** `labels` of « New issue » creates a label that does not
 *   exist, so there is no call per label. They are named by `githubLabelName`: GitLab splits the
 *   parameter on commas too.
 * - **The files go.** « Project markdown uploads » puts each file in the project, and its Markdown
 *   goes under the note in the description. A read gives them back by their address.
 * - **Two states**, `opened` and `closed`. GitLab says no reason for a close, so a closed issue is
 *   `done`: a site that wants another stage gives it in its statuses.
 */

/** The stages this store reports, in `NOTE_STAGES` order. */
export const GITLAB_STAGES: readonly NoteStage[] = ['new', 'done'];

/** The two states of an issue, by their name in the API, for the statuses of a site (FRU-368). */
export const GITLAB_STATES: readonly TrackerState[] = [
  { id: 'opened', name: 'Open', stage: 'new' },
  { id: 'closed', name: 'Closed', stage: 'done' },
];

/** The heading of the files of a note in the description. A read takes the links under it. */
export const FILES_HEADING = '#### Files';

const PAGE_SIZE = 100;
/** Ten pages of a search, as for GitHub: a page with more notes keeps its newest ones. */
const SEARCH_MAX_PAGES = 10;
const NOTES_AT_ONCE = 4;

const createdSchema = z.object({ id: z.number(), iid: z.number(), web_url: z.string().min(1) });
const uploadSchema = z.object({ markdown: z.string().min(1) });
const issueSchema = z.object({
  id: z.number(),
  iid: z.number(),
  web_url: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  updated_at: z.string(),
  user_notes_count: z.number(),
  labels: z.array(z.string()),
});
type IssueRow = z.infer<typeof issueSchema>;
const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  created_at: z.string(),
  system: z.boolean(),
  author: z.object({ username: z.string() }).nullable().optional(),
});

export type GitlabStoreOptions = {
  http: Http;
  /** The instance and the token, opened at each call: the store keeps no token between two. */
  target: () => Promise<GitlabTarget>;
  /** The connector the statuses are named by: `<connector>:opened`. */
  statusSource?: string;
  /** The stage a site gives a state, by its id, over the one of `GITLAB_STATES`. */
  stages?: Readonly<Record<string, NoteStage>>;
};

export function createGitlabStore({ http, target, statusSource, stages = {} }: GitlabStoreOptions): NoteStore {
  function projectOf(client: ClientConfig | undefined): string {
    const project = client?.teamId;
    // The value comes from a row, and it goes into the path of each call.
    if (project === undefined || !GITLAB_PROJECT_ID.test(project)) {
      throw new StoreError('This destination names no GitLab project');
    }

    return project;
  }

  /** A call on the project. A `403` or a `404` is a project the token does not reach. */
  async function call(project: string, path: string, init?: Parameters<typeof gitlabCall>[3]): Promise<unknown> {
    try {
      return await gitlabCall(http, await target(), `/projects/${project}${path}`, init);
    } catch (error) {
      if (
        error instanceof GitlabResponseError &&
        !error.rateLimited &&
        (error.status === 403 || error.status === 404)
      ) {
        throw new GitlabProjectRefused(`GitLab responded ${error.status} for this project`);
      }
      throw error;
    }
  }

  /**
   * Puts each file in the project before the issue exists. A file that GitLab refuses throws: no
   * issue is written, the files stay in transit, and the widget sends the note again, as Linear does.
   */
  async function upload(project: string, files: readonly OutgoingFile[]): Promise<string[]> {
    const markdown: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.content)], { type: file.type }), file.name);
      const answer = uploadSchema.safeParse(await call(project, '/uploads', { method: 'POST', form }));
      if (!answer.success) throw new StoreError('GitLab returned no upload');
      markdown.push(answer.data.markdown);
    }

    return markdown;
  }

  async function comments(project: string, issue: IssueRow): Promise<NoteComment[]> {
    if (issue.user_notes_count === 0) return [];
    // Newest first, so one page holds the newest replies. The changes GitLab writes are left out.
    const params = new URLSearchParams({
      sort: 'desc',
      order_by: 'created_at',
      activity_filter: 'only_comments',
      per_page: String(COMMENTS_PER_ISSUE),
    });
    const answer = await call(project, `/issues/${issue.iid}/notes?${params}`);
    if (!Array.isArray(answer)) return [];

    return answer
      .flatMap((row) => {
        const comment = commentSchema.safeParse(row);

        return comment.success && !comment.data.system ? [comment.data] : [];
      })
      .reverse()
      .map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? '',
        createdAt: comment.created_at,
        ...(comment.author?.username ? { author: comment.author.username } : {}),
      }));
  }

  async function list(project: string, params: Record<string, string>): Promise<unknown[]> {
    const answer = await call(project, `/issues?${new URLSearchParams({ ...params, per_page: String(PAGE_SIZE) })}`);
    if (!Array.isArray(answer)) throw new StoreError('GitLab returned no list of issues');

    return answer;
  }

  /** The newest issues with the labels, then a search for the page when there are more (as GitHub). */
  async function issuesOfPage(project: string, labels: string[], url: string): Promise<unknown[]> {
    const base = { labels: labels.join(','), scope: 'all', order_by: 'created_at', sort: 'desc' };
    const newest = await list(project, base);
    if (newest.length < PAGE_SIZE) return newest;
    const rows = [...newest];
    for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
      let found: unknown[];
      try {
        found = await list(project, { ...base, search: searchPhrase(url), page: String(page) });
      } catch (error) {
        if (!(error instanceof GitlabResponseError) || !error.rateLimited) throw error;
        console.error('[fruitback] GitLab refused the search of a page: its older notes are not read');
        break;
      }
      rows.push(...found);
      if (found.length < PAGE_SIZE) break;
    }
    const seen = new Set<unknown>();

    return rows.filter((row) => {
      const id = (row as { id?: unknown } | null)?.id;
      if (seen.has(id)) return false;
      seen.add(id);

      return true;
    });
  }

  return {
    name: 'gitlab',
    stages: GITLAB_STAGES,
    scope: (client) => `${statusSource ?? 'gitlab'}:${projectOf(client)}`,
    attachments: true,

    async create(note: Note, client, policy: ClientPolicy, files: readonly OutgoingFile[] = []) {
      const project = projectOf(client);
      const uploaded = await upload(project, files);
      const labels = buildIssueLabels(note).map(githubLabelName);
      const description = buildIssueDescription(note, { locale: policy.locale });
      const created = createdSchema.safeParse(
        await call(project, '/issues', {
          method: 'POST',
          json: {
            title: buildIssueTitle(note),
            description:
              uploaded.length === 0 ? description : `${description}\n\n${FILES_HEADING}\n\n${uploaded.join('\n\n')}\n`,
            labels: labels.join(','),
          },
        }),
      );
      if (!created.success) throw new StoreError('GitLab returned no issue');
      const answer: CreatedWithFiles = {
        id: String(created.data.id),
        identifier: `#${created.data.iid}`,
        url: created.data.web_url,
      };

      return files.length === 0
        ? answer
        : { ...answer, files: { sent: files.map((file) => file.id), lost: [], waiting: [] } };
    },

    ...(statusSource === undefined ? {} : { trackerStates: async () => [...GITLAB_STATES] }),

    async findForPage(query: NoteIssueQuery, client: ClientConfig | undefined, policy: ClientPolicy) {
      const project = projectOf(client);
      const labels = (query.clientId ? [FRUITBACK_LABEL, clientLabelName(query.clientId)] : [FRUITBACK_LABEL]).map(
        githubLabelName,
      );
      const matched = (await issuesOfPage(project, labels, query.url)).flatMap((row) => {
        const match = matchPage(row, query.url, labels, query.clientId);

        return match === null ? [] : [match];
      });

      const issues = await mapInBatches(matched, NOTES_AT_ONCE, async ({ issue, note }) => {
        const known = GITLAB_STATES.find((state) => state.id === issue.state);
        const thread = policy.showComments ? await comments(project, issue) : undefined;
        const files = filesOf(issue);

        return noteIssueSchema.safeParse({
          id: String(issue.id),
          identifier: `#${issue.iid}`,
          url: issue.web_url,
          title: issue.title,
          stage: Object.hasOwn(stages, issue.state) ? stages[issue.state] : (known?.stage ?? 'new'),
          stateName: known?.name ?? issue.state,
          ...(statusSource === undefined || known === undefined ? {} : { status: `${statusSource}:${known.id}` }),
          updatedAt: issue.updated_at,
          ...(thread === undefined ? {} : { comments: thread }),
          ...(files.length === 0 ? {} : { attachments: files }),
          note,
        });
      });

      return issues.flatMap((result): NoteIssue[] => (result.success ? [result.data] : []));
    },
  };
}

/**
 * The issue and its note, when the row is a note of this page. The labels are checked again, without
 * case, so the isolation of the clients does not rest on the query alone; the note confirms the page
 * and the client.
 */
function matchPage(
  row: unknown,
  url: string,
  labels: string[],
  clientId: string | undefined,
): { issue: IssueRow; note: Note } | null {
  const issue = issueSchema.safeParse(row);
  if (!issue.success) return null;
  const carried = issue.data.labels.map((name) => name.toLowerCase());
  if (!labels.every((name) => carried.includes(name.toLowerCase()))) return null;
  const parsed = parseNoteFromDescription(issue.data.description);
  if (!parsed.ok || parsed.note.page.url !== url) return null;
  if (clientId && parsed.note.client?.id !== clientId) return null;

  return { issue: issue.data, note: parsed.note };
}

const LINK = /!?\[([^\]\n]+)\]\((\/uploads\/[0-9a-f]{32}\/[^)\s]+)\)/g;

/**
 * The files under `FILES_HEADING`, with the address of the project: GitLab writes them as
 * `/uploads/<secret>/<name>`, under the page of the project.
 */
function filesOf(issue: IssueRow): NoteAttachment[] {
  const at = issue.description?.lastIndexOf(`\n${FILES_HEADING}\n`) ?? -1;
  if (at === -1) return [];
  const project = issue.web_url.replace(/\/-\/issues\/\d+$/, '').replace(/\/issues\/\d+$/, '');

  return [...(issue.description as string).slice(at).matchAll(LINK)].map(([, name, path]) => ({
    name: name as string,
    url: `${project}${path as string}`,
  }));
}
