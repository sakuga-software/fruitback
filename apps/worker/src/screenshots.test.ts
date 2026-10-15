import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createPairing, redeemPairing } from './session.ts';
import { handleRequest } from './app.ts';
import { WORKER, type World, memberOf, shareWith, signInTo, worlds } from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, createRealDatabase } from './postgres.fixture.ts';
import { createPostgresScreenshotStore } from './screenshots-postgres.ts';
import {
  MAX_SCREENSHOT_BYTES,
  type ScreenshotStore,
  createMemoryScreenshotStore,
  pngSize,
  screenshotIdOf,
} from './screenshots.ts';
import type { Database } from './postgres.ts';

/**
 * The pictures of the notes (FRU-44): `POST /screenshot` and `GET /screenshot/<id>`, which answer a
 * member of a workspace and nobody else, and the store on PostgreSQL that keeps them.
 */

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
/** A worker with accounts on PGlite, where a person signs in as the console does (FRU-150). */
const envWith = worlds();

/** A real PNG of `width` by `height`, one grey pixel repeated: what the extension sends. */
function png(width: number, height: number): Uint8Array {
  const crc = (bytes: Uint8Array): number => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }

    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));

    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (width + 1)).fill(0x80);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(rows))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const all = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }

  return all;
}

/** Alice of Acme, Bob of Globex, each with a session of the extension. */
async function setUp(env: World) {
  const { accounts, sessions } = env;
  const secret = env.env.FRUITBACK_IDENTITY_SECRET as string;
  const tokenOf = async (subject: string, workspace: string): Promise<string> => {
    const { code } = await createPairing(sessions, { subject, workspace });
    const redeemed = await redeemPairing(sessions, code, secret);
    assert.ok(redeemed.ok);

    return redeemed.session.accessToken;
  };
  const alice = await signInTo(env, 'alice@acme.dev');
  const bob = await signInTo(env, 'bob@globex.dev');
  const acme = await accounts.createWorkspace('Acme', alice.id);
  const globex = await accounts.createWorkspace('Globex', bob.id);
  const site = await accounts.addSite(acme.id, { origin: 'https://staging.acme.dev', visibility: 'members' });
  const other = await accounts.addSite(globex.id, { origin: 'https://staging.globex.dev', visibility: 'members' });

  return {
    alice,
    acme,
    secret,
    tokenOf,
    send: `/screenshot?client=${site.id}`,
    sendToGlobex: `/screenshot?client=${other.id}`,
    alice_token: await tokenOf(alice.id, acme.id),
    bob_token: await tokenOf(bob.id, globex.id),
  };
}

let ip = 0;

