import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ROLES, type Role, can } from './accounts.ts';
import { handleRequest } from './app.ts';
import { type Auth, ROLE_REFUSED, startAuth } from './auth.ts';
import { CONSOLE_URL, DATABASES, PUBLIC_URL, ask, databasesOfACase } from './auth.fixture.ts';
import { handleOrganizationRoutes } from './auth-organization.ts';
import { type Call, workerOf } from './auth-worker.fixture.ts';
import { MAX_BODY_BYTES } from './bounded-body.ts';
import { ORGANIZATION_PATHS } from './organization-paths.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { seal } from './secrets.ts';

/**
 * The routes of the organization plugin of better-auth that the worker serves (FRU-149): who gets
 * what on each one, what a guest does not read, the one role of a member, the last owner, and the
 * extension of somebody who is no longer of the workspace.
 *
 * Every case goes through `handleRequest`, with the cookie of a person who signed in by a link, on
 * PGlite and on a real server when the run has one. A case that says « better-auth alone » asks the
 * instance with no worker in front: it is the control of what the worker refuses.
 */

const { opening } = databasesOfACase();
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123456789';

type Worker = Awaited<ReturnType<typeof workerOf>>;
type Person = { email: string; cookie: string; id: string; member?: string };

const ORG = '/console/auth/organization';

