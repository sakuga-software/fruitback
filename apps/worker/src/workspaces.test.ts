import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { IDENTITY_SECRET } from './auth-worker.fixture.ts';
import { type World, callOn, memberOf, signInTo, worlds } from './console-world.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { type SessionIdentity, createPairing, redeemPairing, refreshSession } from './session.ts';
import { signIdentityToken, verifyIdentityToken } from './identity.ts';
import { checkWorkspace, runPair } from './cli.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/**
 * One worker, several workspaces, and a session that reaches the sites of its own (FRU-95).
 *
 * Every session token of every workspace is signed with the one worker key. So the signature is not
 * what keeps workspace A off the sites of workspace B: the `ws` claim is. These tests are the proof
 * the ticket asks for, on the read and on the write, from a page and from the relay. The sites are
 * the ones of the database (FRU-226): a worker with no database keeps no session.
 */

const RELAY_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const world = worlds();

type Workspaces = {
  world: World;
  alice: string;
  bob: string;
  /** The workspace of each letter, and its site. */
  a: { workspace: string; site: string };
  b: { workspace: string; site: string };
};

/**
 * Alice owns the workspace A and Bob the workspace B. Each workspace has one site for its members.
 * Alice is a member of B too: only the `ws` claim of her session keeps it off the site of B.
 */
async function twoWorkspaces(): Promise<Workspaces> {
  const opened = await world();
  const alice = (await signInTo(opened, 'alice@acme.dev')).id;
  const bob = (await signInTo(opened, 'bob@acme.dev')).id;
  const of = async (letter: string, owner: string) => {
    const workspace = await opened.accounts.createWorkspace(`Workspace ${letter}`, owner);
    const site = await opened.accounts.addSite(workspace.id, {
      origin: `https://${letter}.test`,
      visibility: 'members',
    });

    return { workspace: workspace.id, site: site.id };
  };

  const a = await of('a', alice);
  const b = await of('b', bob);
  await memberOf(opened, b.workspace, alice, 'member');

  return { world: opened, alice, bob, a, b };
}

/** A session of one workspace, opened through the store and the real redemption. */
async function sessionOf(opened: World, identity: SessionIdentity): Promise<{ access: string; refresh: string }> {
  const { code } = await createPairing(opened.sessions, identity);
  const redeemed = await redeemPairing(opened.sessions, code, IDENTITY_SECRET);
  assert.ok(redeemed.ok);

  return { access: redeemed.session.accessToken, refresh: redeemed.session.refreshToken };
}

function read(opened: World, site: string, origin: string, page: string, token?: string): Promise<Response> {
  const url = encodeURIComponent(`${page}/pricing`);

  return callOn(opened, 'GET', `/feedback?url=${url}&client=${site}`, {
    origin,
    ...(token === undefined ? {} : { token }),
  });
}

function write(opened: World, site: string, origin: string, page: string, token?: string): Promise<Response> {
  const seed = noteFixture();
  const body = { ...seed, page: { ...seed.page, url: `${page}/pricing` }, client: { id: site } };

  return callOn(opened, 'POST', '/feedback', { origin, body, ...(token === undefined ? {} : { token }) });
}