function call(
  env: World,
  store: ScreenshotStore | undefined,
  path: string,
  init: { method?: string; token?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
): Promise<Response> {
  ip += 1;

  return handleRequest(
    new Request(`${WORKER}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Origin: EXTENSION,
        ...(init.token === undefined ? {} : { Authorization: `Bearer ${init.token}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    env.env,
    { clientIp: `198.18.1.${ip % 250}`, ...env.context, ...(store === undefined ? {} : { screenshots: store }) },
  );
}

describe('a picture of a note, sent by the extension (FRU-44)', () => {
  it('is kept for a member, and read back by a member of the same workspace, to the byte', async () => {
    const env = await envWith();
    const { alice_token, send } = await setUp(env);
    const store = createMemoryScreenshotStore();
    const picture = png(120, 60);

    const sent = await call(env, store, send, { method: 'POST', token: alice_token, body: picture });
    assert.equal(sent.status, 201);
    const answer = (await sent.json()) as { id: string; url: string; width: number; height: number };
    assert.equal(answer.url, `${WORKER}/screenshot/${answer.id}`);
    assert.match(answer.id, /^shot_[0-9a-f]{32}$/);
    assert.equal(answer.width, 120);
    assert.equal(answer.height, 60);
    const { pathname, origin } = new URL(answer.url);
    assert.equal(origin, WORKER);
    assert.equal(sent.headers.get('Access-Control-Allow-Origin'), EXTENSION);

    const read = await call(env, store, pathname, { token: alice_token });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('Content-Type'), 'image/png');
    assert.equal(read.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(read.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await read.arrayBuffer()), picture);
  });

  // FRU-213: the route asks for somebody of the workspace, and not for the right to see the tracker.
  it('is sent and read by a guest of the workspace, as by a member', async () => {
    const env = await envWith();
    const { alice_token, acme, send, tokenOf } = await setUp(env);
    const store = createMemoryScreenshotStore();
    const picture = png(120, 60);
    const sent = await call(env, store, send, { method: 'POST', token: alice_token, body: picture });
    const { id } = (await sent.json()) as { id: string };

    for (const role of ['guest', 'member', 'admin'] as const) {
      const person = await signInTo(env, `${role}@client.dev`);
      // The control: somebody with a session of the workspace and no role in it reads nothing.
      const token = await tokenOf(person.id, acme.id);
      assert.equal((await call(env, store, `/screenshot/${id}`, { token })).status, 404, `${role}, before`);
      assert.equal((await call(env, store, send, { method: 'POST', token, body: picture })).status, 401, role);

      await memberOf(env, acme.id, person.id, role);
      // A guest of the site of the picture (FRU-250): `guest-site.test.ts` holds the other sites.
      if (role === 'guest') await shareWith(env, acme.id, person.id, [send.slice(send.indexOf('client=') + 7)]);
      const read = await call(env, store, `/screenshot/${id}`, { token });
      assert.equal(read.status, 200, role);
      assert.deepEqual(new Uint8Array(await read.arrayBuffer()), picture, role);
      assert.equal((await call(env, store, send, { method: 'POST', token, body: picture })).status, 201, role);
    }
  });

  it('is read by nobody else: no token, a member of another workspace, a token of a site', async () => {
    const env = await envWith();
    const { alice, alice_token, bob_token, send, secret } = await setUp(env);
    const store = createMemoryScreenshotStore();
    const sent = await call(env, store, send, { method: 'POST', token: alice_token, body: png(4, 4) });
    const { pathname } = new URL(((await sent.json()) as { url: string }).url);
    const site = await signIdentityToken({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 600 }, secret);

    assert.equal((await call(env, store, pathname)).status, 401);
    assert.equal(
      (await call(env, store, pathname, { token: site })).status,
      404,
      'a token of a site is nobody of a workspace',
    );
    // Another workspace gets the answer of a picture that does not exist.
    const other = await call(env, store, pathname, { token: bob_token });
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), { error: 'not-found' });
    assert.equal(
      (await call(env, store, '/screenshot/shot_00000000000000000000000000000000', { token: bob_token })).status,
      404,
    );
  });

  it('is refused to anybody who is not a member, and keeps nothing', async () => {
    const env = await envWith();
    const { alice, acme, alice_token, bob_token, send, sendToGlobex, secret } = await setUp(env);
    const store = createMemoryScreenshotStore();
    const site = await signIdentityToken({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
    const stranger = await signIdentityToken(
      { sub: 'acc_nobody', ws: acme.id, exp: Math.floor(Date.now() / 1000) + 600 },
      secret,
    );

    for (const token of [undefined, site, stranger, `${alice_token}x`]) {
      const answer = await call(env, store, send, {
        method: 'POST',
        body: png(4, 4),
        ...(token === undefined ? {} : { token }),
      });
      assert.equal(answer.status, 401, String(token).slice(0, 20));
    }
    // A member of Globex, for a site of Acme; and Alice, for a site of Globex.
    assert.equal((await call(env, store, send, { method: 'POST', body: png(4, 4), token: bob_token })).status, 401);
    assert.equal(
      (await call(env, store, sendToGlobex, { method: 'POST', body: png(4, 4), token: alice_token })).status,
      401,
    );
    assert.equal(
      (await call(env, store, '/screenshot', { method: 'POST', body: png(4, 4), token: alice_token })).status,
      400,
      'no client',
    );
    assert.equal(store.size(), 0);
  });

  it('refuses a body that is not a PNG, and one over a megabyte, before it keeps anything', async () => {
    const env = await envWith();
    const { alice_token, send } = await setUp(env);
    const store = createMemoryScreenshotStore();
    const post = (body: Uint8Array, headers: Record<string, string> = {}) =>
      call(env, store, send, { method: 'POST', token: alice_token, body, headers });

    assert.equal((await post(new TextEncoder().encode('<svg onload="alert(1)"/>'))).status, 400);
    const wide = png(4, 4);
    new DataView(wide.buffer).setUint32(16, 100_000);
    assert.equal((await post(wide)).status, 400, 'a size no picture of an element has');
    const big = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    big.set(png(4, 4));
    const tooLarge = await post(big);
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: 'payload-too-large', maxBytes: MAX_SCREENSHOT_BYTES });
    assert.equal(store.size(), 0);
  });

  it('takes POST on the collection and GET on a picture, and nothing else', async () => {
    const env = await envWith();
    const { alice_token, send } = await setUp(env);
    const store = createMemoryScreenshotStore();

    assert.equal((await call(env, store, send, { token: alice_token })).status, 405);
    assert.equal((await call(env, store, '/screenshot/shot_x', { token: alice_token })).status, 404);
  });

  it('does not exist on a worker with no database', async () => {
    // A worker with no accounts: it has no database, so it keeps no picture, whatever the token says.
    const secret = 'a-worker-secret-of-exactly-enough';
    const token = await signIdentityToken(
      { sub: 'alice', ws: 'ws_1', exp: Math.floor(Date.now() / 1000) + 600 },
      secret,
    );
    const answer = await handleRequest(
      new Request(`${WORKER}/screenshot?client=acme`, {
        method: 'POST',
        headers: { Origin: EXTENSION, Authorization: `Bearer ${token}` },
        body: png(4, 4),
      }),
      { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://app.fruitback.test', FRUITBACK_IDENTITY_SECRET: secret },
      { clientIp: '198.18.2.1', kv: createMemoryKv() },
    );

    assert.equal(answer.status, 404);
    assert.deepEqual(await answer.json(), { error: 'not-found' });
  });
});

