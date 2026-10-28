import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it, vi } from 'vitest';
import {
  type World,
  callOn,
  memberOf,
  signInTo,
  workspaceIn,
  worlds,
  WORKER,
  CONSOLE,
} from './console-world.fixture.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { handleMcp } from './mcp.ts';
import { ACCESS_SECONDS, REGISTRATIONS_PER_ADDRESS, UNAPPROVED_CLIENT_MS } from './oauth.ts';
import { rowsOf } from './postgres.fixture.ts';
import { noteFixture } from '@fruitback/shared/note.fixture';

/**
 * OAuth for `/mcp` (FRU-467): discovery, registration, the consent of a person in the console, the
 * code with PKCE, the tokens and their rotation, and every way a connection ends. Through
 * `handleRequest`, as a connector of claude.ai calls it.
 */

const open = worlds();

afterEach(() => resetMemoryLinear());

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = `${WORKER}/mcp`;

const verifier = 'v'.repeat(20) + '-._~' + 'A1'.repeat(12);
const challengeOf = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Alice owns Acme with `shop` and `blog`; Bob is a plain member there. */
async function acme() {
  const world = await open();
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const shop = await world.accounts.addSite(workspace, {
    origin: 'https://shop.acme.dev',
    visibility: 'members',
    writers: 'anyone',
  });
  const blog = await world.accounts.addSite(workspace, {
    origin: 'https://blog.acme.dev',
    visibility: 'members',
    writers: 'anyone',
  });
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');

  return { world, alice, bob, workspace, shop, blog };
}

function register(world: World, body: Record<string, unknown>, ip?: string): Promise<Response> {
  return callOn(world, 'POST', '/oauth/register', { origin: null, body }, ip === undefined ? {} : { clientIp: ip });
}

function form(world: World, path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return callOn(world, 'POST', path, {
    origin: null,
    raw: {
      bytes: new TextEncoder().encode(new URLSearchParams(values).toString()),
      type: 'application/x-www-form-urlencoded',
    },
    headers,
  });
}

/** A public client of claude.ai, registered. */
async function claude(world: World, more: Record<string, unknown> = {}): Promise<any> {
  const made = await register(world, {
    client_name: 'Claude',
    redirect_uris: [CALLBACK],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    ...more,
  });
  assert.equal(made.status, 201, await made.clone().text());

  return made.json();
}

function authorizeUrl(client: string, more: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: CALLBACK,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    state: 'the-state',
    scope: 'read write',
    resource: RESOURCE,
    ...more,
  });
  for (const [name, value] of Object.entries(more)) if (value === '') query.delete(name);

  return `/oauth/authorize?${query.toString()}`;
}

/** Starts an authorization, and answers the id of the request the console reads. */
async function authorize(world: World, client: string, more: Record<string, string> = {}): Promise<string> {
  const started = await callOn(world, 'GET', authorizeUrl(client, more), { origin: null });
  assert.equal(started.status, 302, await started.clone().text());
  const location = new URL(started.headers.get('Location') as string);
  assert.equal(location.origin, CONSOLE);
  const [, , id] = location.pathname.split('/');

  return id as string;
}

async function approve(
  world: World,
  token: string,
  account: string,
  request: string,
  choice: Record<string, unknown>,
): Promise<Response> {
  return callOn(world, 'POST', `/console/oauth/requests/${request}/approve`, {
    token,
    body: { account, rights: 'read', ...choice },
  });
}

/** The code in the address the console sends the browser back to, after its other parameters were checked. */
function codeOf(redirect: string): string {
  const url = new URL(redirect);
  assert.equal(`${url.origin}${url.pathname}`, CALLBACK);
  assert.equal(url.searchParams.get('state'), 'the-state');
  assert.equal(url.searchParams.get('iss'), WORKER);

  return url.searchParams.get('code') as string;
}

async function exchange(
  world: World,
  client: string,
  code: string,
  more: Record<string, string> = {},
): Promise<Response> {
  return form(world, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK,
    client_id: client,
    code_verifier: verifier,
    resource: RESOURCE,
    ...more,
  });
}

