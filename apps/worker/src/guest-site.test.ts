import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { SEED_STAGES, type Seed, type SeedIssue, canonicalizePageUrl } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { MAX_GUEST_SITES } from './accounts.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { GUEST_WITHOUT_SITE } from './auth-organization.ts';
import { CONSOLE, type World, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { mutatedModule } from './conformance.fixture.ts';
import { digest } from './session.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createMemoryAttachmentStore } from './attachments.ts';
import type { CreatedIssue, SeedStore } from './store.ts';

/**
 * The guest of one site (FRU-250): an owner or an admin invites an address as a guest of the sites
 * it names, the person accepts, and from then on reads and writes on those sites and no other, and
 * never reads a reference of the tracker.
 *
 * Every case goes through `handleRequest`, on PostgreSQL (PGlite), with better-auth on. The guest
 * is made the way the console makes one: the route that invites, then the route that accepts.
 *
 * **Route by route** (« reads the site shared with them, and no other site of the workspace »): each
 * route that answers a thing of one site is asked by the guest on the shared site, on another site
 * of the same workspace, and by a person of another workspace. **A violation planted for each
 * route** takes its guard out of the file, and the same question then shows the other site: the
 * scenario holds the guard.
 */

const open = worlds();
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SHARED = 'https://staging.acme.dev';
const OTHER = 'https://preview.acme.dev';
const ORG = '/console/auth/organization';
/** What the tracker of the test writes: no answer of a guest may hold one of these. */
const TRACKER = ['ACM-', 'https://tracker.test', 'lin_'] as const;

type Who = { id: string; token: string };
type Handle = typeof handleRequest;

/**
 * A tracker that numbers its issues `ACM-n` and gives each an address: what a guest must never read.
 * It keeps the notes in memory, by page and by site.
 */
function trackerStore(): SeedStore {
  const kept: SeedIssue[] = [];
  const created = (seed: Seed): CreatedIssue => {
    const n = kept.length + 1;
    const issue: SeedIssue = {
      id: `lin_${n}`,
      identifier: `ACM-${n}`,
      url: `https://tracker.test/ACM-${n}`,
      title: seed.note.slice(0, 40),
      stage: SEED_STAGES[0],
      stateName: 'Todo',
      updatedAt: '2026-10-14T10:00:00.000Z',
      comments: [],
      seed,
    };
    kept.push(issue);

    return { id: issue.id, identifier: issue.identifier, url: issue.url as string };
  };

  return {
    name: 'tracker',
    scope: () => 'tracker',
    attachments: true,
    async create(seed) {
      return created(seed);
    },
    async findForPage({ url, clientId }) {
      return kept.filter((issue) => issue.seed.page.url === url && issue.seed.client?.id === clientId);
    },
  } as SeedStore;
}

/** A PNG header and nothing more: the worker reads its size and keeps its bytes. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 4);
  new DataView(bytes.buffer).setUint32(20, 3);

  return bytes;
}

let ip = 0;

/**
 * A request to the worker of the world, through `handle`: the real `handleRequest`, or the one of a
 * changed `app.ts`. A token with a `=` is a cookie of the console; any other is an access token.
 */
function send(
  world: World,
  context: Partial<RequestContext>,
  handle: Handle,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; bytes?: Uint8Array; origin?: string | null } = {},
): Promise<Response> {
  const origin = options.origin === undefined ? CONSOLE : options.origin;
  const headers: Record<string, string> = origin === null ? {} : { Origin: origin };
  if (options.token?.includes('=')) headers.Cookie = options.token;
  else if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.bytes !== undefined) headers['Content-Type'] = 'image/png';
  ip += 1;
  const body = options.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

  return handle(
    new Request(`https://api.fruitback.test${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
    world.env,
    { clientIp: `198.18.1.${ip % 250}`, ...world.context, ...context } as RequestContext,
  );
}

/**
 * Acme, with two sites of members; Gina invited as a guest of the first one and joined, by the
 * routes of the console; Max a member; Bob, the owner of Globex, with a site of his own.
 */
async function acme() {
  const world = await open();
  const store = trackerStore();
  const attachments = createMemoryAttachmentStore();
  const context: Partial<RequestContext> = { store, attachments, connectStore: world.connectStore };
  const call = (method: string, path: string, options: Parameters<typeof send>[5] = {}, handle = handleRequest) =>
    send(world, context, handle, method, path, options);

  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const siteOf = async (owner: Who, id: string, url: string): Promise<string> => {
    const made = await call('POST', `/console/workspaces/${id}/sites`, {
      token: owner.token,
      body: { url, visibility: 'members' },
    });
    assert.equal(made.status, 201, await made.clone().text());

    return ((await made.json()) as { id: string }).id;
  };
  const shared = await siteOf(alice, workspace, SHARED);
  const other = await siteOf(alice, workspace, OTHER);
  const max = await signInTo(world, 'max@acme.dev');
  await memberOf(world, workspace, max.id, 'member');
  const bob = await signInTo(world, 'bob@globex.dev');
  const globex = await workspaceIn(world, bob.token, 'Globex');
  const globexSite = await siteOf(bob, globex, 'https://staging.globex.dev');

  const invited = await call('POST', `${ORG}/invite-member`, {
    token: alice.token,
    body: { organizationId: workspace, email: 'gina@client.fr', role: 'guest', sites: [shared] },
  });
  assert.equal(invited.status, 200, await invited.clone().text());
  const invitation = ((await invited.json()) as { id: string }).id;
  const gina = await signInTo(world, 'gina@client.fr');
  const joined = await call('POST', `${ORG}/accept-invitation`, {
    token: gina.token,
    body: { invitationId: invitation },
  });
  assert.equal(joined.status, 200, await joined.clone().text());

  return { world, context, call, alice, workspace, shared, other, max, bob, globex, globexSite, gina, invitation };
}

type Acme = Awaited<ReturnType<typeof acme>>;

/** A session of the extension paired for one workspace, from the console: its access token. */
async function workspaceSession(team: Acme, who: Who, workspace: string): Promise<string> {
  const minted = await team.call('POST', `/console/workspaces/${workspace}/connect`, { token: who.token, body: {} });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const paired = await team.call('POST', '/session/pair', { body: { code }, origin: null });
  assert.equal(paired.status, 200, await paired.clone().text());

  return ((await paired.json()) as { accessToken: string }).accessToken;
}

/** A session of an account (FRU-238): the extension asks, the person approves, the extension claims. */
async function accountSession(team: Acme, who: Who): Promise<string> {
  const asked = await team.call('POST', '/session/connect', {
    origin: EXTENSION,
    body: { browser: 'Chrome on macOS' },
  });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const shown = await team.call('GET', `/console/connect/${request}`, { token: who.token });
  const { word } = (await shown.json()) as { word: string };
  const approved = await team.call('POST', `/console/connect/${request}/approve`, {
    token: who.token,
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  await team.world.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const claimed = await team.call('POST', '/session/connect/claim', { origin: EXTENSION, body: { claim } });
  assert.equal(claimed.status, 200, await claimed.clone().text());

  return ((await claimed.json()) as { accessToken: string }).accessToken;
}

function noteOn(site: string, origin: string, id: string): Seed {
  const seed = seedFixture({ id, page: { url: canonicalizePageUrl(`${origin}/pricing`), path: '/pricing' } });

  return { ...seed, client: { id: site, name: 'Acme' } };
}

const pageOf = (origin: string) => encodeURIComponent(canonicalizePageUrl(`${origin}/pricing`));

/**
 * One route that answers a thing of one site, asked by `token` about `site`: whether the answer
 * shows that site to the caller. `handle` is the real worker, or a changed one.
 */
type Route = {
  name: string;
  /** Which token the route takes: a cookie of the console, or a session of the extension of either kind. */
  token: 'cookie' | 'workspace' | 'account';
  reads(team: Acme, token: string, site: { id: string; origin: string }, handle?: Handle): Promise<boolean>;
};

const ROUTES: readonly Route[] = [
  {
    name: 'GET /feedback, with a session of the workspace',
    token: 'workspace',
    async reads(team, token, site, handle) {
      const answer = await team.call(
        'GET',
        `/feedback?url=${pageOf(site.origin)}&client=${site.id}`,
        { token, origin: site.origin },
        handle,
      );
      return answer.status === 200;
    },
  },
  {
    name: 'GET /feedback, with a session of the account',
    token: 'account',
    async reads(team, token, site, handle) {
      const answer = await team.call(
        'GET',
        `/feedback?url=${pageOf(site.origin)}&client=${site.id}`,
        { token, origin: site.origin },
        handle,
      );
      return answer.status === 200;
    },
  },
  {
    name: 'POST /feedback',
    token: 'workspace',
    async reads(team, token, site, handle) {
      const note = noteOn(site.id, site.origin, `sd_post_${Math.random().toString(36).slice(2, 10)}`);
      const answer = await team.call('POST', '/feedback', { token, origin: site.origin, body: note }, handle);
      return answer.status === 201;
    },
  },
  {
    name: 'POST /feedback, a batch, with a session of the account',
    token: 'account',
    async reads(team, token, site, handle) {
      const note = noteOn(site.id, site.origin, `sd_batch_${Math.random().toString(36).slice(2, 10)}`);
      const answer = await team.call('POST', '/feedback', { token, origin: site.origin, body: [note] }, handle);
      return answer.status === 201;
    },
  },
  {
    name: 'POST /attachments',
    token: 'workspace',
    async reads(team, token, site, handle) {
      const answer = await team.call(
        'POST',
        `/attachments?client=${site.id}`,
        { token, origin: EXTENSION, bytes: png() },
        handle,
      );
      return answer.status === 201;
    },
  },
  {
    name: 'GET /session/sites, with a session of the workspace',
    token: 'workspace',
    async reads(team, token, site, handle) {
      const answer = await team.call('GET', '/session/sites', { token, origin: EXTENSION }, handle);
      assert.equal(answer.status, 200, await answer.clone().text());
      return ((await answer.json()) as { sites: { id: string }[] }).sites.some((each) => each.id === site.id);
    },
  },
  {
    name: 'GET /session/sites, with a session of the account',
    token: 'account',
    async reads(team, token, site, handle) {
      const answer = await team.call('GET', '/session/sites', { token, origin: EXTENSION }, handle);
      assert.equal(answer.status, 200, await answer.clone().text());
      return ((await answer.json()) as { sites: { id: string }[] }).sites.some((each) => each.id === site.id);
    },
  },
  {
    name: 'GET /console/workspaces/<id>/sites',
    token: 'cookie',
    async reads(team, token, site, handle) {
      const answer = await team.call('GET', `/console/workspaces/${team.workspace}/sites`, { token }, handle);
      if (answer.status !== 200) return false;
      return ((await answer.json()) as { sites: { id: string }[] }).sites.some((each) => each.id === site.id);
    },
  },
  {
    name: 'GET /console/workspaces/<id>/notes',
    token: 'cookie',
    async reads(team, token, site, handle) {
      await plantNotes(team);
      const answer = await team.call(
        'GET',
        `/console/workspaces/${team.workspace}/notes?site=${site.id}`,
        { token },
        handle,
      );
      if (answer.status !== 200) return false;
      return ((await answer.json()) as { notes: { site: { id: string } }[] }).notes.some(
        (each) => each.site.id === site.id,
      );
    },
  },
];

/** A note of each site of Acme in the index, gone to the tracker: once for a world. */
const planted = new WeakSet<World>();
async function plantNotes(team: Acme): Promise<void> {
  if (planted.has(team.world)) return;
  planted.add(team.world);
  const index = team.world.context.noteIndex;
  assert.ok(index !== undefined);
  for (const [site, origin, n] of [
    [team.shared, SHARED, 7],
    [team.other, OTHER, 8],
  ] as const) {
    await index.record(
      [
        {
          workspace: team.workspace,
          site,
          seed: noteOn(site, origin, `sd_index_${n}`),
          channel: 'extension',
          author: { kind: 'member', account: team.alice.id },
          place: { kind: 'fruitback' },
          issue: { identifier: `ACM-${n}`, url: `https://tracker.test/ACM-${n}` },
          stage: SEED_STAGES[0],
        },
      ],
      Date.now(),
    );
  }
}