describe('the size that a PNG declares', () => {
  it('is read from its header, and nothing else is a PNG', () => {
    assert.deepEqual(pngSize(png(120, 60)), { width: 120, height: 60 });
    assert.equal(pngSize(new Uint8Array(24)), undefined);
    assert.equal(pngSize(png(4, 4).subarray(0, 20)), undefined);
  });

  it('names a picture by an id of 128 bits, and a path by nothing else', () => {
    assert.equal(
      screenshotIdOf('/screenshot/shot_0123456789abcdef0123456789abcdef'),
      'shot_0123456789abcdef0123456789abcdef',
    );
    for (const path of [
      '/screenshot',
      '/screenshot/',
      '/screenshot/shot_0123',
      '/screenshot/shot_0123456789abcdef0123456789abcdef/x',
    ]) {
      assert.equal(screenshotIdOf(path), undefined, path);
    }
  });
});

for (const { label, open, skip } of [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
] as const) {
  describe(`the pictures in the database, on ${label} (FRU-44)`, { skip }, () => {
    let database: Database | undefined;
    afterEach(async () => {
      await database?.close();
      database = undefined;
    });

    it('keeps the bytes of a picture and gives them back to the byte, with its workspace', async () => {
      database = await open();
      const store = createPostgresScreenshotStore(database);
      // The store applies the migrations at its first call; the table names a workspace.
      assert.equal(await store.get('shot_0'), undefined);
      await database.run((db) =>
        db.execute(
          `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'acme', now())` as never,
        ),
      );
      const picture = png(33, 7);
      await store.put({
        id: 'shot_1',
        workspace: 'ws_acme',
        account: 'acc_alice',
        png: picture,
        width: 33,
        height: 7,
        createdAt: 1,
      });

      const found = await store.get('shot_1');
      assert.ok(found !== undefined);
      assert.ok(found.png instanceof Uint8Array);
      assert.deepEqual(found.png, picture);
      assert.deepEqual(
        { ...found, png: undefined },
        {
          id: 'shot_1',
          workspace: 'ws_acme',
          account: 'acc_alice',
          png: undefined,
          width: 33,
          height: 7,
          createdAt: 1,
        },
      );
      assert.equal(await store.get('shot_2'), undefined);
    });
  });
}