/** The whole way, from the registration to a pair of tokens: what a connector of claude.ai does. */
async function connected(choice: Record<string, unknown> = {}) {
  const setting = await acme();
  const { world, alice, workspace, shop } = setting;
  const client = await claude(world);
  const request = await authorize(world, client.client_id);
  const approved = await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id], ...choice });
  assert.equal(approved.status, 200, await approved.clone().text());
  const { redirect, key } = (await approved.json()) as { redirect: string; key: string };
  const exchanged = await exchange(world, client.client_id, codeOf(redirect));
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = (await exchanged.json()) as Record<string, any>;

  return { ...setting, client, key, tokens };
}

let next = 1;

async function mcp(world: World, token: string | undefined, method = 'ping', params: Record<string, unknown> = {}) {
  const answer = await callOn(world, 'POST', '/mcp', {
    origin: null,
    ...(token === undefined ? {} : { token }),
    body: { jsonrpc: '2.0', id: next++, method, params },
  });
  const text = await answer.text();

  return { status: answer.status, body: text === '' ? undefined : JSON.parse(text), headers: answer.headers };
}

describe('discovery (RFC 9728, RFC 8414)', () => {
  it('names this worker as the server of authorization of /mcp, with PKCE S256 only', async () => {
    const { world } = await acme();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const read = await callOn(world, 'GET', path, { origin: 'https://claude.ai' });
      assert.equal(read.status, 200, path);
      assert.equal(read.headers.get('Access-Control-Allow-Origin'), 'https://claude.ai');
      assert.deepEqual(await read.json(), {
        resource: RESOURCE,
        authorization_servers: [WORKER],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
        resource_name: 'Fruitback',
      });
    }

    const server = (await (
      await callOn(world, 'GET', '/.well-known/oauth-authorization-server', { origin: null })
    ).json()) as any;
    assert.equal(server.issuer, WORKER);
    assert.equal(server.authorization_endpoint, `${WORKER}/oauth/authorize`);
    assert.equal(server.token_endpoint, `${WORKER}/oauth/token`);
    assert.equal(server.registration_endpoint, `${WORKER}/oauth/register`);
    assert.equal(server.revocation_endpoint, `${WORKER}/oauth/revoke`);
    assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(server.response_types_supported, ['code']);
    assert.equal(server.authorization_response_iss_parameter_supported, true);
  });

  it('answers 401 at /mcp with the address of the metadata, and invalid_token for a token it refuses', async () => {
    const { world } = await acme();
    const none = await mcp(world, undefined);
    assert.equal(none.status, 401);
    assert.equal(
      none.headers.get('WWW-Authenticate'),
      `Bearer resource_metadata="${WORKER}/.well-known/oauth-protected-resource/mcp"`,
    );
    const refused = await mcp(world, `fba_${'A'.repeat(43)}`);
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('WWW-Authenticate') as string, /, error="invalid_token"$/);
  });

  it('answers 404 at /mcp, as before, when OAuth is off', async () => {
    const answer = await handleMcp(new Request(`${WORKER}/mcp`, { method: 'POST', body: '{}' }), {
      grantOf: async () => undefined,
      suspended: async () => false,
      used: async () => {},
      tools: () => [],
    });
    assert.equal(answer.status, 404);
    assert.equal(answer.headers.get('WWW-Authenticate'), null);
  });
});

