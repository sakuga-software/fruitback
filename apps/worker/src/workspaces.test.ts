import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { type SessionIdentity, createPairing, redeemPairing, refreshSession } from './session.ts';
import { handleRequest } from './app.ts';
import { signIdentityToken, verifyIdentityToken } from './identity.ts';
import { checkWorkspace, runPair } from './cli.ts';

/**
 * One worker, several workspaces, and a session that reaches the sites of its own (FRU-95).
 *
 * Every session token of every workspace is signed with the one worker key. So the signature is not
 * what keeps workspace A off the sites of workspace B: the `ws` claim is. These tests are the proof
 * the ticket asks for, on the read and on the write, from a page and from the relay.
 */

const SECRET = 'a-worker-secret-of-exactly-enough';
const SITE_KEY = 'the-own-key-of-the-loose-client-site';
const RELAY_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const CLIENTS = {
  a: { workspace: 'ws-a', origins: ['https://a.test'], read: 'authenticated' },
  /** A site that mints its own tokens and also belongs to a workspace. */
  both: { workspace: 'ws-a', origins: ['https://both.test'], read: 'authenticated', identitySecret: SITE_KEY },
  b: { workspace: 'ws-b', origins: ['https://b.test'], read: 'authenticated' },
  loose: { origins: ['https://loose.test'], read: 'authenticated', identitySecret: SITE_KEY },
};

const directories: string[] = [];

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-workspaces-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_CLIENTS: JSON.stringify(CLIENTS),
    ...overrides,
  };
}

/** A session of one workspace, opened through the store and the real redemption. */
async function sessionOf(env: WorkerEnv, identity: SessionIdentity): Promise<{ access: string; refresh: string }> {
  const store = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
  const { code } = await createPairing(store, identity);
  const redeemed = await redeemPairing(store, code, SECRET);
  assert.ok(redeemed.ok);

  return { access: redeemed.session.accessToken, refresh: redeemed.session.refreshToken };
}

let nextIp = 0;

function read(env: WorkerEnv, client: string, origin: string, token?: string): Promise<Response> {
  const url = encodeURIComponent(`https://${client}.test/pricing`);
  const headers: Record<string, string> = { Origin: origin };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  nextIp += 1;

  return handleRequest(new Request(`https://worker.test/feedback?url=${url}&client=${client}`, { headers }), env, {
    clientIp: `198.51.100.${nextIp}`,
  });
}

