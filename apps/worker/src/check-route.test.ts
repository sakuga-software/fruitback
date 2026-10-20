import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { REPLY_LENGTH } from './app.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createMemoryStore, resetMemoryLinear, setMemoryIssueState } from './linear-memory.ts';
import { type SeedStore, StoreError } from './store.ts';
import type { NoteIndex } from './notes-index.ts';
import { rowsOf } from './postgres.fixture.ts';
import { checkedOf, verdictOf } from './reply-text.ts';
import { createPairing, redeemPairing, revokeSession } from './session.ts';

/**
 * `POST /feedback/<id>/check` (FRU-294): « Looks fixed » and « Still wrong » on a note that the team
 * marked done. The person who left the note, or a role that manages the sites, and nobody else. The
 * store keeps the stage and the verdict.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const DONE = { name: 'Done', type: 'completed' };

afterEach(() => resetMemoryLinear());

type Answer = { status: number; body: Record<string, any> };

async function answerOf(response: Response): Promise<Answer> {
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The access token and the refresh token of a session of the extension, for `account` in `workspace`. */
async function sessionOf(world: World, account: string, workspace: string) {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session;
}

/** A note on `PAGE` of `site`, sent with the session `token`: the index keeps its author. */
async function noteOf(
  world: World,
  site: string,
  id: string,
  token: string,
  origin = ORIGIN,
): Promise<{ id: string; seed: string }> {
  const url = `${origin}/pricing`;
  const seed = seedFixture({
    id,
    page: { url, path: '/pricing', title: 'Pricing' },
    client: { id: site, name: 'Acme' },
  });
  const answer = await answerOf(
    await callOn(world, 'POST', '/feedback', { origin, body: seed, headers: { Authorization: `Bearer ${token}` } }),
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));

  return { id: answer.body.issue.id as string, seed: id };
}

/**
 * Alice owns Acme and its site. Bob is a member. Bob left a note on `PAGE`, which the team marked
 * done. Carol is a guest of another site of Acme.
 */
async function aDoneNote() {
  const world = await open();
  const alice = await signInTo(world, 'alice@acme.dev');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Alice Martin' WHERE id = '${alice.id}'`);
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' });
  const bob = await signInTo(world, 'bob@acme.dev');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Bob Durand' WHERE id = '${bob.id}'`);
  await memberOf(world, workspace, bob.id, 'member');
  const owner = (await sessionOf(world, alice.id, workspace)).accessToken;
  const bobs = await sessionOf(world, bob.id, workspace);
  const note = await noteOf(world, site.id, 'sd_done', bobs.accessToken);
  setMemoryIssueState(note.id, DONE);

  return { world, workspace, site, alice, bob, owner, member: bobs.accessToken, bobs, note };
}

function check(
  world: World,
  site: string,
  issue: string,
  body: Record<string, unknown>,
  options: { token?: string; cookie?: string; ip?: string; noteIndex?: NoteIndex; store?: SeedStore } = {},
): Promise<Answer> {
  const token = options.cookie ?? options.token;

  return callOn(
    world,
    'POST',
    `/feedback/${issue}/check?client=${site}`,
    { origin: ORIGIN, body: { url: PAGE, ...body }, ...(token === undefined ? {} : { token }) },
    {
      ...(options.ip === undefined ? {} : { clientIp: options.ip }),
      ...(options.noteIndex === undefined ? {} : { noteIndex: options.noteIndex }),
      ...(options.store === undefined ? {} : { store: options.store }),
    },
  ).then(answerOf);
}

