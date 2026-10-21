import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { resetMemoryLinear, setMemoryIssueState } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, digest, redeemPairing } from './session.ts';

/**
 * `GET /session/sites` (FRU-295): where the notes of each site go, for a role that sees the tracker,
 * and how many notes of the person the team marked done and they did not confirm (FRU-294).
 */

const open = worlds();
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const DONE = { name: 'Done', type: 'completed' };

afterEach(() => resetMemoryLinear());

type Listed = {
  id: string;
  destination?: { label: string };
  toCheck?: number;
  notes?: Record<string, number>;
};

/** The access token of a session of the extension: a pairing in `workspace`, or the account's (FRU-238). */
async function sessionOf(world: World, who: { id: string; token: string }, workspace?: string): Promise<string> {
  if (workspace !== undefined) {
    const { code } = await createPairing(world.sessions, { subject: who.id, workspace });
    const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(redeemed.ok);

    return redeemed.session.accessToken;
  }
  // The extension asks, the person approves in the console, the extension claims.
  const asked = await callOn(world, 'POST', '/session/connect', { origin: EXTENSION, body: { browser: 'Chrome' } });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const shown = await callOn(world, 'GET', `/console/connect/${request}`, { token: who.token });
  const { word } = (await shown.json()) as { word: string };
  const approved = await callOn(world, 'POST', `/console/connect/${request}/approve`, {
    token: who.token,
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  await world.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const claimed = await callOn(world, 'POST', '/session/connect/claim', { origin: EXTENSION, body: { claim } });
  assert.equal(claimed.status, 200, await claimed.clone().text());

  return ((await claimed.json()) as { accessToken: string }).accessToken;
}

async function sitesOf(world: World, token: string): Promise<Listed[]> {
  const answer = await callOn(world, 'GET', '/session/sites', { origin: EXTENSION, token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return ((await answer.json()) as { sites: Listed[] }).sites;
}

/** A note on `PAGE` of `site`, sent with `token`: its id in the store. */
async function noteOf(world: World, site: string, id: string, token: string): Promise<string> {
  const seed = seedFixture({
    id,
    page: { url: PAGE, path: '/pricing', title: 'Pricing' },
    client: { id: site, name: 'Acme' },
  });
  const answer = await callOn(world, 'POST', '/feedback', {
    origin: ORIGIN,
    body: seed,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(answer.status, 201, await answer.clone().text());

  return ((await answer.json()) as { issue: { id: string } }).issue.id;
}

/** A read of the page, as a widget does it: what writes the stages, and the verdicts, in the index. */
async function readPage(world: World, site: string, token: string): Promise<void> {
  const answer = await callOn(world, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, {
    origin: ORIGIN,
    token,
  });
  assert.equal(answer.status, 200, await answer.clone().text());
}

/** Alice owns Acme and its site; Bob is a member; Carol is a guest the site is shared with. */
async function acme() {
  const opened = await open();
  // The requests of the extension that the console approves (FRU-238), on the database of the world.
  const world: World = { ...opened, context: { ...opened.context, connectStore: opened.connectStore } };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' });
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const carol = await signInTo(world, 'carol@client.fr');
  await memberOf(world, workspace, carol.id, 'guest');
  await shareWith(world, workspace, carol.id, [site.id]);

  return { world, workspace, site, alice, bob, carol };
}

describe('where the notes of a site go, in GET /session/sites (FRU-295)', () => {
  it('names the destination to a role that sees the tracker, and not to a guest', async () => {
    const { world, workspace, site, alice, carol } = await acme();
    const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.test', sealed: 'x' });
    assert.ok(
      await world.accounts.setDestinations(workspace, site.id, [{ connector: hook.id, label: 'Linear · Northwind' }]),
    );

    const [forOwner] = await sitesOf(world, await sessionOf(world, alice));
    const [forGuest] = await sitesOf(world, await sessionOf(world, carol));
    const [forPairing] = await sitesOf(world, await sessionOf(world, alice, workspace));

    assert.deepEqual(forOwner?.destination, { label: 'Linear · Northwind' });
    assert.deepEqual(forPairing?.destination, { label: 'Linear · Northwind' });
    // The control is the owner above, on the same site: the guest's absence is the guard's.
    assert.equal(forGuest?.id, site.id);
    assert.equal('destination' in (forGuest ?? {}), false);
  });

  it('names « Fruitback » for a site that keeps its notes in the worker', async () => {
    const { world, alice } = await acme();

    const [listed] = await sitesOf(world, await sessionOf(world, alice));

    assert.deepEqual(listed?.destination, { label: 'Fruitback' });
  });
});

describe('the fixes to check, in GET /session/sites (FRU-295)', () => {
  it('counts the done notes of the person, not those of another member, and drops by one after « Looks fixed »', async () => {
    const { world, site, alice, bob } = await acme();
    const bobs = await sessionOf(world, bob);
    const alices = await sessionOf(world, alice);
    const first = await noteOf(world, site.id, 'sd_bob_1', bobs);
    const second = await noteOf(world, site.id, 'sd_bob_2', bobs);
    const hers = await noteOf(world, site.id, 'sd_alice', alices);
    for (const id of [first, second, hers]) setMemoryIssueState(id, DONE);
    await readPage(world, site.id, bobs);

    assert.equal((await sitesOf(world, bobs))[0]?.toCheck, 2);
    assert.equal((await sitesOf(world, alices))[0]?.toCheck, 1);

    const checked = await callOn(world, 'POST', `/feedback/${first}/check?client=${site.id}`, {
      origin: ORIGIN,
      token: bobs,
      body: { url: PAGE, verdict: 'fixed' },
    });
    assert.equal(checked.status, 201, await checked.clone().text());

    assert.equal((await sitesOf(world, bobs))[0]?.toCheck, 1);
    // And a later read of the page, which sees the verdict in the replies, keeps it.
    await readPage(world, site.id, bobs);
    assert.equal((await sitesOf(world, bobs))[0]?.toCheck, 1);
  });

  it('counts a note again once the team marks it done after « Still wrong »', async () => {
    const { world, site, bob } = await acme();
    const bobs = await sessionOf(world, bob);
    const note = await noteOf(world, site.id, 'sd_bob', bobs);
    setMemoryIssueState(note, DONE);
    await readPage(world, site.id, bobs);

    const wrong = await callOn(world, 'POST', `/feedback/${note}/check?client=${site.id}`, {
      origin: ORIGIN,
      token: bobs,
      body: { url: PAGE, verdict: 'wrong' },
    });
    assert.equal(wrong.status, 201, await wrong.clone().text());
    assert.equal((await sitesOf(world, bobs))[0]?.toCheck, 0);

    setMemoryIssueState(note, DONE);
    await readPage(world, site.id, bobs);
    assert.equal((await sitesOf(world, bobs))[0]?.toCheck, 1);
  });

  it('counts no note of a site whose store takes no verdict, which nobody could lower', async () => {
    const { world, workspace, site, bob } = await acme();
    // An address that receives: the notes are kept by the worker and sent on, and no verdict is taken.
    const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.test', sealed: 'x' });
    assert.ok(await world.accounts.setDestinations(workspace, site.id, [{ connector: hook.id, label: 'Hook' }]));
    const bobs = await sessionOf(world, bob);
    const note = await noteOf(world, site.id, 'sd_bob', bobs);
    setMemoryIssueState(note, DONE);
    await readPage(world, site.id, bobs);
    const refused = await callOn(world, 'POST', `/feedback/${note}/check?client=${site.id}`, {
      origin: ORIGIN,
      token: bobs,
      body: { url: PAGE, verdict: 'fixed' },
    });
    assert.equal(refused.status, 403);

    const [listed] = await sitesOf(world, bobs);
    assert.equal(listed?.notes?.ripe, 1, 'the note is done in the index');
    assert.equal(listed?.toCheck, 0);
  });

  it('gives no count to a pairing of a workspace, and no count when the index does not answer', async () => {
    const { world, workspace, alice } = await acme();

    const [paired] = await sitesOf(world, await sessionOf(world, alice, workspace));
    assert.equal('toCheck' in (paired ?? {}), false);

    const [counted] = await sitesOf(world, await sessionOf(world, alice));
    assert.equal(counted?.toCheck, 0);

    await rowsOf(world.database, 'ALTER TABLE note_index RENAME TO note_index_gone');
    const [unknown] = await sitesOf(world, await sessionOf(world, alice));
    assert.equal('toCheck' in (unknown ?? {}), false);
  });
});
