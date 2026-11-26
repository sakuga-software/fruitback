import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { memberOf, shareWith, signInTo } from './console-world.fixture.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import { type Handle, KEY_A, PAGE, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * The status of a note, changed from its thread on the page (FRU-718), through the route of the
 * extension (FRU-367): `POST /feedback/<id>/status`. The read says `canSetStatus` on each note the
 * reader may move, and the route decides again. A member only: the person who left the note, or a role
 * that manages the sites, with a session. A visitor, a key with no session, a token that is no session,
 * and a guest with no right on the note change nothing.
 */

type Site = Awaited<ReturnType<typeof aVisitorSite>>;

/** A session of the extension of `account` in `workspace`. */
async function sessionOf(world: Site['world'], account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/**
 * The site of `aVisitorSite`: Alice owns it, Bob is a member. Carol is a member too, Gina a guest the
 * site is shared with, and Hugo a guest of another site of Acme. Bob left `ws_bob` with his session,
 * and the browser of key A left `ws_visitor` with no session.
 */
async function aTeam(options: Parameters<typeof aVisitorSite>[0] = {}) {
  const site = await aVisitorSite(options);
  const { world, workspace } = site;
  const other = (await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' }))
    .id;
  const alice = (await rowsOf(world.database, `SELECT id FROM "user" WHERE email = 'alice@acme.dev'`))[0]?.id as string;
  const carol = await signInTo(world, 'carol@acme.dev');
  const gina = await signInTo(world, 'gina@acme.dev');
  const hugo = await signInTo(world, 'hugo@acme.dev');
  await memberOf(world, workspace, carol.id, 'member');
  await memberOf(world, workspace, gina.id, 'guest');
  await memberOf(world, workspace, hugo.id, 'guest');
  await shareWith(world, workspace, gina.id, [site.site]);
  await shareWith(world, workspace, hugo.id, [other]);
  const tokens = {
    alice: await sessionOf(world, alice, workspace),
    bob: site.bobToken,
    carol: await sessionOf(world, carol.id, workspace),
    gina: await sessionOf(world, gina.id, workspace),
    hugo: await sessionOf(world, hugo.id, workspace),
  };
  const bobs = await site.send(site.noteOf('ws_bob', 'The price is wrong.'), { token: tokens.bob });
  const visitors = await site.send(site.noteOf('ws_visitor', 'The button is too small.', 'Camille'), { key: KEY_A });

  /** `POST /feedback/<issue>/status` of the thread, for a built-in status: one of the five stages. */
  const setStage = (issue: string, stage: string, who: { key?: string; token?: string }) =>
    site.call('POST', `/feedback/${issue}/status?client=${site.site}`, who, { url: PAGE, status: `own:${stage}` });
  const stages = async () =>
    Object.fromEntries(
      (await rowsOf(world.database, 'SELECT payload, stage FROM notes')).map((row) => [
        JSON.parse(String(row.payload)).id as string,
        row.stage,
      ]),
    );
  /** The notes this reader may move, by the id the widget gave them. */
  const offered = async (who: { key?: string; token?: string }) =>
    [...(await site.read(who))].flatMap(([id, issue]) => (issue.canSetStatus === true ? [id] : [])).sort();

  return { ...site, tokens, bobs, visitors, setStage, stages, offered };
}

describe('the status of a note, from its thread on the page (FRU-718)', () => {
  it('lets the member who left the note move it, and the read, the store and the index follow', async () => {
    const { world, site, tokens, bobs, setStage, stages, read } = await aTeam();

    const moved = await setStage(bobs, 'progress', { token: tokens.bob });

    assert.deepEqual(moved, { status: 200, body: { status: 'own:progress', stage: 'progress' } });
    assert.equal((await stages()).ws_bob, 'progress');
    assert.equal((await read({ token: tokens.bob })).get('ws_bob')?.stage, 'progress');
    const [row] = await rowsOf(
      world.database,
      `SELECT stage FROM note_index WHERE site_id = '${site}' AND note_id = 'ws_bob'`,
    );
    assert.equal(row?.stage, 'progress');
  });

  it('offers the menu to the author on their note, to a role that manages the sites on every note, and to nobody else', async () => {
    const { tokens, offered } = await aTeam();

    assert.deepEqual(await offered({ token: tokens.bob }), ['ws_bob']);
    assert.deepEqual(await offered({ token: tokens.alice }), ['ws_bob', 'ws_visitor']);
    // A member who left neither note, a guest the site is shared with, a guest of another site.
    assert.deepEqual(await offered({ token: tokens.carol }), []);
    assert.deepEqual(await offered({ token: tokens.gina }), []);
    assert.deepEqual(await offered({}), []);
    // The visitor who left a note with the key of their browser: the status is the team's.
    assert.deepEqual(await offered({ key: KEY_A }), []);
    assert.deepEqual(await offered({ key: KEY_A, token: 'not.a.session' }), []);
  });

  it('refuses a visitor, a key with no session, no key, a token that is no session, and a guest, and moves nothing', async () => {
    const { tokens, bobs, visitors, setStage, stages } = await aTeam();
    const before = await stages();

    // The visitor who left the note, by the key of their browser: no session, nobody the route names.
    assert.equal((await setStage(visitors, 'done', { key: KEY_A })).status, 401);
    assert.equal((await setStage(bobs, 'done', { key: KEY_A })).status, 401);
    assert.equal((await setStage(visitors, 'done', {})).status, 401);
    assert.equal((await setStage(visitors, 'done', { key: KEY_A, token: 'not.a.session' })).status, 401);
    // A member who did not leave the note, a guest the site is shared with, a guest of another site.
    assert.deepEqual(await setStage(bobs, 'done', { token: tokens.carol }), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.equal((await setStage(bobs, 'done', { token: tokens.gina })).status, 403);
    assert.equal((await setStage(visitors, 'done', { token: tokens.hugo })).status, 403);

    assert.deepEqual(await stages(), before);
    assert.deepEqual(before, { ws_bob: 'new', ws_visitor: 'new' });
  });

  it('lets a role that manages the sites move the note of a visitor', async () => {
    const { tokens, visitors, setStage, stages } = await aTeam();

    assert.equal((await setStage(visitors, 'todo', { token: tokens.alice })).status, 200);
    assert.equal((await stages()).ws_visitor, 'todo');
  });

  it('offers no menu on the note of a tracker: its status changes in the tracker (Linear)', async () => {
    const { tokens, offered, bobs, setStage } = await aTeam({ storeOf: () => createMemoryStore() });

    assert.deepEqual(await offered({ token: tokens.alice }), []);
    assert.deepEqual(await offered({ token: tokens.bob }), []);
    assert.deepEqual(await setStage(bobs, 'done', { token: tokens.bob }), {
      status: 403,
      body: { error: 'statuses-not-taken' },
    });
  });
});

/**
 * Each guard of FRU-718, taken out of a copy of its module: the case that holds it sees the change. The
 * real module is the control of each one, in the same world.
 */
describe('the guards of the status from the thread, each planted out (FRU-718)', () => {
  type Team = Awaited<ReturnType<typeof aTeam>>;
  const STATUS = 'export async function postStatus(';
  const PLANTS: readonly {
    guard: string;
    file: string;
    after?: string;
    from: string;
    to: string;
    holds: (team: Team) => Promise<boolean>;
  }[] = [
    {
      guard: 'a member who did not leave the note does not move it',
      file: 'reply-routes.ts',
      after: STATUS,
      from: "if (author !== account && !manages) return json(403, { error: 'not-allowed' }, corsHeaders);",
      to: '',
      holds: async ({ tokens, bobs, setStage, stages }) =>
        (await setStage(bobs, 'done', { token: tokens.carol })).status === 403 && (await stages()).ws_bob === 'new',
    },
    {
      guard: 'a visitor with no session moves nothing',
      file: 'reply-routes.ts',
      after: STATUS,
      from: 'session === undefined) {\n      return json(401',
      to: 'false) {\n      return json(401',
      holds: async ({ visitors, setStage, stages }) =>
        (await setStage(visitors, 'done', { key: KEY_A })).status === 401 && (await stages()).ws_visitor === 'new',
    },
    {
      guard: 'the read offers the menu to a member on their own notes only',
      file: 'feedback-routes.ts',
      from: "(setsStatus === 'own' && mine)",
      to: "setsStatus === 'own'",
      holds: async ({ tokens, offered }) => (await offered({ token: tokens.carol })).length === 0,
    },
    {
      guard: 'the read offers no menu to a visitor, even on their own note',
      file: 'feedback-routes.ts',
      from: "if (account === undefined) return 'none';",
      to: "if (account === undefined) return 'own';",
      holds: async ({ offered }) => (await offered({ key: KEY_A })).length === 0,
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      assert.equal(await plant.holds(await aTeam()), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, {
        ...(plant.after === undefined ? {} : { after: plant.after }),
        from: plant.from,
        to: plant.to,
      });
      try {
        const handle = mutant.module.handleRequest as Handle;
        assert.equal(await plant.holds(await aTeam({ handle })), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});
