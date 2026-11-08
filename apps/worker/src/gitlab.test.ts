import assert from 'node:assert/strict';
import { type IncomingMessage, type ServerResponse, createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import {
  GITLAB_COM,
  GitlabProjectRefused,
  GitlabTokenRefused,
  gitlabLabel,
  isAcceptableGitlabToken,
  listGitlabProjects,
  openGitlab,
  parseGitlabUrl,
  readGitlabProject,
  readGitlabUser,
  sealGitlab,
} from './gitlab-api.ts';
import { FILES_HEADING, GITLAB_STATES, createGitlabStore } from './gitlab-store.ts';
import { createGuardedFetch } from './guarded-fetch.ts';
import { StoreError } from './store.ts';

/**
 * The GitLab connector (FRU-623) against a GitLab on a port of this machine.
 *
 * The fake follows the REST API v4 as its documentation says it (read on 2026-11-08): `PRIVATE-TOKEN`,
 * `401 {"message":"401 Unauthorized"}` for a token unknown, expired or revoked, `404` for a project
 * the token does not reach, `labels` of « New issue » that creates a missing label and is ignored for
 * a Guest, `POST /uploads` that answers `markdown`, the notes newest first with `system`. The requests
 * go through the guarded `fetch` of the worker, opened to the loopback for this test only.
 */

type Seen = { method: string; path: string; query: URLSearchParams; token: string | undefined; body: string };
type Issue = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  web_url: string;
  updated_at: string;
  user_notes_count: number;
};
type Comment = { id: number; body: string; created_at: string; system: boolean; author: { username: string } };

/** The role of a token on each project it reaches. 10 is Guest, 20 Reporter. */
type Token = { user: string; projects: Record<number, number> };

const servers: { close(): void }[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

const PROJECTS: Record<number, string> = { 42: 'acme/web', 43: 'acme/api', 77: 'other/secret' };

async function fakeGitlab(tokens: Record<string, Token>) {
  const calls: Seen[] = [];
  const issues = new Map<number, Issue[]>();
  const comments = new Map<string, Comment[]>();
  let next = 1000;
  let refuse: number | undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const token = request.headers['private-token'] as string | undefined;
      const body = Buffer.concat(chunks).toString('latin1');
      calls.push({ method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, token, body });
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(value));
      };
      if (refuse !== undefined)
        return send(refuse, { message: `${refuse}` }, refuse === 429 ? { 'Retry-After': '60' } : {});
      const held = token === undefined ? undefined : tokens[token];
      if (held === undefined) return send(401, { message: '401 Unauthorized' });
      const path = url.pathname.replace(/^\/gitlab\/api\/v4|^\/api\/v4/, '');
      if (path === '/user') return send(200, { id: 1, username: held.user });
      if (path === '/projects' && request.method === 'GET') {
        const min = Number(url.searchParams.get('min_access_level') ?? '0');
        const search = url.searchParams.get('search');
        return send(
          200,
          Object.entries(held.projects)
            .filter(([, role]) => role >= min)
            .map(([id]) => ({
              id: Number(id),
              path_with_namespace: PROJECTS[Number(id)],
              web_url: `${origin}/${PROJECTS[Number(id)]}`,
            }))
            .filter((project) => search === null || project.path_with_namespace?.includes(search)),
        );
      }
      const project = /^\/projects\/(\d+)(\/.*)?$/.exec(path);
      if (project === null) return send(404, { message: '404 Not Found' });
      const id = Number(project[1]);
      const role = held.projects[id];
      if (role === undefined) return send(404, { message: '404 Project Not Found' });
      const rest = project[2] ?? '';
      if (rest === '')
        return send(200, { id, path_with_namespace: PROJECTS[id], web_url: `${origin}/${PROJECTS[id]}` });
      if (rest === '/uploads' && request.method === 'POST') {
        const name = /filename="([^"]+)"/.exec(body)?.[1] ?? 'file';
        const secret = 'a'.repeat(32);
        const alt = name.replace(/\.[^.]+$/, '');
        return send(201, {
          id: 5,
          alt,
          url: `/uploads/${secret}/${name}`,
          full_path: `/-/project/${id}/uploads/${secret}/${name}`,
          markdown: `![${alt}](/uploads/${secret}/${name})`,
        });
      }
      const list = issues.get(id) ?? [];
      if (rest === '/issues' && request.method === 'POST') {
        const asked = JSON.parse(body) as { title: string; description: string; labels: string };
        next += 1;
        const issue: Issue = {
          id: next,
          iid: list.length + 1,
          project_id: id,
          title: asked.title,
          description: asked.description,
          state: 'opened',
          // GitLab ignores the labels a Guest sets.
          labels: role >= 20 ? asked.labels.split(',') : [],
          web_url: `${origin}/${PROJECTS[id]}/-/issues/${list.length + 1}`,
          updated_at: '2026-11-08T10:00:00.000Z',
          user_notes_count: 0,
        };
        issues.set(id, [...list, issue]);
        return send(201, issue);
      }
      if (rest === '/issues' && request.method === 'GET') {
        const wanted = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
        const search = url.searchParams.get('search');
        const page = Number(url.searchParams.get('page') ?? '1');
        const size = Number(url.searchParams.get('per_page') ?? '20');
        const found = [...list]
          .reverse()
          .filter((issue) => wanted.every((label) => issue.labels.includes(label)))
          .filter((issue) => search === null || `${issue.title} ${issue.description}`.includes(search));
        return send(200, found.slice((page - 1) * size, page * size));
      }
      const notes = /^\/issues\/(\d+)\/notes$/.exec(rest);
      if (notes !== null && request.method === 'GET') {
        const all = [...(comments.get(`${id}#${notes[1]}`) ?? [])].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        );
        return send(200, all.slice(0, Number(url.searchParams.get('per_page') ?? '20')));
      }
      send(404, { message: '404 Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    calls,
    issues,
    comment(project: number, iid: number, comment: Comment) {
      const key = `${project}#${iid}`;
      comments.set(key, [...(comments.get(key) ?? []), comment]);
      const issue = issues.get(project)?.find((each) => each.iid === iid);
      if (issue !== undefined && !comment.system) issue.user_notes_count += 1;
    },
    refuse(status: number | undefined) {
      refuse = status;
    },
  };
}