describe('a session belongs to one workspace (FRU-95)', () => {
  it('carries its workspace from the pairing to the token, and through every refresh', async () => {
    const { world: opened, alice, a } = await twoWorkspaces();
    const session = await sessionOf(opened, { subject: alice, workspace: a.workspace });

    const first = await verifyIdentityToken(session.access, IDENTITY_SECRET);
    assert.ok(first.ok);
    assert.equal(first.workspace, a.workspace);
    assert.equal('workspace' in first.reporter, false, 'the workspace is not part of what a seed stores');

    const refreshed = await refreshSession(opened.sessions, session.refresh, IDENTITY_SECRET);
    assert.ok(refreshed.ok);
    const second = await verifyIdentityToken(refreshed.accessToken, IDENTITY_SECRET);
    assert.ok(second.ok);
    assert.equal(second.workspace, a.workspace);
  });

  for (const [how, originOf] of [
    ['from the page', (letter: string) => `https://${letter}.test`],
    ['through the relay', () => RELAY_ORIGIN],
  ] as const) {
    it(`reads the sites of its workspace and no other, ${how}`, async () => {
      const { world: opened, alice, a, b } = await twoWorkspaces();
      const { access } = await sessionOf(opened, { subject: alice, workspace: a.workspace });

      assert.equal((await read(opened, a.site, originOf('a'), 'https://a.test', access)).status, 200);
      assert.equal((await read(opened, b.site, originOf('b'), 'https://b.test', access)).status, 401);
      assert.equal(
        (await read(opened, b.site, originOf('b'), 'https://b.test')).status,
        401,
        'the control: no token is refused too',
      );
    });

    it(`writes on the sites of its workspace and no other, ${how}`, async () => {
      const { world: opened, alice, a, b } = await twoWorkspaces();
      const { access } = await sessionOf(opened, { subject: alice, name: 'Alice', workspace: a.workspace });

      const own = await write(opened, a.site, originOf('a'), 'https://a.test', access);
      assert.equal(own.status, 201, await own.clone().text());
      const other = await write(opened, b.site, originOf('b'), 'https://b.test', access);
      assert.equal(other.status, 401);
      assert.deepEqual(await other.json(), { error: 'invalid-identity', reason: 'invalid-claims' });
    });
  }

  it('lets the workspace B read its own site with its own session', async () => {
    const { world: opened, bob, a, b } = await twoWorkspaces();
    const { access } = await sessionOf(opened, { subject: bob, workspace: b.workspace });

    assert.equal((await read(opened, b.site, 'https://b.test', 'https://b.test', access)).status, 200);
    assert.equal((await read(opened, a.site, 'https://a.test', 'https://a.test', access)).status, 401);
  });

  /**
   * The workspace check holds only if every token goes through it. A second caller of the verifier in
   * the request path would accept any session token whose signature is good. Raised in review.
   */
  it('verifies every token of a request in one place, the one that checks the workspace', () => {
    const source = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function verifyForClient('));
    const end = body.indexOf('\n}\n');

    assert.equal(source.split('verifyIdentityToken(').length - 1, 2, 'the verifier is called twice in app.ts');
    assert.equal(
      body.slice(0, end).split('verifyIdentityToken(').length - 1,
      2,
      'and both calls are in verifyForClient',
    );
  });

  it('refuses a token signed with the worker key that names no workspace', async () => {
    const { world: opened, alice, a } = await twoWorkspaces();
    const bare = await signIdentityToken({ sub: alice, exp: Math.floor(Date.now() / 1000) + 600 }, IDENTITY_SECRET);

    assert.equal((await read(opened, a.site, 'https://a.test', 'https://a.test', bare)).status, 401);
    // The control: the same person, with a session of the workspace, reads.
    const { access } = await sessionOf(opened, { subject: alice, workspace: a.workspace });
    assert.equal((await read(opened, a.site, 'https://a.test', 'https://a.test', access)).status, 200);
  });
});

/** The worker of before, with its sites in `FRUITBACK_CLIENTS`. It keeps no session since FRU-226. */
function envOfClients(clients: Record<string, unknown>): WorkerEnv {
  return beforePostgres({
    FRUITBACK_STORE: 'memory',
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    FRUITBACK_CLIENTS: JSON.stringify(clients),
  });
}

const PUBLIC_CLIENTS = {
  a: { workspace: 'ws-a', origins: ['https://a.test'], read: 'public' },
  b: { workspace: 'ws-b', origins: ['https://b.test'], read: 'public' },
};

describe('the boot guards of a worker with workspaces (FRU-95)', () => {
  it('still refuses an authenticated client with no key and no workspace', () => {
    const result = readConfig(envOfClients({ ...PUBLIC_CLIENTS, orphan: { read: 'authenticated' } }));

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.missing.some((name) => name.includes('orphan')));
  });
});

