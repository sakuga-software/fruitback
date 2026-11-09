import {
  GITLAB_COM,
  GITLAB_PROJECT_ID,
  type GitlabTarget,
  type Http as GitlabHttp,
  gitlabLabel,
  isAcceptableGitlabToken,
  listGitlabProjects,
  parseGitlabUrl,
  readGitlabProject,
  readGitlabUser,
} from '../gitlab-api.ts';
import { createGitlabStore } from '../gitlab-store.ts';
import { createGuardedFetch } from '../guarded-fetch.ts';
import { StoreError } from '../store.ts';
import { type TrackerAccess, TrackerInputRefused, type TrackerPlugin } from './plugin.ts';

/**
 * The connector GitLab (FRU-623): an issue in a project of gitlab.com or of a self-managed GitLab.
 *
 * It connects by an access token that a person types, never by OAuth: an application of OAuth is
 * registered on each instance, and a self-managed GitLab has none for Fruitback. The token is sealed
 * with the address of its instance (`extra.url`), and opened at each call. `gitlab-api.ts` says the
 * calls, `gitlab-store.ts` the issues.
 */

/**
 * WARNING: the address of a self-managed GitLab is the word of the workspace. Every call goes through
 * `createGuardedFetch`, which checks the address the socket connects to, whatever `http` the worker
 * hands the plugin: a `fetch` of the worker (`trackerHttp`) resolves a name itself, and a name that
 * answers an internal address would pass (review of #865). Only a test replaces it, by name, with
 * `useGitlabHttpForTests`.
 */
const guarded: GitlabHttp = createGuardedFetch();
let forTests: GitlabHttp | undefined;
const reach = (): GitlabHttp => forTests ?? guarded;

/** For the tests: the GitLab of a port of the machine, reached without the guard. `undefined` puts it back. */
export function useGitlabHttpForTests(http: GitlabHttp | undefined): void {
  forTests = http;
}

async function targetOf(access: TrackerAccess): Promise<GitlabTarget> {
  const credential = await access.credential();
  if (credential.via !== 'token') throw new StoreError('A GitLab connector holds a token');

  return { url: credential.extra.url ?? GITLAB_COM, token: credential.token };
}

export const plugin: TrackerPlugin | undefined = {
  kind: 'gitlab',
  name: 'GitLab',
  async connect(body) {
    const url = parseGitlabUrl(body.url);
    if (url === undefined) throw new TrackerInputRefused('invalid-address');
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isAcceptableGitlabToken(token)) throw new TrackerInputRefused('invalid-token');
    // Asked before anything is kept: a token that GitLab refuses throws `TrackerKeyRefused`.
    await readGitlabUser(reach(), { url, token });

    return { label: gitlabLabel(url), token, extra: { url } };
  },
  async places(access, { search, after }) {
    const { projects, next } = await listGitlabProjects(reach(), await targetOf(access), {
      ...(search === undefined || search === '' ? {} : { search }),
      ...(after === undefined ? {} : { after }),
    });

    return {
      places: projects.map((project) => ({ id: project.id, name: project.path })),
      ...(next === undefined ? {} : { next }),
    };
  },
  readPlace: (value) => (typeof value === 'string' && GITLAB_PROJECT_ID.test(value) ? value : undefined),
  async placeName(access, place) {
    const project = await readGitlabProject(reach(), await targetOf(access), place);

    return project === undefined ? undefined : { name: project.path };
  },
  store(access, { connector, stages }) {
    return createGitlabStore({
      http: reach(),
      target: () => targetOf(access),
      statusSource: connector,
      ...(stages === undefined ? {} : { stages }),
    });
  },
};