/** The guarded `fetch` of the worker, opened to the loopback of the fake. */
const http = createGuardedFetch({ request: httpRequest as never, allows: () => true });

const TOKEN = 'glpat-reporter-0123456789abcdef';
const GUEST = 'glpat-guest-0123456789abcdefgh';
const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};
const client = (teamId: string): ClientConfig => ({ id: 'acme', teamId }) as ClientConfig;
const note = noteFixture();
const query = { url: note.page.url, clientId: 'acme' };

describe('the GitLab connector against a fake GitLab (FRU-623)', async () => {
  const gitlab = await fakeGitlab({
    [TOKEN]: { user: 'project_42_bot', projects: { 42: 30, 43: 20 } },
    [GUEST]: { user: 'guest', projects: { 42: 10 } },
  });
  const target = { url: gitlab.origin, token: TOKEN };
  const store = createGitlabStore({ http, target, statusSource: 'con_gl' });

  it('a note becomes an issue of the project, with its labels, and comes back on its page', async () => {
    const created = await store.create(note, client('42'), POLICY);
    assert.equal(created.identifier, '#1');
    assert.match(created.url ?? '', /\/acme\/web\/-\/issues\/1$/);
    const posted = gitlab.calls.findLast(
      (call) => call.method === 'POST' && call.path === '/api/v4/projects/42/issues',
    );
    assert.equal(posted?.token, TOKEN);
    assert.equal(JSON.parse(posted?.body ?? '{}').labels, 'fruitback,fruitback:acme');

    const read = await store.findForPage(query, client('42'), POLICY);
    assert.equal(read.length, 1);
    assert.equal(read[0]?.stage, 'new');
    assert.equal(read[0]?.stateName, 'Open');
    assert.equal(read[0]?.status, 'con_gl:opened');
    assert.equal(read[0]?.note.id, note.id);
    assert.deepEqual(read[0]?.comments, []);
    const listed = gitlab.calls.findLast((call) => call.method === 'GET' && call.path === '/api/v4/projects/42/issues');
    assert.equal(listed?.query.get('labels'), 'fruitback,fruitback:acme');
  });

  it('a closed issue is done on the pin, and a site that gives the state another stage wins', async () => {
    const issue = gitlab.issues.get(42)?.[0];
    assert.ok(issue);
    issue.state = 'closed';
    assert.equal((await store.findForPage(query, client('42'), POLICY))[0]?.stage, 'done');
    const staged = createGitlabStore({ http, target, statusSource: 'con_gl', stages: { closed: 'closed' } });
    const read = await staged.findForPage(query, client('42'), POLICY);
    assert.equal(read[0]?.stage, 'closed');
    assert.equal(read[0]?.status, 'con_gl:closed');
    assert.deepEqual(await store.trackerStates?.(client('42')), [...GITLAB_STATES]);
    issue.state = 'opened';
  });

  it('the replies are the comments of the issue, oldest first, without the notes GitLab writes itself', async () => {
    gitlab.comment(42, 1, {
      id: 1,
      body: 'Fixed on staging.',
      created_at: '2026-11-08T11:00:00Z',
      system: false,
      author: { username: 'mia' },
    });
    gitlab.comment(42, 1, {
      id: 2,
      body: 'closed',
      created_at: '2026-11-08T11:30:00Z',
      system: true,
      author: { username: 'mia' },
    });
    gitlab.comment(42, 1, {
      id: 3,
      body: 'Thanks',
      created_at: '2026-11-08T12:00:00Z',
      system: false,
      author: { username: 'leo' },
    });
    const read = await store.findForPage(query, client('42'), POLICY);
    assert.deepEqual(
      read[0]?.comments?.map((comment) => [comment.author, comment.body]),
      [
        ['mia', 'Fixed on staging.'],
        ['leo', 'Thanks'],
      ],
    );
    const asked = gitlab.calls.findLast((call) => call.path.endsWith('/issues/1/notes'));
    assert.equal(asked?.query.get('sort'), 'desc');
    // A site that hides the replies asks GitLab for none.
    const before = gitlab.calls.length;
    await store.findForPage(query, client('42'), { ...POLICY, showComments: false });
    assert.equal(gitlab.calls.slice(before).filter((call) => call.path.endsWith('/notes')).length, 0);
  });

  it('the files of a note are uploaded to the project, written under the note, and read back', async () => {
    const files = [{ id: 'att_1', name: 'capture.png', type: 'image/png', content: new Uint8Array([137, 80, 78, 71]) }];
    const created = await store.create(noteFixture({ id: 'sd_files' }), client('42'), POLICY, files);
    assert.deepEqual(created.files, { sent: ['att_1'], lost: [], waiting: [] });
    const upload = gitlab.calls.findLast((call) => call.path === '/api/v4/projects/42/uploads');
    assert.match(upload?.body ?? '', /name="file"; filename="capture.png"/);
    const issue = gitlab.issues.get(42)?.at(-1);
    assert.ok(issue?.description?.includes(`${FILES_HEADING}\n\n![capture](/uploads/`));
    const read = (await store.findForPage(query, client('42'), POLICY)).find((each) => each.note.id === 'sd_files');
    assert.deepEqual(read?.attachments, [
      { name: 'capture', url: `${gitlab.origin}/acme/web/uploads/${'a'.repeat(32)}/capture.png` },
    ]);
  });

  it('a file that GitLab refuses writes no issue: the note is sent again with it', async () => {
    const count = gitlab.issues.get(42)?.length;
    gitlab.refuse(413);
    await assert.rejects(
      store.create(note, client('42'), POLICY, [
        { id: 'att_2', name: 'big.bin', type: 'application/octet-stream', content: new Uint8Array(4) },
      ]),
      StoreError,
    );
    gitlab.refuse(undefined);
    assert.equal(gitlab.issues.get(42)?.length, count);
  });

  it('another client of the same project does not read these notes', async () => {
    assert.deepEqual(await store.findForPage({ ...query, clientId: 'other' }, client('42'), POLICY), []);
  });

  it('a project the token does not reach is a refusal of the project, for the health of the connector', async () => {
    await assert.rejects(store.create(note, client('77'), POLICY), GitlabProjectRefused);
    await assert.rejects(store.findForPage(query, client('77'), POLICY), GitlabProjectRefused);
  });

  it('a token GitLab refuses (unknown, expired or revoked: 401) is a refusal of the token', async () => {
    const revoked = createGitlabStore({ http, target: { ...target, token: 'glpat-revoked-0123456789abc' } });
    await assert.rejects(revoked.create(note, client('42'), POLICY), GitlabTokenRefused);
    await assert.rejects(readGitlabUser(http, { ...target, token: 'glpat-revoked-0123456789abc' }), GitlabTokenRefused);
  });

  it('a GitLab that limits the rate, or is down, is no refusal: the widget keeps the note', async () => {
    for (const status of [429, 500, 503]) {
      gitlab.refuse(status);
      const error = await store.create(note, client('42'), POLICY).catch((thrown: unknown) => thrown);
      assert.ok(error instanceof StoreError, String(status));
      assert.ok(!(error instanceof GitlabProjectRefused) && !(error instanceof GitlabTokenRefused), String(status));
    }
    gitlab.refuse(undefined);
  });

  it('a destination names a project the token reaches as Reporter: a Guest token lists none', async () => {
    assert.equal(await readGitlabUser(http, target), 'project_42_bot');
    const listed = await listGitlabProjects(http, target);
    assert.deepEqual(
      listed.projects.map((project) => [project.id, project.path]),
      [
        ['42', 'acme/web'],
        ['43', 'acme/api'],
      ],
    );
    assert.equal(
      gitlab.calls.findLast((call) => call.path === '/api/v4/projects')?.query.get('min_access_level'),
      '20',
    );
    assert.deepEqual(
      (await listGitlabProjects(http, target, { search: 'api' })).projects.map((p) => p.id),
      ['43'],
    );
    assert.deepEqual((await listGitlabProjects(http, { ...target, token: GUEST })).projects, []);
    assert.equal((await readGitlabProject(http, target, '42'))?.path, 'acme/web');
    assert.equal(await readGitlabProject(http, target, '77'), undefined);
    assert.equal(await readGitlabProject(http, target, '../users'), undefined);
  });

  it('a self-managed instance under a path is called under that path', async () => {
    const under = { url: `${gitlab.origin}/gitlab`, token: TOKEN };
    assert.equal(await readGitlabUser(http, under), 'project_42_bot');
    assert.equal(gitlab.calls.at(-1)?.path, '/gitlab/api/v4/user');
  });
});