describe('pair --workspace (FRU-95)', () => {
  it('requires a workspace a client declares, on a worker that has some', () => {
    assert.match(checkWorkspace(undefined, ['ws-a', 'ws-b']) ?? '', /required: one of ws-a, ws-b/);
    assert.match(checkWorkspace('ws-c', ['ws-a', 'ws-b']) ?? '', /no client declares the workspace ws-c/);
    assert.equal(checkWorkspace('ws-a', ['ws-a', 'ws-b']), undefined);
  });

  it('refuses a workspace on a worker that has none, and accepts no workspace there', () => {
    assert.match(checkWorkspace('ws-a', []) ?? '', /needs FRUITBACK_CLIENTS/);
    assert.equal(checkWorkspace(undefined, []), undefined);
  });

  it('mints nothing without a workspace on a worker that has some', async () => {
    const outcome = await runPair(['--subject', 'alice'], envOfClients(PUBLIC_CLIENTS));

    assert.equal(outcome.ok, false);
    assert.match(outcome.lines.join('\n'), /--workspace is required/);
  });
});

/** The code a run of `pair` printed, on the line of four spaces. */
function codeIn(lines: readonly string[]): string | undefined {
  return lines.find((line) => /^ {4}[0-9A-Z]{4}-/.test(line))?.trim();
}

describe('the pair command on a worker with a database (FRU-277)', () => {
  it('mints a code for a workspace of the database, whose session reads its site and no other', async () => {
    const { world: opened, alice, a, b } = await twoWorkspaces();
    const outcome = await runPair(
      ['--subject', alice, '--workspace', a.workspace],
      opened.env,
      opened.sessions,
      opened.accounts,
    );
    assert.ok(outcome.ok, outcome.lines.join('\n'));
    assert.match(outcome.lines.join('\n'), new RegExp(`in the workspace ${a.workspace}`));

    const code = codeIn(outcome.lines);
    assert.ok(code !== undefined, outcome.lines.join('\n'));
    const redeemed = await redeemPairing(opened.sessions, code, IDENTITY_SECRET);
    assert.ok(redeemed.ok);
    const access = redeemed.session.accessToken;

    assert.equal((await read(opened, a.site, 'https://a.test', 'https://a.test', access)).status, 200);
    assert.equal((await read(opened, b.site, 'https://b.test', 'https://b.test', access)).status, 401);
  });

  it('mints nothing without a workspace, and names the workspaces that have a site', async () => {
    const { world: opened, alice, a, b } = await twoWorkspaces();
    const outcome = await runPair(['--subject', alice], opened.env, opened.sessions, opened.accounts);

    assert.equal(outcome.ok, false);
    assert.equal(codeIn(outcome.lines), undefined);
    const said = outcome.lines.join('\n');
    assert.match(said, /--workspace is required: one of/);
    assert.ok(said.includes(a.workspace) && said.includes(b.workspace), said);
  });

  it('mints nothing for somebody who is not a member of the workspace, whose code the route would refuse', async () => {
    const { world: opened, bob, a } = await twoWorkspaces();
    const outcome = await runPair(
      ['--subject', bob, '--workspace', a.workspace],
      opened.env,
      opened.sessions,
      opened.accounts,
    );

    assert.equal(outcome.ok, false);
    assert.equal(codeIn(outcome.lines), undefined);
    assert.match(outcome.lines.join('\n'), /must be the id of an account that is a member of the workspace/);
  });

  it('mints nothing for a workspace that has no site on this worker', async () => {
    const { world: opened, alice } = await twoWorkspaces();
    const outcome = await runPair(
      ['--subject', alice, '--workspace', 'ws_nobody'],
      opened.env,
      opened.sessions,
      opened.accounts,
    );

    assert.equal(outcome.ok, false);
    assert.equal(codeIn(outcome.lines), undefined);
    assert.match(outcome.lines.join('\n'), /no site belongs to the workspace ws_nobody/);
  });

  it('mints nothing on a worker with no site yet, and says to add one first', async () => {
    const opened = await world();
    const outcome = await runPair(['--subject', 'alice'], opened.env, opened.sessions, opened.accounts);

    assert.equal(outcome.ok, false);
    assert.equal(codeIn(outcome.lines), undefined);
    assert.match(outcome.lines.join('\n'), /no workspace of this worker has a site yet: add a site in the console/);
  });
});