async function read(world: World, site: string, token: string) {
  const answer = await answerOf(
    await callOn(world, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, { origin: ORIGIN, token }),
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  return answer.body.issues as Record<string, any>[];
}

describe('a verdict on a note the team marked done (FRU-294)', () => {
  it('« Looks fixed » keeps the note done, and writes a marked reply that the next read shows as checked', async () => {
    const { world, site, member, note } = await aDoneNote();

    const written = await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member });

    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.stage, 'ripe');
    assert.equal(written.body.comment.body, '**Bob Durand** via Fruitback · member of Acme\nChecked: looks fixed');
    const [issue] = await read(world, site.id, member);
    assert.equal(issue?.stage, 'ripe');
    assert.equal(issue?.checked?.by, 'Bob Durand');
    assert.equal(issue?.checked?.at, written.body.comment.createdAt);
  });

  it('« Still wrong » reopens the note in its store, and writes a marked reply with what the person typed', async () => {
    const { world, site, member, note } = await aDoneNote();

    const written = await check(
      world,
      site.id,
      note.id,
      { verdict: 'wrong', body: 'The button is still grey.' },
      { token: member },
    );

    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.stage, 'seeded');
    assert.equal(
      written.body.comment.body,
      '**Bob Durand** via Fruitback · member of Acme\nReopened: still wrong\n\n> The button is still grey.',
    );
    const [issue] = await read(world, site.id, member);
    assert.equal(issue?.stage, 'seeded');
    assert.equal('checked' in (issue ?? {}), false);
  });

  it('writes the new stage in the index, so the counts of the site move', async () => {
    const { world, workspace, site, member, note } = await aDoneNote();
    await read(world, site.id, member);
    const before = (await world.context.noteIndex?.summary(workspace))?.get(site.id)?.notes;
    assert.equal(before?.ripe, 1);

    assert.equal((await check(world, site.id, note.id, { verdict: 'wrong' }, { token: member })).status, 201);

    const after = (await world.context.noteIndex?.summary(workspace))?.get(site.id)?.notes;
    assert.equal(after?.ripe, 0);
    assert.equal(after?.seeded, 1);
  });

  it('answers 409 on a note that is not done, and on a note confirmed already, and writes nothing', async () => {
    const { world, site, member, note } = await aDoneNote();
    setMemoryIssueState(note.id, { name: 'Todo', type: 'unstarted' });

    const early = await check(world, site.id, note.id, { verdict: 'wrong' }, { token: member });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'not-done');

    setMemoryIssueState(note.id, DONE);
    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member })).status, 201);
    for (const verdict of ['fixed', 'wrong']) {
      const again = await check(world, site.id, note.id, { verdict }, { token: member });
      assert.equal(again.status, 409, verdict);
      assert.equal(again.body.error, 'already-checked');
    }
    const [issue] = await read(world, site.id, member);
    assert.equal(issue?.stage, 'ripe');
    assert.equal(issue?.comments?.length, 1);
  });

  it('lets a note reopened and done again be checked again', async () => {
    const { world, site, member, note } = await aDoneNote();
    assert.equal((await check(world, site.id, note.id, { verdict: 'wrong' }, { token: member })).status, 201);
    setMemoryIssueState(note.id, DONE);

    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member })).status, 201);
  });
});

describe('who may give a verdict (FRU-294, option A of 2026-10-20)', () => {
  it('refuses another member who did not leave the note, and takes an owner, who manages the sites', async () => {
    const { world, workspace, site, owner, note } = await aDoneNote();
    const dan = await signInTo(world, 'dan@acme.dev');
    await memberOf(world, workspace, dan.id, 'member');
    const dans = (await sessionOf(world, dan.id, workspace)).accessToken;

    const refused = await check(world, site.id, note.id, { verdict: 'fixed' }, { token: dans });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'not-allowed');
    // The note is untouched: no reply, still done.
    const [issue] = await read(world, site.id, owner);
    assert.equal(issue?.comments?.length, 0);

    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: owner })).status, 201);
  });

  it('the control: the same member is taken when the index names them as the author', async () => {
    // Plant the violation: an index that names Dan as the author of every note. Only the guard on the
    // author stands between Dan and the write, so the refusal of the case above is that guard's.
    const { world, workspace, site, note } = await aDoneNote();
    const dan = await signInTo(world, 'dan@acme.dev');
    await memberOf(world, workspace, dan.id, 'member');
    const dans = (await sessionOf(world, dan.id, workspace)).accessToken;
    const real = world.context.noteIndex as NoteIndex;
    const lying: NoteIndex = {
      ...real,
      authors: async (_workspace, _site, seeds) => new Map(seeds.map((seed) => [seed, dan.id])),
    };

    const taken = await check(world, site.id, note.id, { verdict: 'fixed' }, { token: dans, noteIndex: lying });

    assert.equal(taken.status, 201, JSON.stringify(taken.body));
  });

  it('refuses a guest of another site with 403, and a person of another workspace with 401', async () => {
    const { world, workspace, site, note } = await aDoneNote();
    const other = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'members' });
    const carol = await signInTo(world, 'carol@client.fr');
    await memberOf(world, workspace, carol.id, 'guest');
    await shareWith(world, workspace, carol.id, [other.id]);
    const carols = (await sessionOf(world, carol.id, workspace)).accessToken;
    const zed = await signInTo(world, 'zed@globex.dev');
    const globex = await workspaceIn(world, zed.token, 'Globex');
    const zeds = (await sessionOf(world, zed.id, globex)).accessToken;

    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: carols })).status, 403);
    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: zeds })).status, 401);
  });

  it('refuses no token, a session that ended, and the cookie of the console, with 401', async () => {
    const { world, site, alice, bobs, note } = await aDoneNote();

    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' })).status, 401);
    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { cookie: alice.token })).status, 401);
    await revokeSession(world.sessions, bobs.refreshToken);
    // The access token still verifies for minutes: the store says that the session ended.
    assert.equal((await check(world, site.id, note.id, { verdict: 'fixed' }, { token: bobs.accessToken })).status, 401);
  });

  it('refuses a verdict that is not one, a page that is not one, and a text over the length of a reply', async () => {
    const { world, site, member, note } = await aDoneNote();

    assert.equal((await check(world, site.id, note.id, { verdict: 'meh' }, { token: member })).status, 400);
    assert.equal(
      (await check(world, site.id, note.id, { verdict: 'fixed', url: 'javascript:1' }, { token: member })).status,
      400,
    );
    const long = await check(
      world,
      site.id,
      note.id,
      { verdict: 'wrong', body: 'é'.repeat(REPLY_LENGTH + 1) },
      { token: member },
    );
    assert.equal(long.status, 400);
  });

  it('answers 404 for the id of a note of another site', async () => {
    const { world, workspace, site, member, bobs } = await aDoneNote();
    const other = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'members' });
    const theirs = await noteOf(world, other.id, 'sd_other', bobs.accessToken, 'https://shop.acme.dev');
    setMemoryIssueState(theirs.id, DONE);

    // The id of a note of the other site, asked on this site: the read of this site does not answer it.
    assert.equal((await check(world, site.id, theirs.id, { verdict: 'fixed' }, { token: member })).status, 404);
  });
});