describe('the address and the token of a GitLab connector (FRU-623)', () => {
  it('no address is gitlab.com; a self-managed one is https, public, and cut to its instance', () => {
    assert.equal(parseGitlabUrl(undefined), GITLAB_COM);
    assert.equal(parseGitlabUrl('  '), GITLAB_COM);
    assert.equal(parseGitlabUrl('https://gitlab.acme.dev/'), 'https://gitlab.acme.dev');
    assert.equal(parseGitlabUrl('https://acme.dev/gitlab/group/web/-/issues'), 'https://acme.dev/gitlab/group/web');
    assert.equal(parseGitlabUrl('https://gitlab.acme.dev/api/v4'), 'https://gitlab.acme.dev');
    for (const refused of [
      'http://gitlab.acme.dev',
      'https://127.0.0.1',
      'https://10.0.0.8',
      'https://localhost',
      'https://user:pass@gitlab.acme.dev',
      'https://gitlab.acme.dev/?x=1',
      'not an address',
      42,
    ]) {
      assert.equal(parseGitlabUrl(refused), undefined, String(refused));
    }
    assert.equal(gitlabLabel('https://gitlab.com'), 'GitLab · gitlab.com');
    assert.equal(gitlabLabel('https://acme.dev/gitlab'), 'GitLab · acme.dev/gitlab');
  });

  it('the token is sealed with the address, and opens with the same key only', () => {
    assert.equal(isAcceptableGitlabToken('glpat-short'), false);
    assert.equal(isAcceptableGitlabToken('glpat-with a space-0123456789'), false);
    assert.equal(isAcceptableGitlabToken(TOKEN), true);
    const sealed = sealGitlab({ url: GITLAB_COM, token: TOKEN }, 'a-key-of-thirty-two-characters-xx');
    assert.ok(!sealed.includes(TOKEN));
    assert.deepEqual(openGitlab(sealed, 'a-key-of-thirty-two-characters-xx'), { url: GITLAB_COM, token: TOKEN });
    assert.throws(() => openGitlab(sealed, 'another-key-of-thirty-two-chars-x'), StoreError);
  });

  it('the guarded fetch of the worker refuses the loopback by default', async () => {
    const gitlab = await fakeGitlab({ [TOKEN]: { user: 'bot', projects: {} } });
    const guarded = createGuardedFetch({ request: httpRequest as never });
    await assert.rejects(readGitlabUser(guarded, { url: gitlab.origin, token: TOKEN }), StoreError);
    await assert.rejects(
      readGitlabUser(guarded, { url: gitlab.origin.replace('127.0.0.1', 'localhost'), token: TOKEN }),
      StoreError,
    );
    assert.equal(gitlab.calls.length, 0);
  });
});