async function tokenFor(team: Acme, who: Who, kind: Route['token'], workspace = team.workspace): Promise<string> {
  if (kind === 'cookie') return who.token;

  return kind === 'workspace' ? workspaceSession(team, who, workspace) : accountSession(team, who);
}

describe('the guest of one site (FRU-250)', () => {
  describe('is invited by a route that names the sites, and joins with them', () => {
    it('refuses a guest with no site, a site of another workspace, a site to another role, and a list that is no list', async () => {
      const team = await acme();
      const invite = (body: Record<string, unknown>) =>
        team.call('POST', `${ORG}/invite-member`, {
          token: team.alice.token,
          body: { organizationId: team.workspace, email: 'paul@client.fr', ...body },
        });
      const many = Array.from({ length: MAX_GUEST_SITES + 1 }, (_, n) => `site_${n}`);

      for (const body of [
        { role: 'guest' },
        { role: 'guest', sites: [] },
        { role: 'guest', sites: [team.globexSite] },
        { role: 'guest', sites: [team.shared, team.globexSite] },
        { role: 'guest', sites: ['site_that_is_none'] },
        { role: 'guest', sites: [team.shared, team.shared] },
        { role: 'guest', sites: team.shared },
        { role: 'guest', sites: many },
        { role: 'guest', sites: [42] },
        { role: 'member', sites: [team.shared] },
        { role: 'admin', sites: [team.shared] },
      ]) {
        const answer = await invite(body);
        assert.deepEqual(
          [answer.status, await answer.json()],
          [400, { error: 'invalid-request', field: 'sites' }],
          JSON.stringify(body),
        );
      }
      assert.deepEqual(
        await rowsOf(team.world.database, `SELECT id FROM invitation WHERE email = 'paul@client.fr'`),
        [],
      );

      // The control: one site of the workspace is an invitation, with its site beside it.
      const answer = await invite({ role: 'guest', sites: [team.other] });
      assert.equal(answer.status, 200, await answer.clone().text());
      const kept = (await answer.json()) as { id: string; role: string; sites: unknown };
      assert.deepEqual([kept.role, kept.sites], ['guest', [{ id: team.other, origin: OTHER }]]);
      assert.deepEqual(
        await rowsOf(team.world.database, `SELECT site_id FROM invitation_sites WHERE invitation_id = '${kept.id}'`),
        [{ site_id: team.other }],
      );
    });

    it('names the site in the message, and in the lists of whoever invites and of the person', async () => {
      const team = await acme();
      const answer = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, email: 'paul@client.fr', role: 'guest', sites: [team.shared] },
      });
      assert.equal(answer.status, 200);
      const message = team.world.mail.sent.at(-1);
      assert.equal(message?.to, 'paul@client.fr');
      assert.match(
        (message?.text ?? '').replaceAll('​', ''),
        /alice@acme\.dev invites you to the workspace « Acme » on Fruitback, as a guest, on staging\.acme\.dev\./,
      );
      // The host is no link: the one link of the message is the console's.
      const links = `${message?.text}\n${message?.html}`.match(/https?:\/\/[^\s"<]+/g) ?? [];
      assert.deepEqual([...new Set(links)], [`${CONSOLE}/invitations`]);

      const waiting = await team.call('GET', `${ORG}/list-invitations?organizationId=${team.workspace}`, {
        token: team.alice.token,
      });
      const listed = (await waiting.json()) as { email: string; sites?: unknown }[];
      assert.deepEqual(listed.find((each) => each.email === 'paul@client.fr')?.sites, [
        { id: team.shared, origin: SHARED },
      ]);
      const paul = await signInTo(team.world, 'paul@client.fr');
      const theirs = (await (await team.call('GET', `${ORG}/list-user-invitations`, { token: paul.token })).json()) as {
        role: string;
        sites?: unknown;
      }[];
      assert.deepEqual(
        theirs.map((each) => [each.role, each.sites]),
        [['guest', [{ id: team.shared, origin: SHARED }]]],
      );
    });

    it('makes the member and their share at the acceptance, and shows the site on the screen of the members', async () => {
      const team = await acme();

      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.gina.id), {
        role: 'guest',
        sites: [team.shared],
      });
      const members = await team.call('GET', `${ORG}/list-members?organizationId=${team.workspace}`, {
        token: team.alice.token,
      });
      const rows = ((await members.json()) as { members: { userId: string; role: string; sites?: unknown }[] }).members;
      assert.deepEqual(rows.find((each) => each.userId === team.gina.id)?.sites, [{ id: team.shared, origin: SHARED }]);
      // Another role has no `sites`: it reads every site.
      assert.equal(rows.find((each) => each.userId === team.max.id)?.sites, undefined);
      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.max.id), {
        role: 'member',
        sites: 'every',
      });
    });

    it('refuses at the acceptance an invitation whose site was removed, and makes no member', async () => {
      const team = await acme();
      const invited = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, email: 'paul@client.fr', role: 'guest', sites: [team.other] },
      });
      const { id } = (await invited.json()) as { id: string };
      const removed = await team.call('DELETE', `/console/workspaces/${team.workspace}/sites/${team.other}`, {
        token: team.alice.token,
      });
      assert.equal(removed.status, 204);
      const paul = await signInTo(team.world, 'paul@client.fr');

      const answer = await team.call('POST', `${ORG}/accept-invitation`, {
        token: paul.token,
        body: { invitationId: id },
      });

      assert.equal(answer.status, 400);
      assert.equal(((await answer.json()) as { code?: string }).code, GUEST_WITHOUT_SITE);
      assert.deepEqual(await rowsOf(team.world.database, `SELECT id FROM member WHERE "userId" = '${paul.id}'`), []);
      // Somebody else who tries it gets the refusal of better-auth, and learns nothing of its sites.
      const other = await team.call('POST', `${ORG}/accept-invitation`, {
        token: team.gina.token,
        body: { invitationId: id },
      });
      assert.equal(other.status, 403);
      assert.equal(((await other.json()) as { code?: string }).code, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION');
    });

    it('writes no share for somebody who accepts the invitation of another person', async () => {
      const team = await acme();
      // Paul is invited as a guest of the other site; Gina, a guest of the first, tries his invitation.
      const invited = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, email: 'paul@client.fr', role: 'guest', sites: [team.other] },
      });
      const { id } = (await invited.json()) as { id: string };

      const answer = await team.call('POST', `${ORG}/accept-invitation`, {
        token: team.gina.token,
        body: { invitationId: id },
      });

      assert.equal(answer.status, 403);
      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.gina.id), {
        role: 'guest',
        sites: [team.shared],
      });
      // And a member who is a guest already does not change their sites by an invitation of theirs.
      assert.deepEqual(
        await rowsOf(team.world.database, `SELECT site_id FROM site_shares WHERE account_id = '${team.gina.id}'`),
        [{ site_id: team.shared }],
      );
    });

    it('takes the share away with its site: the guest stays a member and reads nothing', async () => {
      const team = await acme();
      // Notes of both sites, before the shared one goes.
      await plantNotes(team);
      const token = await workspaceSession(team, team.gina, team.workspace);
      const removed = await team.call('DELETE', `/console/workspaces/${team.workspace}/sites/${team.shared}`, {
        token: team.alice.token,
      });
      assert.equal(removed.status, 204);

      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.gina.id), { role: 'guest', sites: [] });
      const sites = await team.call('GET', '/session/sites', { token, origin: EXTENSION });
      assert.deepEqual(((await sites.json()) as { sites: unknown[] }).sites, []);
      const listed = await team.call('GET', `/console/workspaces/${team.workspace}/sites`, { token: team.gina.token });
      assert.deepEqual(((await listed.json()) as { sites: unknown[] }).sites, []);
      // No site is not « no filter »: the notes of the other site stay out of the list (review of #334).
      const notes = await team.call('GET', `/console/workspaces/${team.workspace}/notes`, { token: team.gina.token });
      assert.equal(notes.status, 200);
      assert.deepEqual(((await notes.json()) as { notes: unknown[] }).notes, []);
      const other = { id: team.other, origin: OTHER };
      assert.equal(await (ROUTES[0] as Route).reads(team, token, other), false);
    });

    it('takes the share away with the guest, and a new invitation names the new sites only', async () => {
      const team = await acme();
      const members = await team.call('GET', `${ORG}/list-members?organizationId=${team.workspace}`, {
        token: team.alice.token,
      });
      const gina = ((await members.json()) as { members: { id: string; userId: string }[] }).members.find(
        (each) => each.userId === team.gina.id,
      );
      const removed = await team.call('POST', `${ORG}/remove-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, memberIdOrEmail: gina?.id },
      });
      assert.equal(removed.status, 200, await removed.clone().text());
      assert.deepEqual(
        await rowsOf(team.world.database, `SELECT site_id FROM site_shares WHERE account_id = '${team.gina.id}'`),
        [],
      );

      const again = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, email: 'gina@client.fr', role: 'guest', sites: [team.other] },
      });
      const { id } = (await again.json()) as { id: string };
      const joined = await team.call('POST', `${ORG}/accept-invitation`, {
        token: team.gina.token,
        body: { invitationId: id },
      });
      assert.equal(joined.status, 200, await joined.clone().text());
      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.gina.id), {
        role: 'guest',
        sites: [team.other],
      });
    });

    it('keeps the share of a guest who presses « Join » twice at the same moment (heavy review of #334)', async () => {
      const team = await acme();
      const invited = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, email: 'paul@client.fr', role: 'guest', sites: [team.other] },
      });
      const { id } = (await invited.json()) as { id: string };
      const paul = await signInTo(team.world, 'paul@client.fr');

      const answers = await Promise.all(
        [1, 2].map(() =>
          team.call('POST', `${ORG}/accept-invitation`, { token: paul.token, body: { invitationId: id } }),
        ),
      );

      assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 400]);
      assert.deepEqual(await team.world.accounts.reach(team.workspace, paul.id), {
        role: 'guest',
        sites: [team.other],
      });
    });

    it('writes the sites of the invitation a « Resend » makes when the one that waited is past its end (heavy review of #334)', async () => {
      const team = await acme();
      const body = { organizationId: team.workspace, email: 'paul@client.fr', role: 'guest', sites: [team.other] };
      const first = await team.call('POST', `${ORG}/invite-member`, { token: team.alice.token, body });
      const { id } = (await first.json()) as { id: string };
      await rowsOf(
        team.world.database,
        `UPDATE invitation SET "expiresAt" = now() - interval '1 day' WHERE id = '${id}'`,
      );

      const again = await team.call('POST', `${ORG}/invite-member`, {
        token: team.alice.token,
        body: { ...body, resend: true },
      });

      assert.equal(again.status, 200, await again.clone().text());
      const made = (await again.json()) as { id: string };
      assert.notEqual(made.id, id, 'better-auth made a new invitation');
      const paul = await signInTo(team.world, 'paul@client.fr');
      const joined = await team.call('POST', `${ORG}/accept-invitation`, {
        token: paul.token,
        body: { invitationId: made.id },
      });
      assert.equal(joined.status, 200, await joined.clone().text());
      assert.deepEqual(await team.world.accounts.reach(team.workspace, paul.id), {
        role: 'guest',
        sites: [team.other],
      });
    });

    it('takes the shares away from a guest who becomes a member (review of #334)', async () => {
      const team = await acme();
      const members = await team.call('GET', `${ORG}/list-members?organizationId=${team.workspace}`, {
        token: team.alice.token,
      });
      const gina = ((await members.json()) as { members: { id: string; userId: string }[] }).members.find(
        (each) => each.userId === team.gina.id,
      );
      const promoted = await team.call('POST', `${ORG}/update-member-role`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, memberId: gina?.id, role: 'member' },
      });
      assert.equal(promoted.status, 200, await promoted.clone().text());
      assert.deepEqual(
        await rowsOf(team.world.database, `SELECT site_id FROM site_shares WHERE account_id = '${team.gina.id}'`),
        [],
      );
      assert.deepEqual(await team.world.accounts.reach(team.workspace, team.gina.id), {
        role: 'member',
        sites: 'every',
      });
    });

    it('makes no guest by a change of role: a guest is made by an invitation, which names the sites', async () => {
      const team = await acme();
      const members = await team.call('GET', `${ORG}/list-members?organizationId=${team.workspace}`, {
        token: team.alice.token,
      });
      const max = ((await members.json()) as { members: { id: string; userId: string }[] }).members.find(
        (each) => each.userId === team.max.id,
      );
      const answer = await team.call('POST', `${ORG}/update-member-role`, {
        token: team.alice.token,
        body: { organizationId: team.workspace, memberId: max?.id, role: 'guest' },
      });
      assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-request', field: 'role' }]);
    });
  });

  describe('reads and writes on the site shared with them, and on no other site of the workspace', () => {
    for (const route of ROUTES) {
      it(`${route.name}: the shared site, not the other one, as for a person of another workspace`, async () => {
        const team = await acme();
        const guest = await tokenFor(team, team.gina, route.token);
        const member = await tokenFor(team, team.max, route.token);
        const shared = { id: team.shared, origin: SHARED };
        const other = { id: team.other, origin: OTHER };

        assert.equal(await route.reads(team, guest, shared), true, 'the guest on their site');
        assert.equal(await route.reads(team, guest, other), false, 'the guest on another site');
        // The controls: a member reads both, and Bob of Globex neither.
        assert.equal(await route.reads(team, member, other), true, 'a member on the other site');
        const bob = await tokenFor(team, team.bob, route.token, team.globex);
        assert.equal(await route.reads(team, bob, other), false, 'a person of another workspace');
      });
    }
  });

  describe('fails when the guard of a route is taken out (planted violations)', () => {
    /** Each guard of `app.ts`, taken out: the same question shows the other site. */
    const IN_APP: readonly { guard: string; from: string; to: string; routes: readonly string[] }[] = [
      {
        guard: 'a session of a workspace reads the site, not only the workspace',
        from: `    if (account === undefined || !(await reaches(account))) return { ok: false, reason: 'invalid-claims' };`,
        to: '',
        routes: ['GET /feedback, with a session of the workspace', 'POST /feedback'],
      },
      {
        guard: 'a session reaches the site of a guest, not the workspace',
        from: 'readsSite(await reachIn(workspace, account), site),\n        }),',
        to: '(await reachIn(workspace, account)) !== undefined,\n        }),',
        routes: [
          'GET /feedback, with a session of the account',
          'POST /feedback, a batch, with a session of the account',
        ],
      },
      {
        guard: 'a file is of the site of its note',
        from: 'const reaches = async (account: string) => readsSite(await reachIn(workspace, account), site);',
        to: 'const reaches = async (account: string) => (await reachIn(workspace, account)) !== undefined;',
        routes: ['POST /attachments'],
      },
    ];
    for (const plant of IN_APP) {
      it(`lets the guest reach the other site without « ${plant.guard} »`, async () => {
        const mutant = await mutatedModule('app.ts', { from: plant.from, to: plant.to });
        try {
          const changed = mutant.module.handleRequest as Handle;
          for (const name of plant.routes) {
            const route = ROUTES.find((each) => each.name === name) as Route;
            const team = await acme();
            const guest = await tokenFor(team, team.gina, route.token);
            assert.equal(await route.reads(team, guest, { id: team.other, origin: OTHER }, changed), true, name);
          }
        } finally {
          mutant.remove();
        }
      });
    }

    it('lets the guest read every site of the workspace in GET /session/sites without its filter', async () => {
      const team = await acme();
      const index = team.world.context.noteIndex;
      for (const [kind, from, to] of [
        ['workspace', 'readableSites(await accounts.sites(workspaceId), reach)', 'await accounts.sites(workspaceId)'],
        ['account', 'readableSites(await accounts.sites(workspace.id), reach)', 'await accounts.sites(workspace.id)'],
      ] as const) {
        const mutant = await mutatedModule('session-sites.ts', { from, to });
        try {
          const handle = mutant.module.handleSessionSites as (...values: unknown[]) => Promise<Response>;
          const token = await tokenFor(team, team.gina, kind);
          const answer = await handle(
            new Request('https://api.fruitback.test/session/sites', { headers: { Authorization: `Bearer ${token}` } }),
            team.world.accounts,
            team.world.env.FRUITBACK_IDENTITY_SECRET,
            {},
            undefined,
            index,
          );
          const ids = ((await answer.json()) as { sites: { id: string }[] }).sites.map((site) => site.id);
          assert.ok(ids.includes(team.other), kind);
        } finally {
          mutant.remove();
        }
      }
    });

    it('lets the guest read every site in GET /console/workspaces/<id>/sites without its filter', async () => {
      const team = await acme();
      const mutant = await mutatedModule('console-api.ts', {
        from: 'const sites = readableSites(await context.accounts.sites(workspaceId as string), reach);',
        to: 'const sites = await context.accounts.sites(workspaceId as string);',
      });
      try {
        const handle = mutant.module.handleConsoleApi as (...values: unknown[]) => Promise<Response>;
        const answer = await handle(
          new Request(`https://api.fruitback.test/console/workspaces/${team.workspace}/sites`),
          `/console/workspaces/${team.workspace}/sites`,
          {
            accounts: team.world.accounts,
            sessions: team.world.sessions,
            cookieSession: async () => team.gina.id,
            consoleUrl: CONSOLE,
          },
          {},
        );
        const ids = ((await answer.json()) as { sites: { id: string }[] }).sites.map((site) => site.id);
        assert.ok(ids.includes(team.other));
      } finally {
        mutant.remove();
      }
    });

    it('lets the guest read the notes of every site in GET /console/workspaces/<id>/notes without its filter', async () => {
      const team = await acme();
      await plantNotes(team);
      const mutant = await mutatedModule('console-notes.ts', {
        from: "const sites = reach.sites === 'every' ? {} : { sites: reach.sites };",
        to: 'const sites = {};',
      });
      try {
        const handle = mutant.module.handleNotes as (...values: unknown[]) => Promise<Response>;
        const answer = await handle(
          '/notes',
          new Request(`https://api.fruitback.test/console/workspaces/x/notes?site=${team.other}`),
          {
            workspace: team.workspace,
            account: team.gina.id,
            allowed: (action: string) => action === 'read-feedback',
            reach: () => team.world.accounts.reach(team.workspace, team.gina.id),
            noteIndex: team.world.context.noteIndex,
            accounts: team.world.accounts,
            now: Date.now(),
            headers: {},
          },
        );
        const sites = ((await answer.json()) as { notes: { site: { id: string } }[] }).notes.map(
          (note) => note.site.id,
        );
        assert.ok(sites.includes(team.other));
      } finally {
        mutant.remove();
      }
    });
  });

  describe('never reads a reference of the tracker, on any route', () => {
    /** Every route a guest reaches, on their site, as `name` and the call. */
    const GUEST_ROUTES: readonly [string, (team: Acme, tokens: Record<Route['token'], string>) => Promise<Response>][] =
      [
        [
          'GET /feedback',
          (team, t) =>
            team.call('GET', `/feedback?url=${pageOf(SHARED)}&client=${team.shared}`, {
              token: t.workspace,
              origin: SHARED,
            }),
        ],
        [
          'GET /feedback (account)',
          (team, t) =>
            team.call('GET', `/feedback?url=${pageOf(SHARED)}&client=${team.shared}`, {
              token: t.account,
              origin: SHARED,
            }),
        ],
        [
          'POST /feedback',
          (team, t) =>
            team.call('POST', '/feedback', {
              token: t.workspace,
              origin: SHARED,
              body: noteOn(team.shared, SHARED, 'sd_guest_one'),
            }),
        ],
        [
          'POST /feedback (batch)',
          (team, t) =>
            team.call('POST', '/feedback', {
              token: t.account,
              origin: SHARED,
              body: [noteOn(team.shared, SHARED, 'sd_guest_two')],
            }),
        ],
        [
          'POST /attachments',
          (team, t) =>
            team.call('POST', `/attachments?client=${team.shared}`, {
              token: t.workspace,
              origin: EXTENSION,
              bytes: png(),
            }),
        ],
        [
          'GET /session/sites',
          (team, t) => team.call('GET', '/session/sites', { token: t.workspace, origin: EXTENSION }),
        ],
        [
          'GET /session/sites (account)',
          (team, t) => team.call('GET', '/session/sites', { token: t.account, origin: EXTENSION }),
        ],
        ['GET /console/me', (team, t) => team.call('GET', '/console/me', { token: t.cookie })],
        [
          'GET /console/workspaces/<id>/sites',
          (team, t) => team.call('GET', `/console/workspaces/${team.workspace}/sites`, { token: t.cookie }),
        ],
        [
          'GET /console/workspaces/<id>/notes',
          (team, t) => team.call('GET', `/console/workspaces/${team.workspace}/notes`, { token: t.cookie }),
        ],
        [
          'GET /console/workspaces/<id>/notes?q=ACM',
          (team, t) => team.call('GET', `/console/workspaces/${team.workspace}/notes?q=ACM-7`, { token: t.cookie }),
        ],
        [
          'GET list-user-invitations',
          (team, t) => team.call('GET', `${ORG}/list-user-invitations`, { token: t.cookie }),
        ],
      ];

    /** Notes of the shared site, in the tracker and in the index, planted by the owner. */
    async function withNotes(team: Acme): Promise<void> {
      await plantNotes(team);
      const owner = await workspaceSession(team, team.alice, team.workspace);
      const sent = await team.call('POST', '/feedback', {
        token: owner,
        origin: SHARED,
        body: noteOn(team.shared, SHARED, 'sd_by_alice'),
      });
      assert.equal(sent.status, 201, await sent.clone().text());
    }

    for (const [name, call] of GUEST_ROUTES) {
      it(`${name}: no reference, no address and no id of the tracker`, async () => {
        const team = await acme();
        await withNotes(team);
        const tokens = {
          cookie: team.gina.token,
          workspace: await workspaceSession(team, team.gina, team.workspace),
          account: await accountSession(team, team.gina),
        };
        const answer = await call(team, tokens);
        const text = await answer.text();
        assert.ok(answer.status < 300, `${answer.status} ${text}`);
        // The note of the owner is read: the absence of a reference is not the absence of the note.
        if (name.startsWith('GET /feedback')) assert.ok(text.includes('sd_by_alice'), text);
        for (const mark of TRACKER) assert.equal(text.includes(mark), false, `${mark} in ${text}`);
      });
    }

    it('gives the same routes a reference for a member: the marks above are what the tracker writes', async () => {
      const team = await acme();
      await withNotes(team);
      const tokens = {
        cookie: team.max.token,
        workspace: await workspaceSession(team, team.max, team.workspace),
        account: await accountSession(team, team.max),
      };
      for (const name of [
        'GET /feedback',
        'GET /feedback (account)',
        'POST /feedback',
        'POST /feedback (batch)',
        'GET /console/workspaces/<id>/notes',
      ]) {
        const call = GUEST_ROUTES.find(([each]) => each === name)?.[1];
        const text = await (await (call as (typeof GUEST_ROUTES)[number][1])(team, tokens)).text();
        assert.ok(text.includes('ACM-'), `${name}: ${text}`);
      }
    });

    it('fails without the hiding of the references on the routes of the widget (planted violation)', async () => {
      const mutant = await mutatedModule('app.ts', {
        from: "  return role !== undefined && !can(role, 'see-tracker');\n}",
        to: '  return role === undefined && false;\n}',
      });
      try {
        const team = await acme();
        await withNotes(team);
        const token = await workspaceSession(team, team.gina, team.workspace);
        const answer = await team.call(
          'GET',
          `/feedback?url=${pageOf(SHARED)}&client=${team.shared}`,
          { token, origin: SHARED },
          mutant.module.handleRequest as Handle,
        );
        assert.ok((await answer.text()).includes('ACM-'));
      } finally {
        mutant.remove();
      }
    });
  });
});