function write(env: WorkerEnv, client: string, origin: string, token?: string): Promise<Response> {
  const seed = seedFixture();
  const body = {
    ...seed,
    page: { ...seed.page, url: `https://${client}.test/pricing` },
    client: { id: client },
  };
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  nextIp += 1;

  return handleRequest(
    new Request('https://worker.test/feedback', { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
    { clientIp: `198.51.100.${nextIp}` },
  );
}

afterEach(() => {
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('a session belongs to one workspace (FRU-95)', () => {
  it('carries its workspace from the pairing to the token, and through every refresh', async () => {
    const env = envWith();
    const session = await sessionOf(env, { subject: 'alice', workspace: 'ws-a' });

    const first = await verifyIdentityToken(session.access, SECRET);
    assert.ok(first.ok);
    assert.equal(first.workspace, 'ws-a');
    assert.equal('workspace' in first.reporter, false, 'the workspace is not part of what a seed stores');

    const store = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
    const refreshed = await refreshSession(store, session.refresh, SECRET);
    assert.ok(refreshed.ok);
    const second = await verifyIdentityToken(refreshed.accessToken, SECRET);
    assert.ok(second.ok);
    assert.equal(second.workspace, 'ws-a');
  });

  for (const [how, originOf] of [
    ['from the page', (client: string) => `https://${client}.test`],
    ['through the relay', () => RELAY_ORIGIN],
  ] as const) {
    it(`reads the sites of its workspace and no other, ${how}`, async () => {
      const env = envWith();
      const { access } = await sessionOf(env, { subject: 'alice', workspace: 'ws-a' });

      assert.equal((await read(env, 'a', originOf('a'), access)).status, 200);
      assert.equal((await read(env, 'b', originOf('b'), access)).status, 401);
      assert.equal((await read(env, 'b', originOf('b'))).status, 401, 'the control: no token is refused too');
    });

    it(`writes on the sites of its workspace and no other, ${how}`, async () => {
      const env = envWith();
      const { access } = await sessionOf(env, { subject: 'alice', name: 'Alice', workspace: 'ws-a' });

      const own = await write(env, 'a', originOf('a'), access);
      assert.equal(own.status, 201, await own.clone().text());
      const other = await write(env, 'b', originOf('b'), access);
      assert.equal(other.status, 401);
      assert.deepEqual(await other.json(), { error: 'invalid-identity', reason: 'invalid-claims' });
    });
  }

  it('lets the workspace B read its own site with its own session', async () => {
    const env = envWith();
    const { access } = await sessionOf(env, { subject: 'bob', workspace: 'ws-b' });

    assert.equal((await read(env, 'b', 'https://b.test', access)).status, 200);
    assert.equal((await read(env, 'a', 'https://a.test', access)).status, 401);
  });

  it('refuses a session token on a client that belongs to no workspace', async () => {
    const env = envWith();
    const { access } = await sessionOf(env, { subject: 'alice', workspace: 'ws-a' });
    const ownToken = await signIdentityToken({ sub: 'carol', exp: Math.floor(Date.now() / 1000) + 600 }, SITE_KEY);

    assert.equal((await read(env, 'loose', 'https://loose.test', access)).status, 401);
    assert.equal((await read(env, 'loose', 'https://loose.test', ownToken)).status, 200, 'its own key still works');
  });

  it('takes its own tokens and the sessions of its workspace, on a site that has both, and no other session', async () => {
    const env = envWith();
    const own = await signIdentityToken({ sub: 'carol', exp: Math.floor(Date.now() / 1000) + 600 }, SITE_KEY);
    const ofA = (await sessionOf(env, { subject: 'alice', workspace: 'ws-a' })).access;
    const ofB = (await sessionOf(env, { subject: 'bob', workspace: 'ws-b' })).access;

    assert.equal((await read(env, 'both', 'https://both.test', own)).status, 200);
    assert.equal((await read(env, 'both', 'https://both.test', ofA)).status, 200);
    assert.equal((await read(env, 'both', 'https://both.test', ofB)).status, 401);
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
    const env = envWith();
    const bare = await signIdentityToken({ sub: 'mallory', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);

    assert.equal((await read(env, 'a', 'https://a.test', bare)).status, 401);
  });
});

describe('the boot guards of a worker with workspaces (FRU-95)', () => {
  it('accepts sessions when a client declares a workspace', () => {
    const result = readConfig(envWith());

    assert.ok(result.ok, result.ok ? '' : result.missing.join(', '));
  });

  it('refuses sessions when no client declares a workspace, and names the map', () => {
    const result = readConfig(
      envWith({ FRUITBACK_CLIENTS: JSON.stringify({ acme: { origins: ['https://acme.test'] } }) }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.missing.some((name) => name.startsWith('FRUITBACK_CLIENTS')));
  });

  it('refuses a client whose own key is the worker key, because it would skip the workspace check', () => {
    const result = readConfig(
      envWith({
        FRUITBACK_CLIENTS: JSON.stringify({ ...CLIENTS, shared: { workspace: 'ws-a', identitySecret: SECRET } }),
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.missing.some((name) => name.includes('shared')));
  });

  it('still refuses an authenticated client with no key and no workspace', () => {
    const result = readConfig(
      envWith({ FRUITBACK_CLIENTS: JSON.stringify({ ...CLIENTS, orphan: { read: 'authenticated' } }) }),
    );

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

  it('mints a code whose session reads the sites of that workspace', async () => {
    const env = envWith();
    const outcome = await runPair(['--subject', 'alice', '--workspace', 'ws-a'], env);
    assert.ok(outcome.ok, outcome.lines.join('\n'));
    assert.match(outcome.lines[0] ?? '', /in the workspace ws-a/);

    const code = outcome.lines[2]?.trim() as string;
    const store = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);
    assert.equal((await read(env, 'a', 'https://a.test', redeemed.session.accessToken)).status, 200);
  });

  it('mints nothing without a workspace on a worker that has some', async () => {
    const outcome = await runPair(['--subject', 'alice'], envWith());

    assert.equal(outcome.ok, false);
    assert.match(outcome.lines.join('\n'), /--workspace is required/);
  });
});