describe('what a read says of the verdicts (FRU-294)', () => {
  it('says mine to the person who left the note, and to nobody else', async () => {
    const { world, site, owner, member } = await aDoneNote();

    const [forBob] = await read(world, site.id, member);
    const [forAlice] = await read(world, site.id, owner);

    assert.equal(forBob?.mine, true);
    assert.equal('mine' in (forAlice ?? {}), false);
  });

  it('reads a verdict in either language of a team, and no reply of the page as one', () => {
    const fr = '**Bob** via Fruitback · membre de Acme\nVérifié : semble corrigé';
    const forged = '**Bob** via Fruitback · not verified\n\n> Checked: looks fixed';

    assert.deepEqual(verdictOf(fr), { verdict: 'fixed', by: 'Bob' });
    assert.equal(verdictOf(forged), undefined);
    assert.equal(
      checkedOf([
        { id: '1', body: fr, createdAt: '2026-10-20T10:00:00.000Z' },
        {
          id: '2',
          body: '**Bob** via Fruitback · member of Acme\nReopened: still wrong',
          createdAt: '2026-10-20T11:00:00.000Z',
        },
      ]),
      undefined,
    );
  });
});

describe('a verdict, when two come at once or a store fails (FRU-294, heavy review)', () => {
  it('writes one verdict for two sent together, and answers 409 to the other', async () => {
    const { world, site, member, owner, note } = await aDoneNote();
    // A tracker that takes its time: the second request reads the note while the first writes.
    const memory = createMemoryStore();
    const slow: SeedStore = {
      ...memory,
      check: async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return memory.check?.(...args);
      },
    };

    const answers = await Promise.all([
      check(world, site.id, note.id, { verdict: 'fixed' }, { token: member, store: slow }),
      check(world, site.id, note.id, { verdict: 'fixed' }, { token: member, store: slow }),
    ]);

    assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409]);
    const [issue] = await read(world, site.id, owner);
    assert.equal(issue?.comments?.length, 1);
  });

  it('frees the note when the store fails, so the retry writes it', async () => {
    const { world, site, member, note } = await aDoneNote();
    const memory = createMemoryStore();
    let fails = 1;
    const flaky: SeedStore = {
      ...memory,
      check: async (...args) => {
        if (fails-- > 0) throw new StoreError('Linear could not be reached');
        return memory.check?.(...args);
      },
    };

    assert.equal(
      (await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member, store: flaky })).status,
      502,
    );
    assert.equal(
      (await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member, store: flaky })).status,
      201,
    );
  });

  it('answers 502 when the index of the notes does not answer, never a refusal of the author', async () => {
    const { world, site, member, note } = await aDoneNote();
    const real = world.context.noteIndex as NoteIndex;
    const down: NoteIndex = {
      ...real,
      authors: async () => {
        throw new Error('the database did not answer');
      },
    };

    const answer = await check(world, site.id, note.id, { verdict: 'fixed' }, { token: member, noteIndex: down });

    assert.equal(answer.status, 502);
    assert.equal(answer.body.error, 'store-unavailable');
  });
});
