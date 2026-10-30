import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CONSOLE, type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { logoPath } from './console-api.ts';
import { LOGO_TYPES, MAX_LOGO_BYTES, MAX_LOGO_SIDE, checkLogo } from './workspace-logo.ts';

/**
 * The logo of a workspace (FRU-428): `checkLogo` on bytes made here, then
 * `/console/workspaces/<id>/logo` through `handleRequest`, on PostgreSQL (PGlite), with better-auth on.
 */

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];

/** The first bytes of a PNG of `width` × `height`: its signature and its `IHDR`. Nothing decodes more. */
function png(width: number, height: number, padding = 0): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    ...be32(0),
    ...new Array<number>(padding).fill(0),
  ]);
}

/** A JPEG whose frame header comes after an `APP0` segment, as a camera writes one. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii('JFIF'),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

const riff = (chunk: number[]): Uint8Array =>
  new Uint8Array([...ascii('RIFF'), ...le24(chunk.length + 4), 0, ...ascii('WEBP'), ...chunk]);

const webpLossy = (width: number, height: number): Uint8Array =>
  riff([...ascii('VP8 '), ...be32(0), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);

function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;

  return riff([
    ...ascii('VP8L'),
    ...be32(0),
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
    0,
    0,
  ]);
}

const webpExtended = (width: number, height: number): Uint8Array =>
  riff([...ascii('VP8X'), ...be32(0), 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0]);

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('checkLogo (FRU-428)', () => {
  it('reads the size of a PNG, a JPEG and the three kinds of WebP from their header', () => {
    assert.deepEqual(checkLogo('image/png', png(320, 200)), { ok: true, type: 'image/png', width: 320, height: 200 });
    assert.deepEqual(checkLogo('image/jpeg', jpeg(640, 480)), {
      ok: true,
      type: 'image/jpeg',
      width: 640,
      height: 480,
    });
    for (const [make, label] of [
      [webpLossy, 'VP8'],
      [webpLossless, 'VP8L'],
      [webpExtended, 'VP8X'],
    ] as const) {
      assert.deepEqual(
        checkLogo('image/webp', make(300, 150)),
        { ok: true, type: 'image/webp', width: 300, height: 150 },
        label,
      );
    }
    // The parameter and the case of the type are the sender's: the bare type is what is kept.
    assert.deepEqual(checkLogo('IMAGE/PNG; charset=binary', png(1, 1)), {
      ok: true,
      type: 'image/png',
      width: 1,
      height: 1,
    });
  });

  it('refuses an SVG and a GIF whatever their bytes, and any other type', () => {
    for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream', '', null]) {
      assert.deepEqual(
        checkLogo(type, type === 'image/gif' ? new Uint8Array(ascii('GIF89a')) : SVG),
        {
          ok: false,
          error: 'unsupported-type',
        },
        String(type),
      );
    }
    assert.deepEqual([...LOGO_TYPES], ['image/png', 'image/jpeg', 'image/webp']);
  });

  it('refuses bytes that are not what the type says, a header with no size, and no byte', () => {
    assert.deepEqual(checkLogo('image/png', SVG), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkLogo('image/png', jpeg(10, 10)), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkLogo('image/jpeg', png(10, 10)), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkLogo('image/webp', png(10, 10)), { ok: false, error: 'type-mismatch' });
    // A PNG cut before its IHDR, and a JPEG whose scan starts with no frame header.
    assert.deepEqual(checkLogo('image/png', png(10, 10).slice(0, 20)), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkLogo('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])), {
      ok: false,
      error: 'type-mismatch',
    });
    assert.deepEqual(checkLogo('image/png', png(0, 10)), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkLogo('image/png', new Uint8Array(0)), { ok: false, error: 'empty-file' });
  });

  it(`refuses a side over ${MAX_LOGO_SIDE} pixels, and takes one at it`, () => {
    assert.equal(checkLogo('image/png', png(MAX_LOGO_SIDE, MAX_LOGO_SIDE)).ok, true);
    assert.deepEqual(checkLogo('image/png', png(MAX_LOGO_SIDE + 1, 10)), { ok: false, error: 'image-too-large' });
    assert.deepEqual(checkLogo('image/png', png(10, 30_000)), { ok: false, error: 'image-too-large' });
    assert.deepEqual(checkLogo('image/jpeg', jpeg(10, MAX_LOGO_SIDE + 1)), { ok: false, error: 'image-too-large' });
    assert.deepEqual(checkLogo('image/webp', webpExtended(16_000, 10)), { ok: false, error: 'image-too-large' });
  });
});

const world = worlds();

type Me = { workspaces: { id: string; name: string; role: string; logo: string | null }[] };

async function logoIn(env: World, token: string, workspace: string): Promise<string | null | undefined> {
  const me = (await (await callOn(env, 'GET', '/console/me', { token })).json()) as Me;

  return me.workspaces.find((each) => each.id === workspace)?.logo;
}

/** Alice owns Acme, with one person of each other role in it; Mallory owns another workspace. */
async function acme(env: World) {
  const alice = await signInTo(env, 'alice@acme.dev');
  const id = await workspaceIn(env, alice.token, 'Acme');
  const people: Record<string, { id: string; token: string }> = { owner: alice };
  for (const role of ['admin', 'member', 'guest']) {
    const person = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, id, person.id, role);
    people[role] = person;
  }
  const mallory = await signInTo(env, 'mallory@evil.dev');
  const send = (
    token: string | undefined,
    bytes: Uint8Array,
    type = 'image/png',
    more: { origin?: string | null } = {},
  ) =>
    callOn(env, 'POST', `/console/workspaces/${id}/logo`, {
      ...(token === undefined ? {} : { token }),
      raw: { bytes, type },
      ...more,
    });
  const read = (token: string | undefined, workspace = id) =>
    callOn(env, 'GET', `/console/workspaces/${workspace}/logo`, token === undefined ? {} : { token });

  return {
    id,
    alice,
    mallory,
    people: people as Record<'owner' | 'admin' | 'member' | 'guest', typeof alice>,
    send,
    read,
  };
}