async function workerOn(open: () => Promise<PgDatabase>) {
  return workerOf(await opening(open), { env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
}

/** Somebody who signed in by a link: their cookie, and their account. */
async function person(worker: Worker, email: string): Promise<Person> {
  const cookie = await worker.signIn(email);
  const me = (await (await worker.call('/console/me', { headers: { Cookie: cookie } })).json()) as {
    account: { id: string };
  };

  return { email, cookie, id: me.account.id };
}

/** A call of `who`, with their cookie. */
function as(worker: Worker, who: Person, path: string, init: Call = {}): Promise<Response> {
  return worker.call(path, { ...init, headers: { ...init.headers, Cookie: who.cookie } });
}

/** The plugin, called in the process: what a route of the worker, or a later one, would call. */
function api(worker: Worker) {
  return worker.auth.api as unknown as Record<string, (input: object) => Promise<Record<string, unknown>>>;
}

/** Adds somebody to a workspace with a role, through the plugin: its hook reads the role. */
async function added(worker: Worker, workspace: string, who: Person, role: string): Promise<Person> {
  const member = await api(worker).addMember?.({ body: { userId: who.id, role, organizationId: workspace } });
  assert.equal(typeof member?.id, 'string');

  return { ...who, member: member?.id as string };
}

/** A workspace that its owner made through the console, and one person in each of the other roles. */
async function team(worker: Worker, name = 'acme') {
  const owner = await person(worker, `owner@${name}.dev`);
  const made = await as(worker, owner, '/console/workspaces', { body: { name } });
  assert.equal(made.status, 201, await made.clone().text());
  const workspace = ((await made.json()) as { id: string }).id;
  const [row] = await rowsOf(worker.database, `SELECT id FROM member WHERE "organizationId" = '${workspace}'`);
  const people: Record<Role, Person> = {
    owner: { ...owner, member: String(row?.id) },
    admin: await added(worker, workspace, await person(worker, `admin@${name}.dev`), 'admin'),
    member: await added(worker, workspace, await person(worker, `member@${name}.dev`), 'member'),
    guest: await added(worker, workspace, await person(worker, `guest@${name}.dev`), 'guest'),
  };

  return { workspace, ...people };
}

async function roleOf(worker: Worker, member: string | undefined): Promise<unknown> {
  return (await rowsOf(worker.database, `SELECT role FROM member WHERE id = '${member}'`))[0]?.role;
}

/** An extension that `who` paired for a workspace, through the console: its tokens. */
async function extension(worker: Worker, who: Person, workspace: string) {
  const minted = await as(worker, who, `/console/workspaces/${workspace}/connect`, { body: {} });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const paired = await worker.call('/session/pair', { body: { code }, origin: null });
  assert.equal(paired.status, 200, await paired.clone().text());

  return (await paired.json()) as { refreshToken: string; accessToken: string };
}

const refresh = (worker: Worker, refreshToken: string) =>
  worker.call('/session/refresh', { body: { refreshToken }, origin: null });
const sitesOf = (worker: Worker, accessToken: string) =>
  worker.call('/session/sites', { origin: null, headers: { Authorization: `Bearer ${accessToken}` } });

for (const { label, open, skip } of DATABASES) {
  describe(`the routes of the organization plugin, on ${label} (FRU-149)`, { skip }, () => {
    it('makes a workspace through the plugin for somebody of the cookie, with its owner and no « active » one', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');

      const made = await as(worker, alice, '/console/workspaces', { body: { name: '  Acme   Studio ' } });

      assert.equal(made.status, 201);
      const workspace = (await made.json()) as { id: string; name: string; role: string };
      assert.match(workspace.id, /^ws_[0-9a-f]{20}$/);
      assert.deepEqual({ name: workspace.name, role: workspace.role }, { name: 'Acme Studio', role: 'owner' });
      assert.deepEqual(
        await rowsOf(worker.database, `SELECT "userId", role FROM member WHERE "organizationId" = '${workspace.id}'`),
        [{ userId: alice.id, role: 'owner' }],
      );
      const [member] = await rowsOf(worker.database, 'SELECT id FROM member');
      assert.match(String(member?.id), /^mem_[0-9a-f]{20}$/);
      // No call of the worker reads an « active » workspace: none is written in the session.
      assert.deepEqual(await rowsOf(worker.database, 'SELECT "activeOrganizationId" FROM session'), [
        { activeOrganizationId: null },
      ]);
      const me = (await (await as(worker, alice, '/console/me')).json()) as { workspaces: unknown[] };
      assert.deepEqual(me.workspaces, [{ id: workspace.id, name: 'Acme Studio', role: 'owner' }]);

      // The name is still read by the worker, before the plugin: the plugin takes any text.
      assert.equal((await as(worker, alice, '/console/workspaces', { body: { name: ' ' } })).status, 400);
      assert.equal((await as(worker, alice, '/console/workspaces', { body: { name: 'x'.repeat(81) } })).status, 400);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM organization')).length, 1);
      // The plugin made it: it has the slug that the route gave it, which nothing reads.
      assert.match(String((await rowsOf(worker.database, 'SELECT slug FROM organization'))[0]?.slug), /^slug_/);
    });

    it('answers 502 when better-auth does not make the workspace, and makes none', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const failing = {
        ...worker.auth,
        $context: worker.auth.$context,
        api: {
          ...worker.auth.api,
          createOrganization: async () => Promise.reject(new Error('the database of a test is down')),
        },
      } as unknown as Auth;
      const errors: string[] = [];
      const logged = mock.method(console, 'error', (line: string) => void errors.push(line));
      try {
        const answer = await handleRequest(
          new Request(`${PUBLIC_URL}/console/workspaces`, {
            method: 'POST',
            headers: { Origin: CONSOLE_URL, Cookie: alice.cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Acme' }),
          }),
          worker.env,
          {
            clientIp: '198.51.100.9',
            accounts: worker.accounts,
            sessionStore: worker.sessions,
            kv: worker.kv,
            auth: failing,
          },
        );

        assert.equal(answer.status, 502);
        assert.deepEqual(await answer.json(), { error: 'auth-unavailable' });
      } finally {
        logged.mock.restore();
      }
      assert.deepEqual(errors, ['[fruitback] better-auth did not answer: the database of a test is down']);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM organization'), []);
    });

    it('still makes a workspace in the store for a call with the token of before', async () => {
      const worker = await workerOn(open);
      await worker.call('/auth/email', { body: { email: 'bob@acme.dev' } });
      const code = /#([A-Za-z0-9_-]+)/.exec(worker.mail.sent.at(-1)?.text ?? '')?.[1];
      const opened = await worker.call('/auth/email/redeem', { body: { code } });
      const { accessToken } = (await opened.json()) as { accessToken: string };

      const made = await worker.call('/console/workspaces', {
        body: { name: 'Before' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      assert.equal(made.status, 201, await made.clone().text());
      const { id } = (await made.json()) as { id: string };
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id, slug FROM organization'), [{ id, slug: id }]);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT role FROM member'), [{ role: 'owner' }]);
    });

    it('answers each role, on each open route of the plugin, what its rule says', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const outsider = await person(worker, 'outsider@elsewhere.dev');
      // Somebody whose role a call changes, and one person to remove for each role that tries.
      const pawn = await added(worker, acme.workspace, await person(worker, 'pawn@acme.dev'), 'guest');
      const spare = {} as Record<Role, Person>;
      for (const role of ROLES) {
        spare[role] = await added(worker, acme.workspace, await person(worker, `spare-${role}@acme.dev`), 'guest');
      }
      const calls: Record<string, (who: Person, role: Role | undefined) => Promise<Response>> = {
        '/organization/list-members': (who) => as(worker, who, `${ORG}/list-members?organizationId=${acme.workspace}`),
        '/organization/update-member-role': (who) =>
          as(worker, who, `${ORG}/update-member-role`, {
            body: { organizationId: acme.workspace, memberId: pawn.member, role: 'member' },
          }),
        '/organization/remove-member': (who, role) =>
          as(worker, who, `${ORG}/remove-member`, {
            body: { organizationId: acme.workspace, memberIdOrEmail: spare[role ?? 'guest'].member },
          }),
        '/organization/leave': (who) => as(worker, who, `${ORG}/leave`, { body: { organizationId: acme.workspace } }),
      };
      // Every open route is asked: a route that gains a rule fails here until it has its line.
      assert.deepEqual(Object.keys(calls).toSorted(), Object.keys(ORGANIZATION_PATHS).toSorted());

      const answered: Record<string, Record<string, number>> = {};
      for (const [path, call] of Object.entries(calls)) {
        const needs = ORGANIZATION_PATHS[path]?.needs;
        answered[path] = {};
        for (const role of ROLES) {
          const answer = await call(acme[role], role);
          (answered[path] as Record<string, number>)[role] = answer.status;
          const allowed = needs === undefined || can(role, needs);
          if (!allowed) assert.deepEqual(await answer.json(), { error: 'forbidden', role }, `${role} on ${path}`);
          // The headers of CORS of the console are on the answer of better-auth too.
          assert.equal(answer.headers.get('Access-Control-Allow-Origin'), CONSOLE_URL, `${role} on ${path}`);
        }
        // Not a member: as a workspace that does not exist. No cookie: nobody.
        assert.equal((await call(outsider, undefined)).status, 404, `somebody of another workspace on ${path}`);
        const nobody = { ...outsider, cookie: '' };
        assert.equal((await call(nobody, undefined)).status, 401, `nobody on ${path}`);
      }

      assert.deepEqual(answered, {
        '/organization/list-members': { owner: 200, admin: 200, member: 200, guest: 403 },
        '/organization/update-member-role': { owner: 200, admin: 200, member: 403, guest: 403 },
        '/organization/remove-member': { owner: 200, admin: 200, member: 403, guest: 403 },
        // The owner is the last one: better-auth refuses, and the three others left.
        '/organization/leave': { owner: 400, admin: 200, member: 200, guest: 200 },
      });
      // What each call did, read in the database.
      assert.equal(await roleOf(worker, pawn.member), 'member');
      assert.equal(await roleOf(worker, spare.owner.member), undefined);
      assert.equal(await roleOf(worker, spare.admin.member), undefined);
      assert.equal(await roleOf(worker, spare.member.member), 'guest');
      assert.equal(await roleOf(worker, spare.guest.member), 'guest');
      assert.equal(await roleOf(worker, acme.owner.member), 'owner');
      for (const role of ['admin', 'member', 'guest'] as const) {
        assert.equal(await roleOf(worker, acme[role].member), undefined, `${role} left`);
      }
    });

    it('lists the members to a member with their name and address, and nothing of a tracker', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);

      const answer = await as(worker, acme.member, `${ORG}/list-members?organizationId=${acme.workspace}&limit=2`);

      assert.equal(answer.status, 200);
      const listed = (await answer.json()) as { members: Record<string, unknown>[]; total: number };
      assert.equal(listed.total, 4);
      assert.equal(listed.members.length, 2);
      for (const member of listed.members) {
        assert.deepEqual(Object.keys(member).toSorted(), [
          'createdAt',
          'id',
          'organizationId',
          'role',
          'user',
          'userId',
        ]);
        assert.deepEqual(Object.keys(member.user as object).toSorted(), ['email', 'id', 'image', 'name']);
      }
    });

    it('does not let a guest read the members or the invitations, on the API', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const closed = ['get-full-organization', 'list-invitations', 'list-user-invitations', 'get-invitation'];

      const members = await as(worker, acme.guest, `${ORG}/list-members?organizationId=${acme.workspace}`);
      assert.equal(members.status, 403);
      assert.deepEqual(await members.json(), { error: 'forbidden', role: 'guest' });
      for (const route of closed) {
        for (const who of [acme.guest, acme.owner]) {
          const answer = await as(worker, who, `${ORG}/${route}?organizationId=${acme.workspace}`);
          assert.equal(answer.status, 404, `${route} for ${who.email}`);
          assert.deepEqual(await answer.json(), { error: 'not-found' });
        }
        // The second lock: better-auth itself answers 404 on a route that has no rule.
        const direct = await ask(worker.auth, `/organization/${route}?organizationId=${acme.workspace}`, {
          headers: { Cookie: acme.guest.cookie },
        });
        assert.equal(direct.status, 404, `better-auth answers ${route}`);
      }
      // What a guest reads of the workspace: its name and their own role, and no other person.
      const me = await (await as(worker, acme.guest, '/console/me')).text();
      assert.match(me, /"role":"guest"/);
      assert.doesNotMatch(me, /owner@acme\.dev|admin@acme\.dev|member@acme\.dev/);

      // The control: better-auth alone, with its routes open, answers all of it to a guest. So the
      // refusals above are the worker's, and not a guest that better-auth would refuse anyway.
      const options = worker.auth.options;
      const alone = await startAuth({ ...options, disabledPaths: [] });
      for (const route of ['list-members', 'get-full-organization', 'list-invitations']) {
        const answer = await ask(alone, `/organization/${route}?organizationId=${acme.workspace}`, {
          headers: { Cookie: acme.guest.cookie },
        });
        assert.equal(answer.status, 200, `better-auth alone refuses ${route} to a guest`);
      }
      const full = await ask(alone, `/organization/get-full-organization?organizationId=${acme.workspace}`, {
        headers: { Cookie: acme.guest.cookie },
      });
      assert.match(await full.text(), /owner@acme\.dev/);
    });

    it('answers 404 on every route of the plugin that has no rule, and on an open one taken out of the list', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const plugin = worker.auth.options.plugins?.find((each) => each.id === 'organization');
      const routes = Object.values(
        (plugin?.endpoints ?? {}) as Record<string, { path?: string; options?: { method?: unknown } }>,
      )
        .filter((endpoint) => typeof endpoint.path === 'string')
        .map((endpoint) => ({ path: endpoint.path as string, method: String(endpoint.options?.method ?? 'GET') }));
      const withoutRule = routes.filter((route) => !Object.hasOwn(ORGANIZATION_PATHS, route.path));
      // The list names routes that the plugin has: a rule for a path that nothing serves holds nothing.
      assert.deepEqual(
        Object.keys(ORGANIZATION_PATHS).filter((path) => !routes.some((route) => route.path === path)),
        [],
      );
      assert.ok(withoutRule.length >= 18, `the plugin has only ${withoutRule.length} routes with no rule`);

      for (const { path, method } of withoutRule) {
        const body =
          method === 'POST'
            ? { organizationId: acme.workspace, name: 'x', slug: 'x', email: 'x@acme.dev', role: 'admin' }
            : undefined;
        const answer = await as(worker, acme.owner, `/console/auth${path}?organizationId=${acme.workspace}`, {
          method,
          ...(body === undefined ? {} : { body }),
        });
        assert.equal(answer.status, 404, `${method} ${path}`);
        assert.deepEqual(await answer.json(), { error: 'not-found' });
        const direct = await ask(worker.auth, path, {
          method,
          headers: { Cookie: acme.owner.cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.equal(direct.status, 404, `better-auth answers ${method} ${path} to a request`);
      }
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM organization')).length, 1);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM invitation')).length, 0);

      // An open route, taken out of the list: the same request answers 200 with it, and 404 without.
      const context = {
        auth: worker.auth,
        accounts: worker.accounts,
        sessions: worker.sessions,
        consoleUrl: CONSOLE_URL,
        clientIp: '198.51.100.7',
        trackIp: false,
      };
      const asked = () =>
        new Request(`${PUBLIC_URL}${ORG}/list-members?organizationId=${acme.workspace}`, {
          headers: { Cookie: acme.owner.cookie, Origin: CONSOLE_URL },
        });
      const { '/organization/list-members': _taken, ...shorter } = ORGANIZATION_PATHS;
      assert.equal((await handleOrganizationRoutes(asked(), `${ORG}/list-members`, context, {}))?.status, 200);
      const without = await handleOrganizationRoutes(asked(), `${ORG}/list-members`, context, {}, shorter);
      assert.equal(without?.status, 404);
      assert.deepEqual(await without?.json(), { error: 'not-found' });
    });

    it('refuses a call that names its workspace twice, by a slug, or with a field the rule does not have', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const [slug] = await rowsOf(worker.database, `SELECT slug FROM organization WHERE id = '${other.workspace}'`);
      const list = (query: string) => as(worker, acme.admin, `${ORG}/list-members?${query}`);
      const refused = async (answer: Response, field?: string) => {
        assert.equal(answer.status, 400);
        assert.deepEqual(await answer.json(), { error: 'invalid-request', ...(field === undefined ? {} : { field }) });
      };

      // The worker checked the role in one workspace: better-auth must not read another one.
      await refused(await list(`organizationId=${acme.workspace}&organizationSlug=${slug?.slug}`), 'organizationSlug');
      await refused(await list(`organizationId=${acme.workspace}&organizationId=${other.workspace}`));
      await refused(await list(`organizationSlug=${slug?.slug}`), 'organizationSlug');
      await refused(await list(''), 'organizationId');
      await refused(await list(`organizationId=${acme.workspace}&filterField=role&filterValue=owner`), 'filterField');
      await refused(await list(`organizationId=${acme.workspace}&limit=101`), 'limit');
      await refused(await list(`organizationId=${acme.workspace}&sortBy=userId`), 'sortBy');
      await refused(
        await as(worker, acme.admin, `${ORG}/update-member-role`, {
          body: { organizationId: acme.workspace, memberId: acme.guest.member, role: 'member', teamId: 'a-team' },
        }),
        'teamId',
      );
      await refused(await as(worker, acme.admin, `${ORG}/leave`, { body: {} }), 'organizationId');
      await refused(await as(worker, acme.admin, `${ORG}/leave`, { body: [acme.workspace] }));
      // A body over the cap of the worker is not read to its end, with or without its length said.
      for (const headers of [{}, { 'Content-Length': '12' }] as Record<string, string>[]) {
        const large = await as(worker, acme.admin, `${ORG}/leave`, {
          body: { organizationId: acme.workspace, padding: 'x'.repeat(MAX_BODY_BYTES) },
          headers,
        });
        assert.equal(large.status, 413);
        assert.deepEqual(await large.json(), { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES });
      }
      assert.equal(await roleOf(worker, acme.admin.member), 'admin');
      assert.equal(
        (await as(worker, acme.admin, `${ORG}/leave`, { method: 'GET' })).status,
        405,
        'a route answers another method',
      );

      // An admin of one workspace names a member of another one: better-auth refuses, nothing changes.
      for (const [route, body] of [
        ['update-member-role', { memberId: other.guest.member, role: 'admin' }],
        ['remove-member', { memberIdOrEmail: other.guest.member }],
      ] as const) {
        const answer = await as(worker, acme.admin, `${ORG}/${route}`, {
          body: { organizationId: acme.workspace, ...body },
        });
        assert.ok(answer.status === 400 || answer.status === 403, `${route} answered ${answer.status}`);
      }
      // And the workspace of another team answers as one that does not exist.
      const elsewhere = await as(worker, acme.owner, `${ORG}/remove-member`, {
        body: { organizationId: other.workspace, memberIdOrEmail: other.guest.member },
      });
      assert.equal(elsewhere.status, 404);
      assert.equal(await roleOf(worker, other.guest.member), 'guest');
    });

    it('refuses a call with the cookie that does not come from the console', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const body = { organizationId: acme.workspace, memberId: acme.guest.member, role: 'admin' };

      // No `Origin`: the worker. Another origin: the CORS of the console, before the route.
      for (const origin of [null, 'https://demo.fruitback.test']) {
        const answer = await as(worker, acme.owner, `${ORG}/update-member-role`, { body, origin });
        assert.equal(answer.status, 403, `origin ${origin}`);
        assert.deepEqual(await answer.json(), { error: 'origin-not-allowed' });
      }
      assert.equal(await roleOf(worker, acme.guest.member), 'guest');
      // The control: the same call from the console changes the role.
      assert.equal((await as(worker, acme.owner, `${ORG}/update-member-role`, { body })).status, 200);
      assert.equal(await roleOf(worker, acme.guest.member), 'admin');
    });

    it('gives a member one role, one of the four: on the route, and in the plugin called in the process', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const change = (role: unknown) =>
        as(worker, acme.owner, `${ORG}/update-member-role`, {
          body: { organizationId: acme.workspace, memberId: acme.guest.member, role },
        });

      for (const role of [['guest', 'admin'], 'guest,admin', 'guest, admin', 'superuser', '', ['admin'], null]) {
        const answer = await change(role);
        assert.equal(answer.status, 400, `the role ${JSON.stringify(role)}`);
        assert.deepEqual(await answer.json(), { error: 'invalid-request', field: 'role' });
      }
      assert.equal(await roleOf(worker, acme.guest.member), 'guest');

      // Under the route: the hook of the plugin, for a caller that is not this route. better-auth
      // alone writes `guest,admin` here (measured in FRU-139, and by the control of the next case).
      const headers = new Headers({ Cookie: acme.owner.cookie });
      const several = { organizationId: acme.workspace, memberId: acme.guest.member };
      const refusal = (error: unknown) => {
        assert.equal((error as { body?: { code?: unknown } }).body?.code, ROLE_REFUSED);

        return true;
      };
      await assert.rejects(
        api(worker).updateMemberRole?.({ body: { ...several, role: ['guest', 'admin'] }, headers }) as Promise<unknown>,
        refusal,
      );
      await assert.rejects(
        api(worker).updateMemberRole?.({ body: { ...several, role: 'guest,admin' }, headers }) as Promise<unknown>,
        refusal,
      );
      const newcomer = await person(worker, 'newcomer@acme.dev');
      for (const role of [['member', 'admin'], 'member,admin', 'superuser']) {
        await assert.rejects(
          api(worker).addMember?.({
            body: { userId: newcomer.id, role, organizationId: acme.workspace },
          }) as Promise<unknown>,
          refusal,
          `a member added as ${JSON.stringify(role)}`,
        );
      }
      assert.equal(await roleOf(worker, acme.guest.member), 'guest');
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${newcomer.id}'`), []);

      // The control: one role of the four is written, by the same two calls.
      assert.equal((await change('member')).status, 200);
      assert.equal(await roleOf(worker, acme.guest.member), 'member');
      assert.equal(typeof (await added(worker, acme.workspace, newcomer, 'guest')).member, 'string');
    });

    it('gives no right for a row « guest,admin » planted in the database', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const planted = acme.admin;
      const everything = async (): Promise<number[]> => {
        const answers = [
          await as(worker, planted, `${ORG}/list-members?organizationId=${acme.workspace}`),
          await as(worker, planted, `${ORG}/update-member-role`, {
            body: { organizationId: acme.workspace, memberId: acme.guest.member, role: 'guest' },
          }),
          await as(worker, planted, `${ORG}/remove-member`, {
            body: { organizationId: acme.workspace, memberIdOrEmail: 'nobody@acme.dev' },
          }),
          await as(worker, planted, `/console/workspaces/${acme.workspace}/sites`),
          await as(worker, planted, `/console/workspaces/${acme.workspace}/connect`, { body: {} }),
        ];

        return answers.map((answer) => answer.status);
      };
      // The control: as an admin, the same calls are answered (the member to remove does not exist).
      assert.deepEqual(await everything(), [200, 200, 400, 200, 201]);
      const paired = await extension(worker, planted, acme.workspace);

      await rowsOf(worker.database, `UPDATE member SET role = 'guest,admin' WHERE id = '${planted.member}'`);

      assert.deepEqual(await everything(), [404, 404, 404, 404, 404]);
      assert.equal(
        (await as(worker, planted, `${ORG}/leave`, { body: { organizationId: acme.workspace } })).status,
        404,
      );
      const me = (await (await as(worker, planted, '/console/me')).json()) as { workspaces: unknown[] };
      assert.deepEqual(me.workspaces, []);
      // Their extension is the one of somebody who is of no workspace.
      assert.equal((await sitesOf(worker, paired.accessToken)).status, 401);
      assert.equal((await refresh(worker, paired.refreshToken)).status, 401);
      assert.equal(await roleOf(worker, acme.guest.member), 'guest');

      // The control of the control: better-auth alone reads that row as an admin, and changes a role.
      const alone = await ask(worker.auth, '/organization/update-member-role', {
        method: 'POST',
        headers: { Cookie: planted.cookie },
        body: JSON.stringify({ organizationId: acme.workspace, memberId: acme.guest.member, role: 'member' }),
      });
      assert.equal(alone.status, 200, 'better-auth alone gives nothing to « guest,admin »: the case holds nothing');
    });

    it('keeps an invitation to one role too, for the day its route opens', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const headers = new Headers({ Cookie: acme.owner.cookie });
      const invite = (role: unknown) =>
        api(worker).createInvitation?.({
          body: { email: 'reviewer@client.dev', role, organizationId: acme.workspace },
          headers,
        }) as Promise<Record<string, unknown>>;

      for (const role of [['guest', 'admin'], 'guest,admin']) {
        await assert.rejects(invite(role), (error: unknown) => {
          assert.equal((error as { body?: { code?: unknown } }).body?.code, ROLE_REFUSED, JSON.stringify(role));

          return true;
        });
      }
      // A role that is not one of the four is refused by the plugin itself, before the hook.
      await assert.rejects(invite('superuser'));
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM invitation'), []);

      // The control: the same call with one role keeps an invitation, so the refusals are of the role.
      const said = mock.method(console, 'warn', () => {});
      try {
        assert.equal((await invite('guest')).role, 'guest');
      } finally {
        said.mock.restore();
      }
      assert.deepEqual(await rowsOf(worker.database, 'SELECT role FROM invitation'), [{ role: 'guest' }]);
    });

    it('lets somebody leave whose session names the workspace as its « active » one', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      // Nothing of the worker writes it: a row as another build, or a hand, could have left it.
      await rowsOf(
        worker.database,
        `UPDATE session SET "activeOrganizationId" = '${acme.workspace}' WHERE "userId" = '${acme.member.id}'`,
      );

      const left = await as(worker, acme.member, `${ORG}/leave`, { body: { organizationId: acme.workspace } });

      assert.equal(left.status, 200, await left.clone().text());
      assert.equal(await roleOf(worker, acme.member.member), undefined);
      // better-auth takes the workspace out of the session, which it finds by its token, through the
      // layer that keeps a digest: the session is still theirs.
      assert.deepEqual(
        await rowsOf(
          worker.database,
          `SELECT "activeOrganizationId" FROM session WHERE "userId" = '${acme.member.id}'`,
        ),
        [{ activeOrganizationId: null }],
      );
      assert.equal((await as(worker, acme.member, '/console/me')).status, 200);
    });

    it('keeps the last owner: they cannot leave, be removed, or be demoted, by themselves or by an admin', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const post = (who: Person, route: string, body: object) =>
        as(worker, who, `${ORG}/${route}`, { body: { organizationId: acme.workspace, ...body } });
      const code = async (answer: Response) => ((await answer.json()) as { code?: string }).code;
      const attempts: [string, Promise<Response>, number, string][] = [
        ['the owner leaves', post(acme.owner, 'leave', {}), 400, 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER'],
        [
          'the owner removes themselves',
          post(acme.owner, 'remove-member', { memberIdOrEmail: acme.owner.member }),
          400,
          'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
        ],
        [
          'the owner makes themselves an admin',
          post(acme.owner, 'update-member-role', { memberId: acme.owner.member, role: 'admin' }),
          400,
          'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
        ],
        [
          'an admin removes the owner',
          post(acme.admin, 'remove-member', { memberIdOrEmail: acme.owner.email }),
          400,
          'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
        ],
        [
          'an admin demotes the owner',
          post(acme.admin, 'update-member-role', { memberId: acme.owner.member, role: 'member' }),
          403,
          'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
        ],
        [
          'an admin makes themselves an owner',
          post(acme.admin, 'update-member-role', { memberId: acme.admin.member, role: 'owner' }),
          403,
          'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
        ],
      ];
      for (const [what, attempt, status, reason] of attempts) {
        const answer = await attempt;
        assert.deepEqual([answer.status, await code(answer)], [status, reason], what);
      }
      assert.equal(await roleOf(worker, acme.owner.member), 'owner');
      assert.equal(await roleOf(worker, acme.admin.member), 'admin');

      // The control: with a second owner, the first one may be demoted, and may leave.
      const second = await post(acme.owner, 'update-member-role', { memberId: acme.admin.member, role: 'owner' });
      assert.equal(second.status, 200);
      const demoted = await post(acme.owner, 'update-member-role', { memberId: acme.owner.member, role: 'admin' });
      assert.equal(demoted.status, 200, await demoted.clone().text());
      assert.equal(await roleOf(worker, acme.owner.member), 'admin');
      assert.equal((await post(acme.owner, 'leave', {})).status, 200);
      // And the one who stays is the last owner in turn.
      assert.equal((await post(acme.admin, 'leave', {})).status, 400);
    });

    type Team = Awaited<ReturnType<typeof team>>;
    /** What stops when somebody is no longer of a workspace, whichever call took them out of it. */
    const stopsTheirExtension = async (leaves: (worker: Worker, acme: Team) => Promise<Response>) => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      // The same person is a guest of another workspace too, with an extension there.
      const elsewhere = await added(worker, other.workspace, acme.member, 'guest');
      const theirs = await extension(worker, acme.member, acme.workspace);
      const kept = await extension(worker, elsewhere, other.workspace);
      const colleague = await extension(worker, acme.guest, acme.workspace);
      // A refresh before: the chain has two links, and the old one is inside its grace.
      const rotated = (await (await refresh(worker, theirs.refreshToken)).json()) as typeof theirs;
      assert.equal((await sitesOf(worker, rotated.accessToken)).status, 200);
      // A code minted and not redeemed yet.
      const minted = await as(worker, acme.member, `/console/workspaces/${acme.workspace}/connect`, { body: {} });
      const { code } = (await minted.json()) as { code: string };

      assert.equal((await leaves(worker, acme)).status, 200);

      // Ended in the store, at once: every token of the chain, and the code.
      const live = await rowsOf(
        worker.database,
        `SELECT token_hash FROM sessions WHERE subject = '${acme.member.id}' AND workspace = '${acme.workspace}' AND revoked_at IS NULL`,
      );
      assert.deepEqual(live, []);
      for (const token of [rotated.refreshToken, theirs.refreshToken]) {
        const answer = await refresh(worker, token);
        assert.equal(answer.status, 401);
        assert.deepEqual(await answer.json(), { error: 'session-revoked-or-expired' });
      }
      // The access token is still signed and not expired: the role is what refuses it.
      const sites = await sitesOf(worker, rotated.accessToken);
      assert.equal(sites.status, 401);
      assert.deepEqual(await sites.json(), { error: 'identity-required', reason: 'not-a-member' });
      const pairing = await worker.call('/session/pair', { body: { code }, origin: null });
      assert.equal(pairing.status, 401);
      assert.deepEqual(await pairing.json(), { error: 'code-spent-or-expired' });

      // The same person elsewhere, and a colleague here, go on.
      assert.equal((await refresh(worker, kept.refreshToken)).status, 200);
      assert.equal((await refresh(worker, colleague.refreshToken)).status, 200);
      // And the console of the person still opens: they left a workspace, not their account.
      assert.equal((await as(worker, acme.member, '/console/me')).status, 200);
    };

    it('stops the extension of a member who is removed: no refresh, no site, no code, and the others go on', () =>
      stopsTheirExtension((worker, acme) =>
        as(worker, acme.admin, `${ORG}/remove-member`, {
          body: { organizationId: acme.workspace, memberIdOrEmail: acme.member.member },
        }),
      ));

    it('stops the extension of a member who leaves: no refresh, no site, no code, and the others go on', () =>
      stopsTheirExtension((worker, acme) =>
        as(worker, acme.member, `${ORG}/leave`, { body: { organizationId: acme.workspace } }),
      ));

    it('ends at the next refresh the session of somebody whose membership went by another way', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const theirs = await extension(worker, acme.member, acme.workspace);
      const minted = await as(worker, acme.member, `/console/workspaces/${acme.workspace}/connect`, { body: {} });
      const { code } = (await minted.json()) as { code: string };
      // The control: a member refreshes.
      const first = await refresh(worker, theirs.refreshToken);
      assert.equal(first.status, 200);
      const { refreshToken } = (await first.json()) as { refreshToken: string };

      // A row deleted by hand: nothing called `endSessionsOf`, and the store still holds a live chain.
      await rowsOf(worker.database, `DELETE FROM member WHERE id = '${acme.member.member}'`);
      const live = `SELECT token_hash FROM sessions WHERE subject = '${acme.member.id}' AND revoked_at IS NULL`;
      assert.ok((await rowsOf(worker.database, live)).length > 0);

      const refused = await refresh(worker, refreshToken);
      assert.equal(refused.status, 401);
      assert.deepEqual(await refused.json(), { error: 'session-revoked-or-expired' });
      const pairing = await worker.call('/session/pair', { body: { code }, origin: null });
      assert.equal(pairing.status, 401);
      assert.deepEqual(await pairing.json(), { error: 'code-spent-or-expired' });
      // And nothing of it stays live: the successor that the refusal minted is ended with its chain.
      assert.deepEqual(await rowsOf(worker.database, live), []);
    });

    it('deletes a workspace for its owner only: the tokens of Linear first, then its sites, connectors, deliveries and extensions', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const site = await as(worker, acme.owner, `/console/workspaces/${acme.workspace}/sites`, {
        body: { url: 'https://staging.acme.dev' },
      });
      assert.equal(site.status, 201);
      await as(worker, other.owner, `/console/workspaces/${other.workspace}/sites`, {
        body: { url: 'https://staging.globex.dev' },
      });
      const linear = await worker.accounts.addConnector(acme.workspace, {
        kind: 'linear',
        label: 'Linear · Acme',
        sealed: seal(
          JSON.stringify({ accessToken: 'lin_access', refreshToken: 'lin_refresh', expiresAt: Date.now() + 3_600_000 }),
          SECRETS_KEY,
        ),
      });
      const rest = await worker.accounts.addConnector(acme.workspace, {
        kind: 'rest',
        label: 'hooks.acme.dev',
        sealed: seal('{}', SECRETS_KEY),
      });
      await worker.accounts.enqueueDelivery(rest.id, '{"a":"note"}', Date.now());
      const paired = await extension(worker, acme.member, acme.workspace);
      const elsewhere = await extension(worker, other.member, other.workspace);
      const count = async (table: string) => (await rowsOf(worker.database, `SELECT 1 FROM ${table}`)).length;
      assert.deepEqual([await count('sites'), await count('connectors'), await count('deliveries')], [2, 2, 1]);

      /** What Linear was asked, and how many connectors the workspace had at that moment. */
      const revoked: { url: string; body: string; connectors: number }[] = [];
      const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        revoked.push({
          url: String(input instanceof Request ? input.url : input),
          body: String(init?.body),
          connectors: (await worker.accounts.connectors(acme.workspace)).length,
        });

        return new Response(null, { status: 200 });
      });
      try {
        for (const who of [acme.admin, acme.member, acme.guest]) {
          const answer = await as(worker, who, `/console/workspaces/${acme.workspace}`, { method: 'DELETE' });
          assert.equal(answer.status, 403, who.email);
        }
        assert.equal(
          (await as(worker, other.owner, `/console/workspaces/${acme.workspace}`, { method: 'DELETE' })).status,
          404,
        );
        assert.deepEqual(revoked, [], 'a refused deletion revoked a token');
        assert.equal(await count('connectors'), 2);

        const deleted = await as(worker, acme.owner, `/console/workspaces/${acme.workspace}`, { method: 'DELETE' });
        assert.equal(deleted.status, 204);
      } finally {
        fetched.mock.restore();
      }

      // Linear was told while the connector was still there to read the token from.
      assert.deepEqual(revoked, [
        {
          url: 'https://api.linear.app/oauth/revoke',
          body: 'token=lin_refresh&token_type_hint=refresh_token',
          connectors: 2,
        },
      ]);
      assert.equal(typeof linear.id, 'string');
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM organization WHERE id = '${acme.workspace}'`), []);
      assert.deepEqual(
        await rowsOf(worker.database, `SELECT id FROM member WHERE "organizationId" = '${acme.workspace}'`),
        [],
      );
      // What stays is the other workspace's.
      assert.deepEqual([await count('sites'), await count('connectors'), await count('deliveries')], [1, 0, 0]);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT origin FROM sites'), [
        { origin: 'https://staging.globex.dev' },
      ]);
      // Read before any refresh: the refresh of somebody who is no member would end the chain itself.
      assert.deepEqual(
        await rowsOf(
          worker.database,
          `SELECT 1 AS live FROM sessions WHERE workspace = '${acme.workspace}' AND revoked_at IS NULL`,
        ),
        [],
      );
      assert.equal((await refresh(worker, paired.refreshToken)).status, 401);
      assert.equal((await refresh(worker, elsewhere.refreshToken)).status, 200);
    });

    it('does not delete a workspace through the plugin, even called in the process by its owner', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);

      await assert.rejects(
        api(worker).deleteOrganization?.({
          body: { organizationId: acme.workspace },
          headers: new Headers({ Cookie: acme.owner.cookie }),
        }) as Promise<unknown>,
        (error: unknown) => (error as { body?: { code?: unknown } }).body?.code === 'ORGANIZATION_DELETION_DISABLED',
      );

      assert.equal((await rowsOf(worker.database, 'SELECT id FROM organization')).length, 1);
    });

    it('ends every extension of an account that better-auth deletes', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const paired = await extension(worker, acme.member, acme.workspace);
      const colleague = await extension(worker, acme.guest, acme.workspace);
      const live = (subject: string) =>
        rowsOf(worker.database, `SELECT 1 AS live FROM sessions WHERE subject = '${subject}' AND revoked_at IS NULL`);
      assert.equal((await live(acme.member.id)).length, 1);

      const context = (await worker.auth.$context) as unknown as {
        internalAdapter: { deleteUser(id: string): Promise<void> };
      };
      await context.internalAdapter.deleteUser(acme.member.id);

      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM "user" WHERE id = '${acme.member.id}'`), []);
      assert.deepEqual(await live(acme.member.id), []);
      assert.equal((await refresh(worker, paired.refreshToken)).status, 401);
      assert.equal((await refresh(worker, colleague.refreshToken)).status, 200);
    });
  });
}
