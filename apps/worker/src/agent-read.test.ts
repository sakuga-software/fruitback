import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';

/**
 * `GET /feedback` says which notes an agent works on (FRU-618): a session of a routine started for
 * them. Everybody who reads the note is told; only a member of the team who sees the tracker gets the
 * address of the session, which is the team's.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const SESSION = 'https://claude.ai/code/session_01AbC';

type Answer = { status: number; body: Record<string, any> };
const answerOf = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: (await response.json()) as Record<string, any>,
});

async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/** Alice owns Acme, whose site everybody reads. Gary is a guest of the site. Two notes, one with a session. */
async function aSite(url = SESSION) {
  const world = await open();
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'everyone' })).id;
  const gary = await signInTo(world, 'gary@client.dev');
  await memberOf(world, workspace, gary.id, 'guest');
  await shareWith(world, workspace, gary.id, [site]);
  const tokens = {
    alice: await sessionOf(world, alice.id, workspace),
    gary: await sessionOf(world, gary.id, workspace),
  };
  const identifiers: string[] = [];
  for (const id of ['ag_1', 'ag_2']) {
    const note = noteFixture({ id, page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await answerOf(
      await callOn(
        world,
        'POST',
        '/feedback',
        { origin: ORIGIN, body: note, headers: { Authorization: `Bearer ${tokens.alice}` } },
        { store },
      ),
    );
    assert.equal(planted.status, 201, JSON.stringify(planted.body));
    identifiers.push(planted.body.issue.identifier as string);
  }
  const routine = await world.accounts.addConnector(workspace, {
    kind: 'claude-routine',
    label: 'Routine',
    sealed: 'x',
  });
  await world.accounts.keepAgentSession(routine.id, {
    id: 'dlv_1',
    site,
    identifiers: [identifiers[0] as string],
    url,
    at: Date.now(),
  });

  return { world, store, site, tokens, identifiers };
}

async function read(world: World, site: string, token: string | undefined, store: NoteStore) {
  const answer = await answerOf(
    await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`,
      { origin: ORIGIN, ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }) },
      { store },
    ),
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  return answer.body.issues as Record<string, any>[];
}

const agentOf = (issues: Record<string, any>[], id: string) => issues.find((issue) => issue.note.id === id)?.agent;

describe('the notes an agent works on, in the read of a page (FRU-618)', () => {
  it('gives the address of the session to a member of the team who sees the tracker', async () => {
    const { world, store, site, tokens } = await aSite();
    const issues = await read(world, site, tokens.alice, store);

    assert.deepEqual(agentOf(issues, 'ag_1'), { url: SESSION });
    assert.equal(agentOf(issues, 'ag_2'), undefined);
  });

  it('tells a guest and a visitor that an agent works on the note, and never the address, the cache read first by a member', async () => {
    const { world, store, site, tokens } = await aSite();
    // The member reads first: the answer of the page goes into the cache every reader shares.
    assert.deepEqual(agentOf(await read(world, site, tokens.alice, store), 'ag_1'), { url: SESSION });

    for (const reader of [tokens.gary, undefined]) {
      const issues = await read(world, site, reader, store);
      assert.deepEqual(agentOf(issues, 'ag_1'), {}, String(reader));
      assert.equal(agentOf(issues, 'ag_2'), undefined);
      assert.ok(!JSON.stringify(issues).includes('claude.ai'), 'the address reached a reader who is not of the team');
    }
  });

  it('gives no address that is not https, and keeps the line', async () => {
    const { world, store, site, tokens } = await aSite('javascript:alert(1)');

    assert.deepEqual(agentOf(await read(world, site, tokens.alice, store), 'ag_1'), {});
  });
});