describe('registration (RFC 7591)', () => {
  it('registers a public client, and gives a secret only to a client that asks for one', async () => {
    const { world } = await acme();
    const client = await claude(world);
    assert.match(client.client_id, /^fbo_[A-Za-z0-9_-]{22}$/);
    assert.equal(client.client_secret, undefined);
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.deepEqual(client.redirect_uris, [CALLBACK]);

    // RFC 7591: with no method, the default is client_secret_basic, so the client gets a secret.
    const confidential = (await (await register(world, { redirect_uris: [CALLBACK] })).json()) as any;
    assert.match(confidential.client_secret, /^fbs_/);
    assert.equal(confidential.client_name, 'claude.ai', 'a client with no name is named by its host');
    const [row] = await rowsOf(
      world.database,
      `SELECT secret_hash FROM oauth_clients WHERE id = '${confidential.client_id}'`,
    );
    assert.notEqual(row?.secret_hash, confidential.client_secret, 'the secret is kept as a digest');
  });

  it('refuses an address that is not https, a fragment, two hosts, and a method it does not know', async () => {
    const { world } = await acme();
    for (const redirect_uris of [
      [],
      ['http://claude.ai/cb'],
      ['https://claude.ai/cb#x'],
      ['https://user:pw@claude.ai/cb'],
      ['javascript:alert(1)'],
      ['https://claude.ai/cb', 'https://evil.dev/cb'],
      Array.from({ length: 6 }, (_, i) => `https://claude.ai/${i}`),
    ]) {
      const refused = await register(world, { redirect_uris, token_endpoint_auth_method: 'none' });
      assert.equal(refused.status, 400, JSON.stringify(redirect_uris));
      assert.equal(((await refused.json()) as any).error, 'invalid_redirect_uri');
    }
    for (const loopback of ['http://localhost:33418/callback', 'http://127.0.0.1:9/cb']) {
      assert.equal(
        (await register(world, { redirect_uris: [loopback], token_endpoint_auth_method: 'none' })).status,
        201,
      );
    }
    const method = await register(world, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'private_key_jwt' });
    assert.equal(method.status, 400);
    const implicit = await register(world, { redirect_uris: [CALLBACK], response_types: ['token'] });
    assert.equal(implicit.status, 400);
  });

  it('registers 10 clients an hour from one address, and deletes the stale ones nobody approved', async () => {
    assert.equal(REGISTRATIONS_PER_ADDRESS, 10, 'the name of this case, and SECURITY.md, say 10');
    const { world } = await acme();
    for (let made = 0; made < REGISTRATIONS_PER_ADDRESS; made += 1) {
      assert.equal((await register(world, { redirect_uris: [CALLBACK] }, '203.0.113.9')).status, 201);
    }
    assert.equal((await register(world, { redirect_uris: [CALLBACK] }, '203.0.113.9')).status, 429);
    assert.equal((await register(world, { redirect_uris: [CALLBACK] }, '203.0.113.10')).status, 201);

    await rowsOf(world.database, `UPDATE oauth_clients SET created_at = ${Date.now() - UNAPPROVED_CLIENT_MS - 1}`);
    assert.equal((await register(world, { redirect_uris: [CALLBACK] }, '203.0.113.11')).status, 201);
    const [left] = await rowsOf(world.database, 'SELECT count(*)::int AS n FROM oauth_clients');
    assert.equal(left?.n, 1);
  });
});

