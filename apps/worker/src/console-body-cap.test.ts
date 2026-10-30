import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'vitest';
import { MAX_BODY_BYTES } from './bounded-body.ts';
import { CONSOLE, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { ADMIN_WRITE_ROUTES } from './instance-admin.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The routes of the console read their body under the cap of the worker (FRU-506), as the routes of
 * the extension and of the organization plugin already did. Over it: `413 payload-too-large`, with
 * `maxBytes`, and nothing is written. Before FRU-506 they read it with `request.json()` or
 * `request.text()`, with no cap, and two of them answer a person who is not signed in.
 */

const envOf = worlds();
const world = () => envOf();

/** One byte over the cap, once in JSON. */
const OVER = { name: 'x'.repeat(MAX_BODY_BYTES) };

async function assertTooLarge(answer: Response, what: string, origin: string | null = CONSOLE): Promise<void> {
  assert.equal(answer.status, 413, `${what} answered ${answer.status}`);
  assert.deepEqual(await answer.json(), { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, what);
  // The caller reads the answer: it carries the headers of CORS, as every answer of these routes.
  if (origin !== null) assert.equal(answer.headers.get('Access-Control-Allow-Origin'), origin, what);
  assert.equal(answer.headers.get('Cache-Control'), 'no-store', what);
}

describe('the body of a route of the console (FRU-506)', () => {
  it('is refused over the cap on the routes of the sign-in, which need no session', async () => {
    const on = await world();

    await assertTooLarge(await callOn(on, 'POST', '/console/auth/email', { body: OVER }), 'the link');
    await assertTooLarge(await callOn(on, 'POST', '/console/auth/email/redeem', { body: OVER }), 'the redeem');
    // A route of better-auth, which the worker forwards with its body: read under the cap first.
    await assertTooLarge(await callOn(on, 'POST', '/console/auth/sign-in/social', { body: OVER }), 'better-auth');
    // The control: the same route, under the cap, reads the body.
    const under = await callOn(on, 'POST', '/console/auth/email', { body: { email: 'not-an-address' } });
    assert.equal(under.status, 400);
  });

  it('is refused on a declared length over the cap, before a byte is read', async () => {
    const on = await world();
    const answer = await callOn(on, 'POST', '/console/auth/email', {
      body: { email: 'alice@acme.dev' },
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
    });

    await assertTooLarge(answer, 'a declared length');
  });

  it('is refused over the cap on the routes of an account and of a workspace, and writes nothing', async () => {
    const on = await world();
    const alice = await signInTo(on, 'alice@acme.dev');
    const acme = await workspaceIn(on, alice.token, 'Acme');

    for (const path of [
      '/console/me/locale',
      '/console/me/name',
      '/console/me/emails',
      '/console/workspaces',
      // `agent-keys.ts` reads its body with the `readBody` that `console-api.ts` hands it.
      `/console/workspaces/${acme}/agent-keys`,
      // The organization plugin answers its own `413`, in the same words (FRU-149).
      '/console/auth/organization/update-member-role',
    ]) {
      await assertTooLarge(await callOn(on, 'POST', path, { token: alice.token, body: OVER }), path);
    }
    const workspaces = await rowsOf(on.database, 'SELECT name FROM organization');
    assert.deepEqual(
      workspaces.map((row) => row.name),
      ['Acme'],
    );
  });

  it('is refused over the cap on every route of the administrator that writes, and writes nothing', async () => {
    const on = await world();
    const ana = await signInTo(on, 'ana@acme.dev');
    const bob = await signInTo(on, 'bob@beta.dev');
    const beta = await workspaceIn(on, bob.token, 'Beta');
    assert.ok(ADMIN_WRITE_ROUTES.length >= 9);

    for (const route of ADMIN_WRITE_ROUTES) {
      const path = route.example.replace(/acc_0+/g, bob.id).replace(/ws_0+/g, beta);
      await assertTooLarge(await callOn(on, 'POST', path, { token: ana.token, body: OVER }), path);
    }
    assert.deepEqual(await rowsOf(on.database, 'SELECT id FROM admin_actions'), []);
  });

  /**
   * The routes of OAuth and of the connection of the extension read under the same cap, and answered
   * `400` over it: the review of #713 asked for one answer everywhere.
   */
  it('is refused with the same 413 on the routes of OAuth and of the connection of the extension', async () => {
    const on = await world();
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const form = new TextEncoder().encode(`grant_type=${'x'.repeat(MAX_BODY_BYTES)}`);

    await assertTooLarge(
      await callOn(on, 'POST', '/oauth/register', { origin: null, body: OVER }),
      'a registration',
      null,
    );
    await assertTooLarge(
      await callOn(on, 'POST', '/oauth/token', {
        origin: null,
        raw: { bytes: form, type: 'application/x-www-form-urlencoded' },
      }),
      'the token endpoint',
      null,
    );
    await assertTooLarge(
      await callOn(on, 'POST', '/session/connect', { origin: extension, body: OVER }),
      'a connection',
      extension,
    );
  });

  /** A guard, with its control: a new route that reads its body with no cap fails here. */
  it('is read by bounded-body.ts and by nothing else', () => {
    const dir = new URL('.', import.meta.url);
    const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(name));
    const unbounded = /\brequest\.(json|text|arrayBuffer|formData|blob)\(\)/;
    assert.ok(unbounded.test('await request.json()'), 'the pattern of this guard finds nothing');

    const found = sources.filter((name) => {
      const code = readFileSync(new URL(name, dir), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .join('\n');

      return unbounded.test(code);
    });
    assert.deepEqual(found, []);
  });
});
