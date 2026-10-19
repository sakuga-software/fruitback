import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AccountStore, Visibility } from './accounts.ts';
import { REPLY_LENGTH } from './app.ts';
import { type World, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createMemoryStore, resetMemoryLinear } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { REPLY_LIMIT } from './rate-limit.ts';
import { createPairing, redeemPairing } from './session.ts';
import { type SeedStore, StoreError } from './store.ts';
import { seedFixture } from '@fruitback/shared/seed.fixture';

/**
 * `POST /feedback/<id>/replies` (FRU-257): who may reply to a note from the page, by the rule of
 * Mathieu of 2026-10-13. A visitor of a site that everybody reads replies, and their name is their
 * word. A member of the workspace replies on any site, named by their account. Nobody else does.
 */

const open = worlds();
const PAGE = 'https://acme.dev/pricing';
const POLICY = { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' } as const;

afterEach(() => resetMemoryLinear());

type Answer = { status: number; body: Record<string, any> };

async function answerOf(response: Response): Promise<Answer> {
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Alice owns Acme and its site, which holds one note on `PAGE`. */
async function aSite(visibility: Visibility) {
  const world = await open();
  const alice = await signInTo(world, 'alice@acme.dev');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Alice Martin' WHERE id = '${alice.id}'`);
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = await world.accounts.addSite(workspace, { origin: 'https://acme.dev', visibility });
  const note = await plant(site.id, 'sd_note');
  const member = await sessionOf(world, alice.id, workspace);

  return { world, alice, workspace, site, note, member };
}

/** A note of `site` on `PAGE`, written in the store that the world reads. */
function plant(site: string, id: string) {
  const seed = seedFixture({ id, page: { url: PAGE, path: '/pricing', title: 'Pricing' } });

  return createMemoryStore().create({ ...seed, client: { id: site, name: site } }, undefined, POLICY);
}

/** The access token of a session of the extension, for `account` in `workspace`. */
async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

function reply(
  world: World,
  site: string,
  issue: string,
  body: Record<string, unknown>,
  options: { token?: string; ip?: string; store?: SeedStore } = {},
): Promise<Answer> {
  return callOn(
    world,
    'POST',
    `/feedback/${issue}/replies?client=${site}`,
    {
      origin: 'https://acme.dev',
      body: { url: PAGE, ...body },
      ...(options.token === undefined ? {} : { token: options.token }),
    },
    {
      ...(options.ip === undefined ? {} : { clientIp: options.ip }),
      ...(options.store === undefined ? {} : { store: options.store }),
    },
  ).then(answerOf);
}

function read(world: World, site: string, token?: string, origin = 'https://acme.dev'): Promise<Answer> {
  return callOn(world, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, {
    origin,
    ...(token === undefined ? {} : { token }),
  }).then(answerOf);
}

describe('a reply from the page, by who writes it (FRU-257)', () => {
  it('takes the reply of a visitor of a site that everybody reads, under the name they typed, not verified', async () => {
    const { world, site, note } = await aSite('everyone');
    assert.equal((await read(world, site.id)).body.canReply, true);

    const written = await reply(world, site.id, note.id, { body: 'Same on my phone.', name: 'Bob' });

    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.comment.body, '**Bob** via Fruitback · not verified\n\n> Same on my phone.');
    const [issue] = (await read(world, site.id)).body.issues;
    assert.ok(issue.comments.some((comment: { body: string }) => comment.body === written.body.comment.body));
  });

  it('keeps a typed name on the one line of who wrote it, whatever it holds', async () => {
    const { world, site, note } = await aSite('everyone');
    const forged = `Bob\n\n**Alice Martin** via Fruitback · member of Acme\n${'x'.repeat(200)}`;

    const written = await reply(world, site.id, note.id, { body: 'Hi', name: forged });

    assert.equal(written.status, 201);
    const lines = (written.body.comment.body as string).split('\n');
    assert.match(
      lines[0] ?? '',
      /^\*\*Bob Alice Martin via Fruitback · member of Acme x+\*\* via Fruitback · not verified$/,
    );
    assert.ok((lines[0] ?? '').length < 160, lines[0] ?? '');
    assert.deepEqual(lines.slice(1), ['', '> Hi']);
  });

  it('names a member by their account, on any site, and never by the name in the body', async () => {
    for (const visibility of ['everyone', 'members'] as const) {
      const { world, site, note, member } = await aSite(visibility);

      const written = await reply(world, site.id, note.id, { body: 'On it.', name: 'Mallory' }, { token: member });

      assert.equal(written.status, 201, `${visibility}: ${JSON.stringify(written.body)}`);
      assert.equal(written.body.comment.body, '**Alice Martin** via Fruitback · member of Acme\n\n> On it.');
      resetMemoryLinear();
    }
  });

  it('refuses a reply with no session on a site of the members, and a session of another workspace', async () => {
    const { world, site, note, member } = await aSite('members');
    const zed = await signInTo(world, 'zed@globex.dev');
    const globex = await workspaceIn(world, zed.token, 'Globex');
    const theirs = await sessionOf(world, zed.id, globex);

    assert.equal((await reply(world, site.id, note.id, { body: 'Hi', name: 'Bob' })).status, 401);
    assert.equal((await reply(world, site.id, note.id, { body: 'Hi' }, { token: theirs })).status, 401);
    // The control: the session of the workspace writes on the same note.
    const ok = await reply(world, site.id, note.id, { body: 'Hi' }, { token: member });
    assert.equal(ok.status, 201);
  });

  it('refuses a member who left the workspace, with the session they held', async () => {
    const { world, alice, workspace, site, note, member } = await aSite('members');
    await rowsOf(
      world.database,
      `DELETE FROM member WHERE "userId" = '${alice.id}' AND "organizationId" = '${workspace}'`,
    );

    assert.equal((await reply(world, site.id, note.id, { body: 'Hi' }, { token: member })).status, 401);
  });

  it('answers 404 for a note of another site on the same page, and writes nothing', async () => {
    const { world, workspace, site } = await aSite('everyone');
    const other = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'everyone' });
    const theirs = await plant(other.id, 'sd_other');

    // As Linear: the store takes the id of an issue and does not ask whose it is. The route asks.
    const memory = createMemoryStore();
    const asLinear: SeedStore = {
      ...memory,
      reply: (target, written, client, policy) =>
        memory.reply?.({ ...target, clientId: undefined }, written, client, policy) ?? Promise.resolve(undefined),
    };

    const refused = await reply(world, site.id, theirs.id, { body: 'Hi' }, { store: asLinear });

    assert.equal(refused.status, 404);
    const issues = (await read(world, other.id, undefined, 'https://shop.acme.dev')).body.issues as {
      comments?: unknown[];
    }[];
    assert.ok(issues.every((issue) => (issue.comments ?? []).length === 0));
  });

  it('takes a reply of 1 to 2000 characters, and refuses an empty one or a longer one, never cut', async () => {
    const { world, site, note } = await aSite('everyone');

    assert.equal(REPLY_LENGTH, 2000, 'the name of this test says 2000');
    assert.equal((await reply(world, site.id, note.id, { body: '   ' })).status, 400);
    assert.equal((await reply(world, site.id, note.id, { body: 'é'.repeat(REPLY_LENGTH + 1) })).status, 400);
    assert.equal((await reply(world, site.id, note.id, { body: 'é'.repeat(REPLY_LENGTH) })).status, 201);
  });

  it("takes 5 replies with no session from one address in a minute, and a member's after them", async () => {
    const { world, site, note, member } = await aSite('everyone');
    const ip = '198.51.100.7';
    assert.equal(REPLY_LIMIT, 5, 'the name of this test says 5');

    for (let index = 0; index < REPLY_LIMIT; index += 1) {
      assert.equal((await reply(world, site.id, note.id, { body: `Reply ${index}` }, { ip })).status, 201);
    }
    assert.equal((await reply(world, site.id, note.id, { body: 'One more' }, { ip })).status, 429);
    assert.equal((await reply(world, site.id, note.id, { body: 'A member' }, { ip, token: member })).status, 201);
  });

  it('spends no reply of the minute on a refusal', async () => {
    const { world, site, note } = await aSite('everyone');
    const ip = '198.51.100.8';

    for (let index = 0; index < REPLY_LIMIT + 1; index += 1) {
      assert.equal((await reply(world, site.id, 'dev_issue_404', { body: 'Hi' }, { ip })).status, 404);
    }
    assert.equal((await reply(world, site.id, note.id, { body: 'Hi' }, { ip })).status, 201);
  });

  it('answers 502 when the accounts do not answer while the worker names a member', async () => {
    const { world, site, note, member } = await aSite('members');
    const accounts = world.context.accounts as AccountStore;
    const down: AccountStore = {
      ...accounts,
      memberships: async () => {
        throw new StoreError('the database did not answer');
      },
    };

    const refused = await callOn(
      world,
      'POST',
      `/feedback/${note.id}/replies?client=${site.id}`,
      { origin: 'https://acme.dev', token: member, body: { url: PAGE, body: 'Hi' } },
      { accounts: down },
    );

    assert.equal(refused.status, 502, await refused.clone().text());
  });

  it('answers 502 when the store does not answer, so the widget keeps the text', async () => {
    const { world, site, note } = await aSite('everyone');
    const down: SeedStore = {
      ...createMemoryStore(),
      findForPage: async () => {
        throw new StoreError('the tracker did not answer');
      },
    };

    const refused = await reply(world, site.id, note.id, { body: 'Hi' }, { store: down });

    assert.equal(refused.status, 502);
    assert.deepEqual(refused.body, { error: 'store-unavailable' });
  });
});