describe('the authorization request', () => {
  it('never sends a browser to an address the client did not register: a page says why', async () => {
    const { world } = await acme();
    const client = await claude(world);
    for (const url of [
      authorizeUrl(client.client_id, { redirect_uri: 'https://evil.dev/cb' }),
      authorizeUrl(client.client_id, { redirect_uri: `${CALLBACK}/` }),
      authorizeUrl(client.client_id, { redirect_uri: CALLBACK.toUpperCase() }),
      authorizeUrl('fbo_' + 'A'.repeat(22)),
    ]) {
      const refused = await callOn(world, 'GET', url, { origin: null });
      assert.equal(refused.status, 400, url);
      assert.equal(refused.headers.get('Location'), null);
    }
  });

  it('sends the client back with an error for no PKCE, plain PKCE, another scope or another resource', async () => {
    const { world } = await acme();
    const client = await claude(world);
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge: '', code_challenge_method: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain', code_challenge: verifier }, 'invalid_request'],
      [{ scope: 'read admin' }, 'invalid_scope'],
      [{ resource: 'https://other.dev/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [more, error] of cases) {
      const refused = await callOn(world, 'GET', authorizeUrl(client.client_id, more), { origin: null });
      assert.equal(refused.status, 302, JSON.stringify(more));
      const back = new URL(refused.headers.get('Location') as string);
      assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
      assert.equal(back.searchParams.get('error'), error);
      assert.equal(back.searchParams.get('state'), 'the-state');
      assert.equal(back.searchParams.get('iss'), WORKER);
    }
  });
});

describe('the consent of a person (FRU-467)', () => {
  it('shows the host of the client, its name, and the workspaces the person manages, with their sites', async () => {
    const { world, alice, bob, workspace, shop, blog } = await acme();
    const client = await claude(world);
    const request = await authorize(world, client.client_id, { scope: 'read' });

    const read = await callOn(world, 'GET', `/console/oauth/requests/${request}`, { token: alice.token });
    assert.equal(read.status, 200);
    const shown = (await read.json()) as any;
    assert.deepEqual(shown.client, { name: 'Claude', host: 'claude.ai' });
    assert.deepEqual(shown.scopes, ['read']);
    assert.equal(shown.redirectUri, CALLBACK);
    assert.deepEqual(
      shown.workspaces.map((each: any) => [each.id, each.sites.map((site: any) => site.id)]),
      [[workspace, [shop.id, blog.id]]],
    );

    // A plain member manages no workspace: nothing to choose, and an approval is refused.
    const asBob = (await (
      await callOn(world, 'GET', `/console/oauth/requests/${request}`, { token: bob.token })
    ).json()) as any;
    assert.deepEqual(asBob.workspaces, []);
    assert.equal((await approve(world, bob.token, bob.id, request, { workspace, sites: [shop.id] })).status, 403);

    // Never more than the client asked: it asked read.
    assert.equal(
      (await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id], rights: 'write' })).status,
      400,
    );
    // Signed out, from another origin, for another account: refused, and the request still waits.
    assert.equal((await callOn(world, 'GET', `/console/oauth/requests/${request}`, {})).status, 401);
    assert.equal(
      (
        await callOn(world, 'POST', `/console/oauth/requests/${request}/approve`, {
          token: alice.token,
          origin: 'https://evil.dev',
          body: { account: alice.id, workspace, sites: [shop.id], rights: 'read' },
        })
      ).status,
      403,
    );
    assert.equal((await approve(world, alice.token, bob.id, request, { workspace, sites: [shop.id] })).status, 409);
    assert.equal((await approve(world, alice.token, alice.id, request, { workspace, sites: [] })).status, 400);
    assert.equal((await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] })).status, 200);

    // Answered once.
    assert.equal((await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] })).status, 404);
    assert.equal(
      (await callOn(world, 'GET', `/console/oauth/requests/${request}`, { token: alice.token })).status,
      404,
    );
  });

  it('offers no suspended workspace, and makes no connection in one', async () => {
    const { world, alice, workspace, shop } = await acme();
    const client = await claude(world);
    const request = await authorize(world, client.client_id);
    await rowsOf(world.database, `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${workspace}', 1)`);

    const shown = (await (
      await callOn(world, 'GET', `/console/oauth/requests/${request}`, { token: alice.token })
    ).json()) as any;
    assert.deepEqual(shown.workspaces, []);
    const refused = await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as any).error, 'workspace-suspended');
    const [held] = await rowsOf(world.database, 'SELECT count(*)::int AS n FROM agent_keys');
    assert.equal(held?.n, 0);
  });

  it('sends the client back with access_denied when the person denies', async () => {
    const { world, alice } = await acme();
    const client = await claude(world);
    const request = await authorize(world, client.client_id);
    const denied = await callOn(world, 'POST', `/console/oauth/requests/${request}/deny`, {
      token: alice.token,
      body: { account: alice.id },
    });
    assert.equal(denied.status, 200);
    const back = new URL(((await denied.json()) as any).redirect);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'the-state');
    assert.equal(back.searchParams.get('code'), null);
    const [held] = await rowsOf(world.database, 'SELECT count(*)::int AS n FROM agent_keys');
    assert.equal(held?.n, 0);
  });
});

