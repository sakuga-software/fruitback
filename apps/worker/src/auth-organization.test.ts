import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import { KvError } from './kv.ts';
import { ROLES, type Role, can, mailboxOf } from './accounts.ts';
import { handleRequest } from './app.ts';
import { type Auth, INVITATION_SECONDS, INVITER_GONE, ROLE_REFUSED, startAuth } from './auth.ts';
import { CONSOLE_URL, MIGRATED_DATABASES, PUBLIC_URL, ask, databasesOfACase } from './auth.fixture.ts';
import { INVITATIONS_PER_INVITER, INVITATIONS_PER_WORKSPACE, handleOrganizationRoutes } from './auth-organization.ts';
import { type Call, workerOf } from './auth-worker.fixture.ts';
import { MAX_BODY_BYTES } from './bounded-body.ts';
import { MailError } from './mail.ts';
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

/** An invitation that waits, kept by the plugin for the owner of the workspace: its id. No message. */
async function invited(
  worker: Worker,
  acme: { workspace: string; owner: Person },
  email: string,
  role = 'member',
): Promise<string> {
  const invitation = await api(worker).createInvitation?.({
    body: { email, role, organizationId: acme.workspace },
    headers: new Headers({ Cookie: acme.owner.cookie }),
  });
  assert.equal(typeof invitation?.id, 'string');

  return invitation?.id as string;
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

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the routes of the organization plugin, on ${label} (FRU-149)`, { skip: skip !== false }, () => {
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
      assert.deepEqual(me.workspaces, [
        { id: workspace.id, name: 'Acme Studio', role: 'owner', logo: null, suspended: false },
      ]);

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
      const logged = mockMethod(console, 'error', (line: string) => void errors.push(line));
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
        logged.mockRestore();
      }
      assert.deepEqual(errors, ['[fruitback] better-auth did not answer: the database of a test is down']);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM organization'), []);
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
      // An invitation to cancel for each role that tries, and for the two callers who are of no role.
      const waiting = {} as Record<string, string>;
      for (const who of [...ROLES, 'nobody']) {
        waiting[who] = await invited(worker, acme, `waiting-for-${who}@client.dev`);
      }
      const calls: Record<string, (who: Person, role: Role | undefined) => Promise<Response>> = {
        '/organization/list-members': (who) => as(worker, who, `${ORG}/list-members?organizationId=${acme.workspace}`),
        '/organization/invite-member': (who, role) =>
          as(worker, who, `${ORG}/invite-member`, {
            body: {
              organizationId: acme.workspace,
              email: `invited-by-${role ?? who.cookie.length}@client.dev`,
              role: 'member',
            },
          }),
        '/organization/list-invitations': (who) =>
          as(worker, who, `${ORG}/list-invitations?organizationId=${acme.workspace}`),
        '/organization/cancel-invitation': (who, role) =>
          as(worker, who, `${ORG}/cancel-invitation`, {
            body: { organizationId: acme.workspace, invitationId: waiting[role ?? 'nobody'] },
          }),
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
      // The routes of a person name no workspace and ask no role: they have their own cases, below.
      const ofAWorkspace = Object.keys(ORGANIZATION_PATHS).filter(
        (path) => ORGANIZATION_PATHS[path]?.scope !== 'person',
      );
      assert.deepEqual(Object.keys(calls).toSorted(), ofAWorkspace.toSorted());

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
        '/organization/invite-member': { owner: 200, admin: 200, member: 403, guest: 403 },
        '/organization/list-invitations': { owner: 200, admin: 200, member: 403, guest: 403 },
        '/organization/cancel-invitation': { owner: 200, admin: 200, member: 403, guest: 403 },
        // The owner is the last one: better-auth refuses, and the three others left.
        '/organization/leave': { owner: 400, admin: 200, member: 200, guest: 200 },
      });
      // What each call did, read in the database.
      assert.equal(await roleOf(worker, pawn.member), 'member');
      assert.deepEqual(
        await rowsOf(
          worker.database,
          `SELECT email, status FROM invitation WHERE email LIKE 'waiting-for-%' ORDER BY email`,
        ),
        [
          { email: 'waiting-for-admin@client.dev', status: 'canceled' },
          { email: 'waiting-for-guest@client.dev', status: 'pending' },
          { email: 'waiting-for-member@client.dev', status: 'pending' },
          { email: 'waiting-for-nobody@client.dev', status: 'pending' },
          { email: 'waiting-for-owner@client.dev', status: 'canceled' },
        ],
      );
      assert.deepEqual(
        (
          await rowsOf(worker.database, `SELECT email FROM invitation WHERE email LIKE 'invited-by-%' ORDER BY email`)
        ).map((row) => row.email),
        ['invited-by-admin@client.dev', 'invited-by-owner@client.dev'],
      );
      assert.deepEqual(
        worker.mail.sent
          .filter((each) => each.to.startsWith('invited-by-'))
          .map((each) => each.to)
          .toSorted(),
        ['invited-by-admin@client.dev', 'invited-by-owner@client.dev'],
      );
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
      const closed = ['get-full-organization', 'get-invitation'];
      await invited(worker, acme, 'waiting@client.dev');

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
      // The invitations of the workspace are for whoever may invite: a guest is refused, and reads
      // only the invitations that their own address received, which are none.
      const waiting = await as(worker, acme.guest, `${ORG}/list-invitations?organizationId=${acme.workspace}`);
      assert.equal(waiting.status, 403);
      assert.deepEqual(await waiting.json(), { error: 'forbidden', role: 'guest' });
      const theirs = await as(worker, acme.guest, `${ORG}/list-user-invitations`);
      assert.deepEqual([theirs.status, await theirs.json()], [200, []]);
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
      assert.ok(withoutRule.length >= 12, `the plugin has only ${withoutRule.length} routes with no rule`);

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
        mailer: worker.mail,
        kv: worker.kv,
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
            body: { organizationId: acme.workspace, memberId: acme.guest.member, role: 'member' },
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
      assert.equal(await roleOf(worker, acme.guest.member), 'member');

      // The control of the control: better-auth alone reads that row as an admin, and changes a role.
      const alone = await ask(worker.auth, '/organization/update-member-role', {
        method: 'POST',
        headers: { Cookie: planted.cookie },
        body: JSON.stringify({ organizationId: acme.workspace, memberId: acme.guest.member, role: 'admin' }),
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
      const said = mockMethod(console, 'warn', () => {});
      try {
        assert.equal((await invite('guest')).role, 'guest');
      } finally {
        said.mockRestore();
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
      const fetched = mockMethod(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
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
        fetched.mockRestore();
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

    // --- The invitations (FRU-104)

    /** An invitation sent through the route, as the console sends it. */
    const invite = (worker: Worker, who: Person, workspace: string, body: Record<string, unknown>, init: Call = {}) =>
      as(worker, who, `${ORG}/invite-member`, {
        ...init,
        body: { organizationId: workspace, role: 'member', ...body },
      });
    const theirInvitations = async (worker: Worker, who: Person) =>
      (await (await as(worker, who, `${ORG}/list-user-invitations`)).json()) as Record<string, unknown>[];

    it('takes somebody from an invitation to the workspace: a message with no id, then a session of that address', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const before = worker.mail.sent.length;

      const sent = await invite(worker, acme.admin, acme.workspace, { email: ' Paul@Client.dev ' });

      assert.equal(sent.status, 200, await sent.clone().text());
      const invitation = (await sent.json()) as { id: string; email: string; role: string; status: string };
      assert.deepEqual(
        { email: invitation.email, role: invitation.role, status: invitation.status },
        { email: 'paul@client.dev', role: 'member', status: 'pending' },
      );
      assert.match(invitation.id, /^inv_[0-9a-f]{20}$/);
      // One message, to that address, that names who invites and where, and holds nothing to spend.
      assert.equal(worker.mail.sent.length, before + 1);
      const message = worker.mail.sent.at(-1);
      assert.equal(message?.to, 'paul@client.dev');
      assert.equal(message?.subject, 'You are invited to a workspace on Fruitback');
      assert.match(
        (message?.text ?? '').replaceAll('\u200B', ''),
        /admin@acme\.dev invites you to the workspace « acme » on Fruitback, as a member\./,
      );
      assert.match(message?.text ?? '', /It waits for 7 days\./);
      const links = `${message?.text}\n${message?.html}`.match(/https?:\/\/[^\s"<]+/g) ?? [];
      assert.deepEqual([...new Set(links)], [`${CONSOLE_URL}/invitations`]);
      assert.equal(`${message?.text}${message?.html}`.includes(invitation.id), false, 'the message holds the id');

      // Whoever invites sees it wait.
      const waiting = await as(worker, acme.owner, `${ORG}/list-invitations?organizationId=${acme.workspace}`);
      assert.deepEqual(
        ((await waiting.json()) as { email: string; status: string }[]).map((each) => [each.email, each.status]),
        [['paul@client.dev', 'pending']],
      );

      // Paul proves the address by signing in, and reads the invitation with the name of the workspace.
      const paul = await person(worker, 'paul@client.dev');
      const theirs = await theirInvitations(worker, paul);
      assert.deepEqual(
        theirs.map((each) => [each.id, each.organizationName, each.role]),
        [[invitation.id, 'acme', 'member']],
      );
      assert.deepEqual(
        ((await (await as(worker, paul, '/console/me')).json()) as { workspaces: unknown[] }).workspaces,
        [],
      );

      const joined = await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: invitation.id } });

      assert.equal(joined.status, 200, await joined.clone().text());
      assert.deepEqual(await rowsOf(worker.database, `SELECT role FROM member WHERE "userId" = '${paul.id}'`), [
        { role: 'member' },
      ]);
      const me = (await (await as(worker, paul, '/console/me')).json()) as { workspaces: unknown[] };
      assert.deepEqual(me.workspaces, [
        { id: acme.workspace, name: 'acme', role: 'member', logo: null, suspended: false },
      ]);
      assert.equal((await as(worker, paul, `/console/workspaces/${acme.workspace}/sites`)).status, 200);
      // Spent: it is no longer theirs to read, and a second acceptance is refused.
      assert.deepEqual(await theirInvitations(worker, paul), []);
      assert.equal(
        (await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: invitation.id } })).status,
        400,
      );
      assert.equal((await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`)).length, 1);
    });

    it('gives an invitation to the address it names, and to no other session', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const id = await invited(worker, acme, 'paul@client.dev', 'admin');
      const stranger = await person(worker, 'stranger@elsewhere.dev');

      // Nobody but Paul reads it, accepts it or declines it: an id alone opens nothing.
      for (const who of [stranger, acme.guest, acme.member, other.owner]) {
        assert.deepEqual(await theirInvitations(worker, who), [], who.email);
        for (const route of ['accept-invitation', 'reject-invitation']) {
          const answer = await as(worker, who, `${ORG}/${route}`, { body: { invitationId: id } });
          assert.equal(answer.status, 403, `${route} by ${who.email}`);
          assert.equal(
            ((await answer.json()) as { code?: string }).code,
            'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
          );
        }
      }
      // With no session, nobody; and a call that changes something comes from the console.
      for (const route of ['list-user-invitations', 'accept-invitation', 'reject-invitation']) {
        const body = route === 'list-user-invitations' ? undefined : { invitationId: id };
        const nobody = await worker.call(`${ORG}/${route}`, body === undefined ? {} : { body });
        assert.equal(nobody.status, 401, route);
      }
      const paul = await person(worker, 'paul@client.dev');
      for (const origin of [null, 'https://demo.fruitback.test']) {
        const answer = await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id }, origin });
        assert.equal(answer.status, 403, `origin ${origin}`);
      }
      // A route of the person takes no other field: not an address to read the invitations of.
      const asked = await as(worker, stranger, `${ORG}/list-user-invitations?email=paul@client.dev`);
      assert.deepEqual([asked.status, await asked.json()], [400, { error: 'invalid-request', field: 'email' }]);
      const named = await as(worker, paul, `${ORG}/accept-invitation`, {
        body: { invitationId: id, organizationId: other.workspace },
      });
      assert.deepEqual(
        [named.status, await named.json()],
        [400, { error: 'invalid-request', field: 'organizationId' }],
      );
      assert.deepEqual(await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`), [
        { status: 'pending' },
      ]);
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`), []);

      // The control: Paul declines it, and it is over for everybody.
      const declined = await as(worker, paul, `${ORG}/reject-invitation`, { body: { invitationId: id } });
      assert.equal(declined.status, 200);
      assert.deepEqual(await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`), [
        { status: 'rejected' },
      ]);
      assert.equal((await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id } })).status, 400);
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`), []);
    });

    it('invites as an admin, a member or a guest only, and nobody who is a member already', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const before = worker.mail.sent.length;

      // Not an owner, and never two roles. A guest names its sites: see « the guest of one site ».
      for (const role of ['owner', 'guest,admin', ['member', 'admin'], 'superuser', '']) {
        const answer = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', role });
        assert.deepEqual(
          [answer.status, await answer.json()],
          [400, { error: 'invalid-request', field: 'role' }],
          JSON.stringify(role),
        );
      }
      for (const email of ['not-an-address', '', 42]) {
        const answer = await invite(worker, acme.owner, acme.workspace, { email });
        assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-request', field: 'email' }]);
      }
      const member = await invite(worker, acme.owner, acme.workspace, { email: 'guest@acme.dev' });
      assert.equal(member.status, 400);
      assert.equal(((await member.json()) as { code?: string }).code, 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION');
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM invitation'), []);
      assert.equal(worker.mail.sent.length, before);

      // The control: the same call with a role that may be invited keeps an invitation.
      assert.equal(
        (await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', role: 'admin' })).status,
        200,
      );
      assert.deepEqual(await rowsOf(worker.database, 'SELECT email, role FROM invitation'), [
        { email: 'paul@client.dev', role: 'admin' },
      ]);
    });

    it('refuses an invitation whose row holds two roles, when it is accepted', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const id = await invited(worker, acme, 'paul@client.dev');
      const control = await invited(worker, acme, 'lea@client.dev');
      const paul = await person(worker, 'paul@client.dev');
      const lea = await person(worker, 'lea@client.dev');
      // A row that no route writes: a hand, or a later version of the plugin.
      await rowsOf(worker.database, `UPDATE invitation SET role = 'guest,admin' WHERE id = '${id}'`);

      const answer = await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id } });

      assert.equal(answer.status, 400);
      assert.equal(((await answer.json()) as { code?: string }).code, ROLE_REFUSED);
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`), []);
      // The control: the invitation beside it, with one role, is accepted.
      assert.equal(
        (await as(worker, lea, `${ORG}/accept-invitation`, { body: { invitationId: control } })).status,
        200,
      );
    });

    it('cancels an invitation of the workspace the call names, and of no other', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const theirs = await invited(worker, other, 'paul@client.dev');
      const ours = await invited(worker, acme, 'paul@client.dev');
      const statusOf = async (id: string) =>
        (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status;
      const cancel = (who: Person, workspace: string, invitationId: string) =>
        as(worker, who, `${ORG}/cancel-invitation`, { body: { organizationId: workspace, invitationId } });

      // An admin of acme names their own workspace and the invitation of another one.
      const across = await cancel(acme.admin, acme.workspace, theirs);
      assert.deepEqual([across.status, await across.json()], [404, { error: 'not-found' }]);
      assert.equal((await cancel(acme.admin, other.workspace, theirs)).status, 404);
      assert.equal((await cancel(acme.admin, acme.workspace, 'inv_00000000000000000000')).status, 404);
      assert.equal(await statusOf(theirs), 'pending');

      assert.equal((await cancel(acme.admin, acme.workspace, ours)).status, 200);
      assert.equal(await statusOf(ours), 'canceled');
      // Paul no longer reads it, and cannot accept it; the one of the other workspace still waits.
      const paul = await person(worker, 'paul@client.dev');
      assert.deepEqual(
        (await theirInvitations(worker, paul)).map((each) => each.id),
        [theirs],
      );
      assert.equal((await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: ours } })).status, 400);
    });

    it('writes no text of a person in the subject, and makes no link of a name in the body (FRU-209)', async () => {
      const worker = await workerOn(open);
      const owner = await person(worker, 'owner@acme.dev');
      const name = 'Your invoice is ready: https://evil.example/pay now www.evil.example';
      const made = await as(worker, owner, '/console/workspaces', { body: { name } });
      assert.equal(made.status, 201, await made.clone().text());
      const workspace = ((await made.json()) as { id: string }).id;

      for (const [email, locale, subject] of [
        ['paul@client.dev', 'en', 'You are invited to a workspace on Fruitback'],
        ['lea@client.dev', 'fr', 'Vous êtes invité dans un espace de travail sur Fruitback'],
      ] as const) {
        if (locale === 'fr') await worker.accounts.setLocale(owner.id, 'fr');
        assert.equal((await invite(worker, owner, workspace, { email })).status, 200);
        const message = worker.mail.sent.at(-1);
        assert.equal(message?.subject, subject);
        // The name is in the body, for whoever reads it, and nothing of it is an address to a client.
        for (const body of [message?.text ?? '', message?.html ?? '']) {
          assert.ok(body.replaceAll('\u200B', '').includes(name), body);
          assert.deepEqual([...new Set(body.match(/https?:\/\/[^\s"<]+/g) ?? [])], [`${CONSOLE_URL}/invitations`]);
          assert.doesNotMatch(body, /www\.evil|evil\.example|owner@acme\.dev/);
        }
      }
    });

    // FRU-67. The counts are in the database of a worker that has one, and can stop answering after
    // better-auth kept the invitation. A `503` there said that nothing was done.
    it('keeps the invitation, sends no message and says so, when the counts do not answer', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const before = worker.mail.sent.length;
      const down = async (): Promise<never> => {
        throw new KvError('the Kv of the database did not answer');
      };
      const { get, incr } = worker.kv;
      worker.kv.get = (key) => (key.startsWith('fruitback:invitation') ? down() : get.call(worker.kv, key));
      worker.kv.incr = (key, ttlMs, by) =>
        key.startsWith('fruitback:invitation') ? down() : incr.call(worker.kv, key, ttlMs, by);
      const logged = mockMethod(console, 'error', () => {});

      try {
        const answer = await invite(worker, acme.owner, acme.workspace, { email: 'late@client.dev' });

        assert.equal(answer.status, 200, await answer.clone().text());
        assert.equal(((await answer.json()) as { mailed: boolean }).mailed, false);
        assert.equal(worker.mail.sent.length, before, 'a message went out that no count held');
        assert.equal(
          (await rowsOf(worker.database, `SELECT id FROM invitation WHERE email = 'late@client.dev'`)).length,
          1,
        );
        assert.match(String(logged.mock.calls.at(-1)?.[0]), /no message was sent/);
      } finally {
        logged.mockRestore();
      }
    });

    it('says after a reload whether the message of an invitation left, to whoever invites and to nobody else (FRU-269)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      // The window of this address in this workspace is full: the invitation is kept, no message goes.
      await worker.kv.set(`fruitback:invitation:${acme.workspace}:held@client.dev`, '3', 60_000);
      const held = await invite(worker, acme.owner, acme.workspace, { email: 'held@client.dev' });
      assert.equal(((await held.json()) as { mailed: boolean }).mailed, false);
      const sent = await invite(worker, acme.owner, acme.workspace, { email: 'sent@client.dev' });
      assert.equal(((await sent.json()) as { mailed: boolean }).mailed, true);

      const listed = async (who: Person) => {
        const answer = await as(worker, who, `${ORG}/list-invitations?organizationId=${acme.workspace}`);

        return [answer.status, answer.ok ? await answer.json() : undefined] as const;
      };
      const mailedOf = (rows: unknown) =>
        Object.fromEntries((rows as { email: string; mailed?: unknown }[]).map((each) => [each.email, each.mailed]));
      // Role by role: the list, with `mailed`, is for whoever invites.
      for (const who of [acme.owner, acme.admin]) {
        const [status, rows] = await listed(who);
        assert.equal(status, 200, who.email);
        assert.deepEqual(mailedOf(rows), { 'held@client.dev': false, 'sent@client.dev': true }, who.email);
      }
      for (const who of [acme.member, acme.guest]) assert.equal((await listed(who))[0], 403, who.email);

      // The window opens again: « Resend » sends, and the invitation reads as sent.
      await worker.kv.set(`fruitback:invitation:${acme.workspace}:held@client.dev`, '0', 60_000);
      const again = await invite(worker, acme.owner, acme.workspace, { email: 'held@client.dev', resend: true });
      assert.equal(((await again.json()) as { mailed: boolean }).mailed, true);
      // A « Resend » that sends nothing does not take back a message that left.
      await worker.kv.set(`fruitback:invitation:${acme.workspace}:held@client.dev`, '3', 60_000);
      const late = await invite(worker, acme.owner, acme.workspace, { email: 'held@client.dev', resend: true });
      assert.equal(((await late.json()) as { mailed: boolean }).mailed, false);
      assert.deepEqual(mailedOf((await listed(acme.owner))[1]), { 'held@client.dev': true, 'sent@client.dev': true });
    });

    it('sends no more messages than one account may in an hour, in every workspace together, and keeps the invitations (FRU-209)', async () => {
      const worker = await workerOn(open);
      const owner = await person(worker, 'solo@many.dev');
      const workspaces: string[] = [];
      for (const name of ['one', 'two', 'three']) {
        const made = await as(worker, owner, '/console/workspaces', { body: { name } });
        workspaces.push(((await made.json()) as { id: string }).id);
      }
      const before = worker.mail.sent.length;
      const mailed: boolean[] = [];
      for (let n = 0; n < INVITATIONS_PER_INVITER + 2; n += 1) {
        const answer = await invite(worker, owner, workspaces[n % 3] as string, { email: `person${n}@client.dev` });
        assert.equal(answer.status, 200, await answer.clone().text());
        mailed.push(((await answer.json()) as { mailed: boolean }).mailed);
      }

      assert.deepEqual(mailed, [...Array(INVITATIONS_PER_INVITER).fill(true), false, false]);
      assert.equal(worker.mail.sent.length - before, INVITATIONS_PER_INVITER);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM invitation')).length, INVITATIONS_PER_INVITER + 2);
      // Another account is not held by it.
      const acme = await team(worker);
      const other = await invite(worker, acme.owner, acme.workspace, { email: 'person0@client.dev' });
      assert.equal(((await other.json()) as { mailed: boolean }).mailed, true);
    });

    it('sends no more messages than one workspace may in an hour, whoever invites (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const third = await added(worker, acme.workspace, await person(worker, 'third@acme.dev'), 'admin');
      const before = worker.mail.sent.length;
      const mailed: boolean[] = [];
      const inviters = [acme.owner, acme.admin, third];
      for (let n = 0; n < INVITATIONS_PER_WORKSPACE + 1; n += 1) {
        const who = inviters[Math.floor(n / INVITATIONS_PER_INVITER)] as Person;
        const answer = await invite(worker, who, acme.workspace, { email: `person${n}@client.dev` });
        assert.equal(answer.status, 200, await answer.clone().text());
        mailed.push(((await answer.json()) as { mailed: boolean }).mailed);
      }

      // Nobody is over their own count: the workspace is.
      assert.deepEqual(mailed, [...Array(INVITATIONS_PER_WORKSPACE).fill(true), false]);
      assert.equal(worker.mail.sent.length - before, INVITATIONS_PER_WORKSPACE);

      // A workspace that is full spends nothing of who tries: the third admin tried once above, and
      // still sends their twenty from another workspace.
      const other = await team(worker, 'globex');
      await added(worker, other.workspace, third, 'admin');
      const elsewhere: boolean[] = [];
      for (let n = 0; n < INVITATIONS_PER_INVITER; n += 1) {
        const answer = await invite(worker, third, other.workspace, { email: `other${n}@client.dev` });
        elsewhere.push(((await answer.json()) as { mailed: boolean }).mailed);
      }
      assert.deepEqual(elsewhere, Array(INVITATIONS_PER_INVITER).fill(true));
    });

    it('keeps the window of an address to its workspace: another workspace neither closes it nor learns of it (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const toBob = () => worker.mail.sent.filter((each) => each.to === 'bob@corp.example').length;

      // Somebody else spends three messages on the address, from a workspace of their own.
      assert.equal((await invite(worker, other.owner, other.workspace, { email: 'bob@corp.example' })).status, 200);
      for (let n = 0; n < 3; n += 1) {
        await invite(worker, other.owner, other.workspace, { email: 'bob@corp.example', resend: true });
      }
      assert.equal(toBob(), 3);

      // The workspace that does invite Bob is not refused, its invitation exists, and its message goes.
      const ours = await invite(worker, acme.owner, acme.workspace, { email: 'bob@corp.example' });
      assert.equal(ours.status, 200, await ours.clone().text());
      assert.equal(((await ours.json()) as { mailed?: boolean }).mailed, true);
      assert.equal(toBob(), 4);
      assert.equal(
        (
          await rowsOf(
            worker.database,
            `SELECT id FROM invitation WHERE email = 'bob@corp.example' AND "organizationId" = '${acme.workspace}'`,
          )
        ).length,
        1,
      );
    });

    it('sends three messages and no more for calls at the same moment, and keeps one invitation', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const toPaul = () => worker.mail.sent.filter((each) => each.to === 'paul@client.dev').length;
      assert.equal((await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev' })).status, 200);
      assert.equal(toPaul(), 1);

      // Twelve « Resend » at once, by two people. The count is taken after better-auth answers, so
      // every call is past the plugin before any of them counts.
      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          invite(worker, n % 2 === 0 ? acme.owner : acme.admin, acme.workspace, {
            email: 'paul@client.dev',
            resend: true,
          }),
        ),
      );
      const mailed = await Promise.all(
        answers.map(async (answer) => {
          assert.equal(answer.status, 200, await answer.clone().text());

          return ((await answer.json()) as { mailed: boolean }).mailed;
        }),
      );

      assert.equal(toPaul(), 3);
      assert.equal(mailed.filter(Boolean).length, 2);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM invitation')).length, 1);
    });

    it('sends an invitation again when asked to, and no more than three messages to one address in the window', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const toPaul = () => worker.mail.sent.filter((each) => each.to === 'paul@client.dev').length;

      assert.equal((await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev' })).status, 200);
      const [first] = await rowsOf(worker.database, 'SELECT id, "expiresAt" FROM invitation');
      // A second invitation of the same address is refused while the first waits, and sends nothing.
      const again = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev' });
      assert.equal(again.status, 400);
      assert.equal(((await again.json()) as { code?: string }).code, 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION');
      assert.equal(toPaul(), 1);
      for (const resend of [false, 'true', 1]) {
        const answer = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend });
        assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-request', field: 'resend' }]);
      }

      const resent = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend: true });
      assert.equal(resent.status, 200, await resent.clone().text());
      assert.equal(toPaul(), 2);
      const [after] = await rowsOf(worker.database, 'SELECT id, "expiresAt" FROM invitation');
      assert.equal(after?.id, first?.id, 'a second invitation was written');
      assert.ok(new Date(String(after?.expiresAt)) >= new Date(String(first?.expiresAt)));

      // The four calls that were refused above counted nothing: the window counts the messages that
      // went. A third one goes. The fourth is kept and sends nothing, and says so: no refusal.
      const third = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend: true });
      assert.equal(third.status, 200);
      assert.equal(((await third.json()) as { mailed?: boolean }).mailed, true);
      assert.equal(toPaul(), 3);
      const fourth = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend: true });
      assert.equal(fourth.status, 200);
      assert.deepEqual(
        (({ id, mailed }) => ({ id, mailed }))((await fourth.json()) as { id: string; mailed: boolean }),
        { id: first?.id, mailed: false },
      );
      assert.equal(toPaul(), 3);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM invitation')).length, 1);

      // Two calls at the same moment: the count is taken in one step, and the one that comes back
      // over the limit sends nothing. Its invitation is kept.
      const racing = {
        auth: worker.auth,
        accounts: worker.accounts,
        sessions: worker.sessions,
        mailer: worker.mail,
        kv: { ...worker.kv, get: async () => '2', incr: async () => 4 },
        consoleUrl: CONSOLE_URL,
        clientIp: '198.51.100.7',
        trackIp: false,
      };
      const lost = await handleOrganizationRoutes(
        new Request(`${PUBLIC_URL}${ORG}/invite-member`, {
          method: 'POST',
          headers: { Cookie: acme.owner.cookie, Origin: CONSOLE_URL, 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: acme.workspace, email: 'max@client.dev', role: 'member' }),
        }),
        `${ORG}/invite-member`,
        racing,
        {},
      );
      assert.ok(lost !== undefined);
      assert.equal(lost.status, 200);
      assert.equal(((await lost.json()) as { mailed?: boolean }).mailed, false);
      assert.equal(worker.mail.sent.filter((each) => each.to === 'max@client.dev').length, 0);
      assert.equal(
        (await rowsOf(worker.database, `SELECT id FROM invitation WHERE email = 'max@client.dev'`)).length,
        1,
      );
      // Another address is not held by it.
      assert.equal((await invite(worker, other.owner, other.workspace, { email: 'lea@client.dev' })).status, 200);
    });

    it('sends no message, and counts none, for an answer of better-auth that names no invitation', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const before = worker.mail.sent.length;
      // better-auth as a later version could answer: `200`, and nothing kept.
      const hollow = {
        ...worker.auth,
        $context: worker.auth.$context,
        api: worker.auth.api,
        handler: async () => Response.json({}),
      } as unknown as Auth;
      const context = {
        auth: hollow,
        accounts: worker.accounts,
        sessions: worker.sessions,
        mailer: worker.mail,
        kv: worker.kv,
        consoleUrl: CONSOLE_URL,
        clientIp: '198.51.100.7',
        trackIp: false,
      };
      const asked = new Request(`${PUBLIC_URL}${ORG}/invite-member`, {
        method: 'POST',
        headers: { Cookie: acme.owner.cookie, Origin: CONSOLE_URL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: acme.workspace, email: 'paul@client.dev', role: 'member' }),
      });

      await assert.rejects(handleOrganizationRoutes(asked, `${ORG}/invite-member`, context, {}), /no id/);

      assert.equal(worker.mail.sent.length, before);
      assert.equal(await worker.kv.get('fruitback:invitation:paul@client.dev'), undefined);
    });

    it('cancels the invitations of an admin who is removed, demoted, or leaves, so nobody joins on their word (FRU-209)', async () => {
      for (const how of ['removed', 'demoted', 'left'] as const) {
        const worker = await workerOn(open);
        const acme = await team(worker);
        const made = await as(worker, acme.admin, `${ORG}/invite-member`, {
          body: { organizationId: acme.workspace, email: 'second@elsewhere.dev', role: 'admin' },
        });
        assert.equal(made.status, 200, await made.clone().text());
        const { id } = (await made.json()) as { id: string };
        // The control: an invitation of the owner, and one the same admin made in another workspace.
        const kept = await invited(worker, acme, 'kept@elsewhere.dev');
        const other = await team(worker, 'globex');
        await added(worker, other.workspace, acme.admin, 'admin');
        const elsewhere = await as(worker, acme.admin, `${ORG}/invite-member`, {
          body: { organizationId: other.workspace, email: 'second@elsewhere.dev', role: 'member' },
        });
        assert.equal(elsewhere.status, 200, await elsewhere.clone().text());

        const calls = {
          removed: () =>
            as(worker, acme.owner, `${ORG}/remove-member`, {
              body: { organizationId: acme.workspace, memberIdOrEmail: acme.admin.member },
            }),
          demoted: () =>
            as(worker, acme.owner, `${ORG}/update-member-role`, {
              body: { organizationId: acme.workspace, memberId: acme.admin.member, role: 'member' },
            }),
          left: () => as(worker, acme.admin, `${ORG}/leave`, { body: { organizationId: acme.workspace } }),
        };
        const done = await calls[how]();
        assert.equal(done.status, 200, `${how}: ${await done.clone().text()}`);

        const statuses = Object.fromEntries(
          (await rowsOf(worker.database, 'SELECT id, status FROM invitation')).map((row) => [row.id, row.status]),
        );
        assert.equal(statuses[id], 'canceled', how);
        assert.equal(statuses[kept], 'pending', how);
        assert.equal(statuses[((await elsewhere.json()) as { id: string }).id], 'pending', how);
        const second = await person(worker, 'second@elsewhere.dev');
        const accepted = await as(worker, second, `${ORG}/accept-invitation`, { body: { invitationId: id } });
        assert.equal(accepted.status, 400, how);
        assert.equal(
          (await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${second.id}'`)).length,
          0,
          how,
        );
      }
    });

    it('cancels the invitations of somebody who leaves when the end of their extensions fails, and says the failure (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const made = await as(worker, acme.admin, `${ORG}/invite-member`, {
        body: { organizationId: acme.workspace, email: 'second@elsewhere.dev', role: 'admin' },
      });
      const { id } = (await made.json()) as { id: string };
      const failing = {
        auth: worker.auth,
        accounts: worker.accounts,
        sessions: {
          ...worker.sessions,
          endSessionsOf: async () => {
            throw new Error('the sessions of a test do not answer');
          },
        },
        mailer: worker.mail,
        kv: worker.kv,
        consoleUrl: CONSOLE_URL,
        clientIp: '198.51.100.7',
        trackIp: false,
      };

      await assert.rejects(
        handleOrganizationRoutes(
          new Request(`${PUBLIC_URL}${ORG}/leave`, {
            method: 'POST',
            headers: { Cookie: acme.admin.cookie, Origin: CONSOLE_URL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: acme.workspace }),
          }),
          `${ORG}/leave`,
          failing,
          {},
        ),
        /the sessions of a test do not answer/,
      );
      assert.equal(
        (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status,
        'canceled',
      );
    });

    it('keeps the invitations of an admin who becomes owner, and of one whose role does not change (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const made = await as(worker, acme.admin, `${ORG}/invite-member`, {
        body: { organizationId: acme.workspace, email: 'second@elsewhere.dev', role: 'member' },
      });
      const { id } = (await made.json()) as { id: string };
      for (const role of ['admin', 'owner']) {
        const changed = await as(worker, acme.owner, `${ORG}/update-member-role`, {
          body: { organizationId: acme.workspace, memberId: acme.admin.member, role },
        });
        assert.equal(changed.status, 200, await changed.clone().text());
      }

      const second = await person(worker, 'second@elsewhere.dev');
      const accepted = await as(worker, second, `${ORG}/accept-invitation`, { body: { invitationId: id } });
      assert.equal(accepted.status, 200, await accepted.clone().text());
    });

    it('refuses at the acceptance an invitation whose inviter no longer invites, when no cancellation ran (FRU-209)', async () => {
      for (const how of ['no member row', 'a member row under manage-members'] as const) {
        const worker = await workerOn(open);
        const acme = await team(worker);
        const made = await as(worker, acme.admin, `${ORG}/invite-member`, {
          body: { organizationId: acme.workspace, email: 'second@elsewhere.dev', role: 'admin' },
        });
        const { id } = (await made.json()) as { id: string };
        // Written under the plugin, as a hook that failed after the write would leave it.
        await rowsOf(
          worker.database,
          how === 'no member row'
            ? `DELETE FROM member WHERE id = '${acme.admin.member}'`
            : `UPDATE member SET role = 'member' WHERE id = '${acme.admin.member}'`,
        );
        assert.equal(
          (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status,
          'pending',
        );

        const second = await person(worker, 'second@elsewhere.dev');
        const accepted = await as(worker, second, `${ORG}/accept-invitation`, { body: { invitationId: id } });
        assert.equal(accepted.status, 400, how);
        assert.equal(((await accepted.json()) as { code?: string }).code, INVITER_GONE, how);
        assert.equal(
          (await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${second.id}'`)).length,
          0,
          how,
        );
      }
    });

    /** `endSessionsOf` of this worker fails while `failing.now` is true, and counts its real calls. */
    function sessionsThatFail(worker: Worker) {
      const real = worker.sessions.endSessionsOf.bind(worker.sessions);
      const failing = { now: true, ended: 0 };
      (worker.sessions as { endSessionsOf: unknown }).endSessionsOf = async (...args: Parameters<typeof real>) => {
        if (failing.now) throw new Error('the sessions of a test do not answer');
        failing.ended += 1;

        return real(...args);
      };

      return failing;
    }

    it('removes nobody when the end of their extensions fails, answers 502, and removes them at the next call (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const paired = await extension(worker, acme.member, acme.workspace);
      const failing = sessionsThatFail(worker);
      const remove = () =>
        as(worker, acme.owner, `${ORG}/remove-member`, {
          body: { organizationId: acme.workspace, memberIdOrEmail: acme.member.member },
        });

      const refused = await remove();
      assert.deepEqual([refused.status, await refused.json()], [502, { error: 'auth-unavailable' }]);
      // Nothing was written: the member is there, and their extension goes on.
      assert.equal(await roleOf(worker, acme.member.member), 'member');
      assert.equal((await sitesOf(worker, paired.accessToken)).status, 200);

      failing.now = false;
      assert.equal((await remove()).status, 200);
      assert.equal(await roleOf(worker, acme.member.member), undefined);
      assert.equal((await refresh(worker, paired.refreshToken)).status, 401);
    });

    it('removes an admin and cancels their invitations when the second end of their extensions fails (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const made = await invite(worker, acme.admin, acme.workspace, { email: 'second@elsewhere.dev' });
      const { id } = (await made.json()) as { id: string };
      const paired = await extension(worker, acme.admin, acme.workspace);
      // The first pass, before the member is deleted, answers; the one after does not.
      const failing = sessionsThatFail(worker);
      failing.now = false;
      const real = worker.sessions.endSessionsOf.bind(worker.sessions);
      (worker.sessions as { endSessionsOf: unknown }).endSessionsOf = async (...args: Parameters<typeof real>) => {
        const answered = await real(...args);
        failing.now = true;

        return answered;
      };

      const removed = await as(worker, acme.owner, `${ORG}/remove-member`, {
        body: { organizationId: acme.workspace, memberIdOrEmail: acme.admin.member },
      });

      assert.equal(removed.status, 200, await removed.clone().text());
      assert.equal(failing.now, true, 'the second pass was not played');
      assert.equal(
        (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status,
        'canceled',
      );
      assert.equal((await refresh(worker, paired.refreshToken)).status, 401);
    });

    it('finishes what follows a departure when somebody who left asks again (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const made = await invite(worker, acme.admin, acme.workspace, { email: 'second@elsewhere.dev' });
      const { id } = (await made.json()) as { id: string };
      const failing = sessionsThatFail(worker);
      const leave = () => as(worker, acme.admin, `${ORG}/leave`, { body: { organizationId: acme.workspace } });

      const first = await leave();
      assert.deepEqual([first.status, await first.json()], [502, { error: 'auth-unavailable' }]);
      assert.equal(await roleOf(worker, acme.admin.member), undefined, 'better-auth wrote the departure');
      assert.equal(failing.ended, 0);

      failing.now = false;
      assert.equal((await leave()).status, 404);
      assert.equal(failing.ended, 1);
      assert.equal(
        (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status,
        'canceled',
      );
    });

    it('keeps one owner when two owners go at the same moment (FRU-209)', async () => {
      for (const how of ['demote', 'leave', 'remove'] as const) {
        const worker = await workerOn(open);
        const acme = await team(worker);
        const promoted = await as(worker, acme.owner, `${ORG}/update-member-role`, {
          body: { organizationId: acme.workspace, memberId: acme.admin.member, role: 'owner' },
        });
        assert.equal(promoted.status, 200, await promoted.clone().text());
        const go = (who: Person, other: Person) => {
          if (how === 'leave') return as(worker, who, `${ORG}/leave`, { body: { organizationId: acme.workspace } });
          if (how === 'remove') {
            return as(worker, who, `${ORG}/remove-member`, {
              body: { organizationId: acme.workspace, memberIdOrEmail: other.member },
            });
          }

          return as(worker, who, `${ORG}/update-member-role`, {
            body: { organizationId: acme.workspace, memberId: who.member, role: 'admin' },
          });
        };

        const answers = await Promise.all([go(acme.owner, acme.admin), go(acme.admin, acme.owner)]);

        const owners = await rowsOf(
          worker.database,
          `SELECT id FROM member WHERE "organizationId" = '${acme.workspace}' AND role = 'owner'`,
        );
        assert.equal(owners.length, 1, `${how}: ${answers.map((answer) => answer.status).join(' ')}`);
        assert.equal(answers.filter((answer) => answer.status === 200).length, 1, how);
      }
    });

    it('writes one invitation for one address when two people invite it at the same moment', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);

      const answers = await Promise.all(
        [acme.owner, acme.admin, acme.owner, acme.admin].map((who) =>
          invite(worker, who, acme.workspace, { email: 'max@client.dev' }),
        ),
      );
      const waiting = await rowsOf(worker.database, `SELECT id FROM invitation WHERE status = 'pending'`);

      assert.deepEqual(
        { ok: answers.filter((answer) => answer.status === 200).length, waiting: waiting.length },
        { ok: 1, waiting: 1 },
      );
      assert.equal(worker.mail.sent.filter((each) => each.to === 'max@client.dev').length, 1);
    });

    it('refuses to cancel an invitation that was accepted, and the person stays a member (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const id = await invited(worker, acme, 'paul@client.dev');
      const paul = await person(worker, 'paul@client.dev');
      assert.equal((await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id } })).status, 200);

      const cancelled = await as(worker, acme.owner, `${ORG}/cancel-invitation`, {
        body: { organizationId: acme.workspace, invitationId: id },
      });

      assert.equal(cancelled.status, 400);
      assert.equal(((await cancelled.json()) as { code?: string }).code, 'INVITATION_NOT_FOUND');
      assert.equal(
        (await rowsOf(worker.database, `SELECT status FROM invitation WHERE id = '${id}'`))[0]?.status,
        'accepted',
      );
      // The control: one that waits is cancelled.
      const waits = await invited(worker, acme, 'lea@client.dev');
      const done = await as(worker, acme.owner, `${ORG}/cancel-invitation`, {
        body: { organizationId: acme.workspace, invitationId: waits },
      });
      assert.equal(done.status, 200);
    });

    it('lists no invitation past its end, to whoever invites and to the person it names (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const other = await team(worker, 'globex');
      const ended = await invited(worker, acme, 'paul@client.dev');
      const waits = await invited(worker, other, 'paul@client.dev');
      const paul = await person(worker, 'paul@client.dev');
      const listed = async () => ({
        ofAcme: (
          (await (await as(worker, acme.owner, `${ORG}/list-invitations?organizationId=${acme.workspace}`)).json()) as {
            id: string;
          }[]
        ).map((each) => each.id),
        ofPaul: (await theirInvitations(worker, paul)).map((each) => each.id),
      });
      assert.deepEqual(await listed(), { ofAcme: [ended], ofPaul: [ended, waits] });

      await rowsOf(
        worker.database,
        `UPDATE invitation SET "expiresAt" = now() - interval '1 minute' WHERE id = '${ended}'`,
      );

      assert.deepEqual(await listed(), { ofAcme: [], ofPaul: [waits] });
    });

    it('refuses a « Resend » that names another role than the invitation that waits, and sends nothing (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      assert.equal((await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev' })).status, 200);
      const before = worker.mail.sent.length;

      const other = await invite(worker, acme.owner, acme.workspace, {
        email: 'paul@client.dev',
        role: 'admin',
        resend: true,
      });

      assert.deepEqual([other.status, await other.json()], [400, { error: 'invalid-request', field: 'role' }]);
      assert.equal(worker.mail.sent.length, before);
      // The control: with the role of the invitation, it goes.
      const same = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend: true });
      assert.equal(same.status, 200);
      assert.match(worker.mail.sent.at(-1)?.text ?? '', /as a member\./);
    });

    it('makes no guest by a change of role, as by an invitation (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);

      const answer = await as(worker, acme.owner, `${ORG}/update-member-role`, {
        body: { organizationId: acme.workspace, memberId: acme.member.member, role: 'guest' },
      });

      assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-request', field: 'role' }]);
      assert.equal(await roleOf(worker, acme.member.member), 'member');
    });

    it('takes an invitation from a session whose address is verified, and from no other (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const id = await invited(worker, acme, 'paul@client.dev');
      const paul = await person(worker, 'paul@client.dev');
      // No route of the worker makes an account whose address is not verified: the row is written.
      await rowsOf(worker.database, `UPDATE "user" SET "emailVerified" = false WHERE id = '${paul.id}'`);

      for (const route of ['accept-invitation', 'reject-invitation']) {
        const answer = await as(worker, paul, `${ORG}/${route}`, { body: { invitationId: id } });
        assert.equal(answer.status, 403, route);
        assert.equal(
          ((await answer.json()) as { code?: string }).code,
          'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
          route,
        );
      }
      assert.equal((await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`)).length, 0);

      // The control: the same person, verified.
      await rowsOf(worker.database, `UPDATE "user" SET "emailVerified" = true WHERE id = '${paul.id}'`);
      assert.equal((await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id } })).status, 200);
    });

    it('counts the window of an address by its mailbox: a suffix after « + » opens no other (FRU-209)', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const toCarol = () => worker.mail.sent.filter((each) => each.to.startsWith('carol+')).length;

      const mailed: boolean[] = [];
      for (let n = 0; n < 6; n += 1) {
        const answer = await invite(worker, acme.owner, acme.workspace, { email: `carol+${n}@client.dev` });
        assert.equal(answer.status, 200, await answer.clone().text());
        mailed.push(((await answer.json()) as { mailed: boolean }).mailed);
      }

      assert.deepEqual(mailed, [true, true, true, false, false, false]);
      assert.equal(toCarol(), 3);
      // Each invitation is kept for the address as it was written.
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM invitation')).length, 6);
      assert.deepEqual(
        ['carol@client.dev', 'carol+a+b@client.dev', '+carol@client.dev', 'carol@cli+ent.dev'].map(mailboxOf),
        ['carol@client.dev', 'carol@client.dev', '+carol@client.dev', 'carol@cli+ent.dev'],
      );
    });

    it('answers 502 when the message does not leave, keeps the invitation, and sends it again', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const said = mockMethod(console, 'error', () => {});
      const refused = mockMethod(worker.mail, 'send', async () => {
        throw new MailError('The mail provider refused the message: 503');
      });
      try {
        const answer = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev' });
        assert.deepEqual([answer.status, await answer.json()], [502, { error: 'mail-unavailable' }]);
        assert.deepEqual(
          said.mock.calls.map((each) => each[0]),
          ['[fruitback] The mail provider refused the message: 503'],
        );
      } finally {
        refused.mockRestore();
        said.mockRestore();
      }
      assert.deepEqual(await rowsOf(worker.database, 'SELECT email, status FROM invitation'), [
        { email: 'paul@client.dev', status: 'pending' },
      ]);

      const resent = await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', resend: true });
      assert.equal(resent.status, 200);
      assert.equal(worker.mail.sent.at(-1)?.to, 'paul@client.dev');
    });

    it('keeps an invitation on a worker that sends no mail, and sends nothing, so the link goes by hand', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const ask = (path: string, body?: unknown) =>
        handleRequest(
          new Request(`${PUBLIC_URL}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Origin: CONSOLE_URL, Cookie: acme.owner.cookie, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          worker.env,
          {
            clientIp: '198.51.100.11',
            accounts: worker.accounts,
            sessionStore: worker.sessions,
            kv: worker.kv,
            auth: worker.auth,
          },
        );
      const before = worker.mail.sent.length;

      // Four times: with no message, the window of a mailbox counts nothing.
      for (const email of ['paul@client.dev', 'lea@client.dev', 'max@client.dev', 'ana@client.dev']) {
        const answer = await ask(`${ORG}/invite-member`, { organizationId: acme.workspace, email, role: 'member' });
        assert.equal(answer.status, 200, await answer.clone().text());
      }

      assert.equal(worker.mail.sent.length, before);
      assert.equal((await rowsOf(worker.database, `SELECT id FROM invitation WHERE status = 'pending'`)).length, 4);
      // Paul signs in by another way (a provider, here a test session), and finds it in the console.
      const paul = await person(worker, 'paul@client.dev');
      assert.equal((await theirInvitations(worker, paul)).length, 1);
    });

    it('writes an invitation in the language of the person it is for, or of the one who invites', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      await as(worker, acme.owner, '/console/me/locale', { body: { locale: 'fr' } });
      const lea = await person(worker, 'lea@client.dev');
      await as(worker, lea, '/console/me/locale', { body: { locale: 'en' } });

      // Nobody knows the language of a new address: the one of the inviter.
      await invite(worker, acme.owner, acme.workspace, { email: 'paul@client.dev', role: 'admin' });
      const french = worker.mail.sent.at(-1);
      assert.equal(french?.subject, 'Vous êtes invité dans un espace de travail sur Fruitback');
      assert.match(
        french?.text ?? '',
        /vous invite dans l'espace de travail « acme » sur Fruitback, comme administrateur\./,
      );
      assert.match(french?.text ?? '', /Elle attend 7 jours\./);

      // Léa has an account that says English.
      await invite(worker, acme.owner, acme.workspace, { email: 'lea@client.dev' });
      assert.equal(worker.mail.sent.at(-1)?.subject, 'You are invited to a workspace on Fruitback');
    });

    it('refuses an invitation past its seven days', async () => {
      const worker = await workerOn(open);
      const acme = await team(worker);
      const id = await invited(worker, acme, 'paul@client.dev');
      const [row] = await rowsOf(worker.database, `SELECT "expiresAt", "createdAt" FROM invitation WHERE id = '${id}'`);
      const lasts = new Date(String(row?.expiresAt)).getTime() - new Date(String(row?.createdAt)).getTime();
      assert.ok(Math.abs(lasts - INVITATION_SECONDS * 1000) < 60_000, `an invitation lasts ${lasts} ms`);
      const paul = await person(worker, 'paul@client.dev');
      await rowsOf(
        worker.database,
        `UPDATE invitation SET "expiresAt" = now() - interval '1 second' WHERE id = '${id}'`,
      );

      const late = await as(worker, paul, `${ORG}/accept-invitation`, { body: { invitationId: id } });

      assert.equal(late.status, 400);
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`), []);
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