describe('the logo of a workspace (FRU-428)', () => {
  it('has none at first: null in /console/me and in the answer of a creation, and 404 on its read', async () => {
    const env = await world();
    const alice = await signInTo(env, 'alice@acme.dev');
    const created = await callOn(env, 'POST', '/console/workspaces', { token: alice.token, body: { name: 'Acme' } });
    const { id, logo } = (await created.json()) as { id: string; logo: unknown };
    assert.equal(logo, null);
    assert.equal(await logoIn(env, alice.token, id), null);
    const read = await callOn(env, 'GET', `/console/workspaces/${id}/logo`, { token: alice.token });
    assert.equal(read.status, 404);
    assert.deepEqual(await read.json(), { error: 'not-found' });
  });

  it('lets the owner and an admin send it, and every member reads it with the headers that run nothing', async () => {
    const env = await world();
    const { id, people, send, read } = await acme(env);

    for (const [role, bytes, type] of [
      ['owner', png(64, 64, 100), 'image/png'],
      ['admin', webpLossy(128, 64), 'image/webp'],
    ] as const) {
      const answer = await send(people[role].token, bytes, type);
      assert.equal(answer.status, 200, role);
      // The answer of a session cookie: no cache keeps it (FRU-506). The image itself stays private, max-age.
      assert.equal(answer.headers.get('Cache-Control'), 'no-store', role);
      const { logo } = (await answer.json()) as { logo: string };
      assert.match(logo, new RegExp(`^/console/workspaces/${id}/logo\\?v=\\d+$`), role);

      for (const reader of Object.values(people)) {
        assert.equal(await logoIn(env, reader.token, id), logo, role);
        const got = await read(reader.token);
        assert.equal(got.status, 200, role);
        assert.equal(got.headers.get('Content-Type'), type, role);
        assert.equal(got.headers.get('X-Content-Type-Options'), 'nosniff', role);
        assert.equal(got.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox", role);
        assert.equal(got.headers.get('Cross-Origin-Resource-Policy'), 'same-site', role);
        assert.equal(got.headers.get('Access-Control-Allow-Origin'), CONSOLE, role);
        assert.match(got.headers.get('Cache-Control') ?? '', /^private,/, role);
        assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes, role);
      }
    }
  });

  it('is read by an <img> of the console, which sends the cookie and no Origin', async () => {
    const env = await world();
    const { people, send } = await acme(env);
    const { logo } = (await (await send(people.owner.token, png(8, 8))).json()) as { logo: string };

    const got = await callOn(env, 'GET', logo, { token: people.guest.token, origin: null });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('Content-Type'), 'image/png');
  });

  it('changes the version of its address with each logo, and the rename answers it', async () => {
    const env = await world();
    const { id, people, send } = await acme(env);
    const first = ((await (await send(people.owner.token, png(8, 8))).json()) as { logo: string }).logo;
    const renamed = await callOn(env, 'POST', `/console/workspaces/${id}`, {
      token: people.admin.token,
      body: { name: 'Acme Studio' },
    });
    assert.deepEqual(await renamed.json(), { id, name: 'Acme Studio', role: 'admin', logo: first });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = ((await (await send(people.owner.token, jpeg(8, 8), 'image/jpeg')).json()) as { logo: string }).logo;
    assert.notEqual(second, first);
    assert.equal(await logoIn(env, people.member.token, id), second);
    assert.deepEqual(
      await rowsOf(env.database, `SELECT content_type FROM workspace_logos WHERE workspace_id = '${id}'`),
      [{ content_type: 'image/jpeg' }],
    );
  });

  it('lets the owner and an admin remove it, and the initial comes back for everybody', async () => {
    const env = await world();
    const { id, people, send, read } = await acme(env);

    for (const role of ['owner', 'admin'] as const) {
      assert.equal((await send(people.owner.token, png(8, 8))).status, 200);
      const removed = await callOn(env, 'DELETE', `/console/workspaces/${id}/logo`, { token: people[role].token });
      assert.equal(removed.status, 200, role);
      assert.deepEqual(await removed.json(), { logo: null }, role);
      assert.equal(await logoIn(env, people.guest.token, id), null, role);
      assert.equal((await read(people.member.token)).status, 404, role);
    }
    // A second removal is no error: there is nothing left.
    const again = await callOn(env, 'DELETE', `/console/workspaces/${id}/logo`, { token: people.owner.token });
    assert.equal(again.status, 200);
  });

  it('refuses a member and a guest, as every route of who manages a workspace, and changes nothing', async () => {
    const env = await world();
    const { id, people, send, read } = await acme(env);
    assert.equal((await send(people.owner.token, png(8, 8))).status, 200);
    const kept = await logoIn(env, people.owner.token, id);

    for (const role of ['member', 'guest'] as const) {
      const sent = await send(people[role].token, png(16, 16));
      assert.equal(sent.status, 403, role);
      assert.deepEqual(await sent.json(), { error: 'forbidden', role }, role);
      const removed = await callOn(env, 'DELETE', `/console/workspaces/${id}/logo`, { token: people[role].token });
      assert.equal(removed.status, 403, role);
    }
    assert.equal(await logoIn(env, people.owner.token, id), kept);
    assert.equal((await read(people.owner.token)).status, 200);
  });

  it('answers a workspace somebody is not of as one that does not exist, and nobody without a session', async () => {
    const env = await world();
    const { id, mallory, people, send, read } = await acme(env);
    assert.equal((await send(people.owner.token, png(8, 8))).status, 200);

    for (const answer of [await read(mallory.token), await send(mallory.token, png(8, 8))]) {
      assert.equal(answer.status, 404);
      assert.deepEqual(await answer.json(), { error: 'not-found' });
    }
    const removed = await callOn(env, 'DELETE', `/console/workspaces/${id}/logo`, { token: mallory.token });
    assert.equal(removed.status, 404);
    assert.equal((await read(undefined)).status, 401);
    assert.equal((await send(undefined, png(8, 8))).status, 401);
    assert.equal((await read(people.owner.token)).status, 200);
  });

  it('refuses a write with no Origin of the console, as every write of the console', async () => {
    const env = await world();
    const { people, send } = await acme(env);

    const none = await send(people.owner.token, png(8, 8), 'image/png', { origin: null });
    assert.equal(none.status, 403);
    assert.deepEqual(await none.json(), { error: 'origin-not-allowed' });
    const other = await send(people.owner.token, png(8, 8), 'image/png', { origin: 'https://evil.example' });
    assert.equal(other.status, 403);
  });

  it('refuses an SVG, a GIF, bytes that lie, too many pixels and too many bytes, and keeps the logo of before', async () => {
    const env = await world();
    const { id, people, send } = await acme(env);
    assert.equal((await send(people.owner.token, png(8, 8))).status, 200);
    const kept = await logoIn(env, people.owner.token, id);
    const { token } = people.owner;

    const svg = await send(token, SVG, 'image/svg+xml');
    assert.equal(svg.status, 415);
    assert.deepEqual(await svg.json(), { error: 'unsupported-type', types: ['image/png', 'image/jpeg', 'image/webp'] });
    assert.equal((await send(token, new Uint8Array(ascii('GIF89a')), 'image/gif')).status, 415);

    const lie = await send(token, SVG, 'image/png');
    assert.equal(lie.status, 400);
    assert.deepEqual(await lie.json(), { error: 'type-mismatch' });

    const huge = await send(token, png(MAX_LOGO_SIDE + 1, 8));
    assert.equal(huge.status, 400);
    assert.deepEqual(await huge.json(), { error: 'image-too-large', maxSide: MAX_LOGO_SIDE });

    const heavy = await send(token, png(8, 8, MAX_LOGO_BYTES));
    assert.equal(heavy.status, 413);
    assert.deepEqual(await heavy.json(), { error: 'payload-too-large', maxBytes: MAX_LOGO_BYTES });
    // At the limit, it is taken.
    const atLimit = png(8, 8);
    assert.equal((await send(token, png(8, 8, MAX_LOGO_BYTES - atLimit.byteLength))).status, 200);
    assert.notEqual(await logoIn(env, people.owner.token, id), kept);

    assert.equal((await send(token, new Uint8Array(0))).status, 400);
  });

  it('refuses a new logo and its removal in a suspended workspace, whose members still read it', async () => {
    const env = await world();
    const { id, people, send, read } = await acme(env);
    assert.equal((await send(people.owner.token, png(8, 8))).status, 200);
    await rowsOf(env.database, `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${id}', 1)`);

    const sent = await send(people.owner.token, png(16, 16));
    assert.equal(sent.status, 409);
    assert.equal(((await sent.json()) as { error: string }).error, 'workspace-suspended');
    const removed = await callOn(env, 'DELETE', `/console/workspaces/${id}/logo`, { token: people.owner.token });
    assert.equal(removed.status, 409);
    assert.equal((await read(people.member.token)).status, 200);
  });

  it('goes with its workspace', async () => {
    const env = await world();
    const { id, people, send } = await acme(env);
    assert.equal((await send(people.owner.token, png(8, 8))).status, 200);
    assert.equal((await callOn(env, 'DELETE', `/console/workspaces/${id}`, { token: people.owner.token })).status, 204);
    assert.deepEqual(await rowsOf(env.database, `SELECT workspace_id FROM workspace_logos`), []);
  });

  it('writes the address of the logo from the id of the workspace and its version', () => {
    assert.equal(logoPath('ws_abc', 42), '/console/workspaces/ws_abc/logo?v=42');
  });
});