describe('the tokens', () => {
  it('gives an access token that reads only the sites the person chose, with the rights chosen', async () => {
    const { world, alice, workspace, shop, blog, tokens, key } = await connected();
    assert.match(tokens.access_token, /^fba_/);
    assert.match(tokens.refresh_token, /^fbr_/);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, ACCESS_SECONDS);
    assert.equal(tokens.scope, 'read');

    const listed = await mcp(world, tokens.access_token, 'tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.result.tools.map((tool: any) => tool.name).toSorted(),
      ['feedback_as_text', 'get_feedback', 'list_feedback'],
      'read only: no write tool',
    );

    for (const site of [shop, blog]) {
      const note = noteFixture({ text: `on ${site.origin}`, page: { url: `${site.origin}/`, path: '/', title: 'P' } });
      const sent = await callOn(world, 'POST', `/feedback?client=${site.id}`, {
        origin: site.origin,
        token: (await signInTo(world, 'alice@acme.dev')).token,
        body: { ...note, client: { id: site.id, name: site.id } },
      });
      assert.ok(sent.status < 500);
    }
    const own = await mcp(world, tokens.access_token, 'tools/call', {
      name: 'list_feedback',
      arguments: { site: shop.id },
    });
    assert.equal(own.body.result.isError, undefined, JSON.stringify(own.body));
    const other = await mcp(world, tokens.access_token, 'tools/call', {
      name: 'list_feedback',
      arguments: { site: blog.id },
    });
    assert.equal(other.body.result.isError, true, 'a site the person did not choose');

    // The connection is a row of « Agents », with its client and no secret.
    const keys = (await (
      await callOn(world, 'GET', `/console/workspaces/${workspace}/agent-keys`, { token: alice.token })
    ).json()) as any;
    const row = keys.keys.find((each: any) => each.id === key);
    assert.deepEqual(row.client, { name: 'Claude', host: 'claude.ai' });
    assert.equal(row.secret, undefined);
    assert.notEqual(row.lastUsedAt, null);
    const [kept] = await rowsOf(world.database, `SELECT key_hash, client_id FROM agent_keys WHERE id = '${key}'`);
    assert.equal(kept?.key_hash, null);
    const stored = await rowsOf(world.database, 'SELECT token_hash FROM oauth_tokens');
    assert.ok(
      stored.every((each) => each.token_hash !== tokens.access_token && each.token_hash !== tokens.refresh_token),
    );
  });

  it('refuses a code with another verifier, another address, another client, or after its minute', async () => {
    const { world, alice, workspace, shop } = await acme();
    const client = await claude(world);
    const other = await claude(world);
    const codes: string[] = [];
    for (let made = 0; made < 5; made += 1) {
      const request = await authorize(world, client.client_id);
      const approved = await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] });
      codes.push(codeOf(((await approved.json()) as any).redirect));
    }
    const refusals = [
      await exchange(world, client.client_id, codes[0] as string, { code_verifier: 'w'.repeat(43) }),
      await exchange(world, client.client_id, codes[1] as string, { redirect_uri: 'https://claude.ai/other' }),
      await exchange(world, other.client_id, codes[2] as string),
    ];
    for (const refused of refusals) {
      assert.equal(refused.status, 400);
      assert.equal(((await refused.json()) as any).error, 'invalid_grant');
    }
    // A code with no verifier at all: PKCE is not optional.
    const bare = await exchange(world, client.client_id, codes[3] as string, { code_verifier: '' });
    assert.equal(bare.status, 400);
    // A code past its minute: the `Kv` no longer answers it.
    const real = Date.now;
    const later = real() + 61_000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    const late = await exchange(world, client.client_id, codes[4] as string).finally(() => vi.restoreAllMocks());
    assert.equal(late.status, 400);
    assert.equal(((await late.json()) as any).error, 'invalid_grant');
  });

  it('revokes the connection when its code is used twice', async () => {
    const { world, alice, workspace, shop } = await acme();
    const client = await claude(world);
    const request = await authorize(world, client.client_id);
    const approved = await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] });
    const code = codeOf(((await approved.json()) as any).redirect);
    const first = (await (await exchange(world, client.client_id, code)).json()) as any;
    assert.equal((await mcp(world, first.access_token)).status, 200);

    const again = await exchange(world, client.client_id, code);
    assert.equal(again.status, 400);
    assert.equal((await mcp(world, first.access_token)).status, 401, 'the tokens of the first exchange end too');
  });

  it('turns a refresh token once into a new pair, and revokes the connection when a spent one comes back', async () => {
    const { world, client, tokens } = await connected({ rights: 'write' });
    assert.equal(tokens.scope, 'read write');
    const turned = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    assert.equal(turned.status, 200);
    const renewed = (await turned.json()) as any;
    assert.notEqual(renewed.refresh_token, tokens.refresh_token);
    assert.equal((await mcp(world, renewed.access_token)).status, 200);
    assert.equal((await mcp(world, tokens.access_token)).status, 200, 'the access token of before lives its hour');

    // The spent refresh token, again: somebody copied it. The connection ends, for both.
    const replayed = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    assert.equal(replayed.status, 400);
    assert.equal((await mcp(world, renewed.access_token)).status, 401);
    const after = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: renewed.refresh_token,
      client_id: client.client_id,
    });
    assert.equal(after.status, 400);
  });

  it('refuses a refresh token of another client, and an access token that ended', async () => {
    const { world, client, tokens } = await connected();
    const other = await claude(world);
    const stolen = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: other.client_id,
    });
    assert.equal(stolen.status, 400);
    await rowsOf(world.database, `UPDATE oauth_tokens SET expires_at = 1 WHERE kind = 'access'`);
    const ended = await mcp(world, tokens.access_token);
    assert.equal(ended.status, 401);
    assert.match(ended.headers.get('WWW-Authenticate') as string, /error="invalid_token"/);
    // The refresh still works, for the same client: that is what a client does after this 401.
    const turned = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    assert.equal(turned.status, 200);
  });

  it('ends every token when the person revokes the connection in « Agents »', async () => {
    const { world, alice, workspace, key, client, tokens } = await connected();
    const revoked = await callOn(world, 'DELETE', `/console/workspaces/${workspace}/agent-keys/${key}`, {
      token: alice.token,
    });
    assert.equal(revoked.status, 204);
    assert.equal((await mcp(world, tokens.access_token)).status, 401);
    const [left] = await rowsOf(world.database, 'SELECT count(*)::int AS n FROM oauth_tokens');
    assert.equal(left?.n, 0);
    const refreshed = await form(world, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    assert.equal(refreshed.status, 400);
  });

  it('ends the connection when the member who approved it is suspended, as a key', async () => {
    const { world, alice, tokens } = await connected();
    await rowsOf(world.database, `UPDATE "user" SET banned = true WHERE id = '${alice.id}'`);
    assert.equal((await mcp(world, tokens.access_token)).status, 401);
  });

  it('revokes the connection by RFC 7009, for the client that holds the token only', async () => {
    const { world, client, tokens } = await connected();
    const other = await claude(world);
    assert.equal(
      (await form(world, '/oauth/revoke', { token: tokens.access_token, client_id: other.client_id })).status,
      200,
    );
    assert.equal((await mcp(world, tokens.access_token)).status, 200, 'another client revokes nothing');
    assert.equal(
      (await form(world, '/oauth/revoke', { token: tokens.refresh_token, client_id: client.client_id })).status,
      200,
    );
    assert.equal((await mcp(world, tokens.access_token)).status, 401);
  });

  it('asks a confidential client for its secret, in the form or in Basic', async () => {
    const { world, alice, workspace, shop } = await acme();
    const made = (await (await register(world, { client_name: 'CI', redirect_uris: [CALLBACK] })).json()) as any;
    const codeFor = async () => {
      const request = await authorize(world, made.client_id);
      const approved = await approve(world, alice.token, alice.id, request, { workspace, sites: [shop.id] });

      return codeOf(((await approved.json()) as any).redirect);
    };
    const without = await exchange(world, made.client_id, await codeFor());
    assert.equal(without.status, 401);
    assert.equal(((await without.json()) as any).error, 'invalid_client');
    const wrong = await exchange(world, made.client_id, await codeFor(), { client_secret: `fbs_${'A'.repeat(43)}` });
    assert.equal(wrong.status, 401);
    const posted = await exchange(world, made.client_id, await codeFor(), { client_secret: made.client_secret });
    assert.equal(posted.status, 200);
    const basic = Buffer.from(`${made.client_id}:${made.client_secret}`).toString('base64');
    const viaHeader = await form(
      world,
      '/oauth/token',
      { grant_type: 'authorization_code', code: await codeFor(), redirect_uri: CALLBACK, code_verifier: verifier },
      { Authorization: `Basic ${basic}` },
    );
    assert.equal(viaHeader.status, 200);
  });

  it('keeps the agent keys of the console working beside OAuth', async () => {
    const { world, alice, workspace, shop } = await acme();
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/agent-keys`, {
      token: alice.token,
      body: { name: 'CI', rights: 'read', sites: [shop.id] },
    });
    const { secret } = (await made.json()) as { secret: string };
    assert.equal((await mcp(world, secret)).status, 200);
  });
});
