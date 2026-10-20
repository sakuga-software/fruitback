import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ATTACHMENT_NAME_LENGTH,
  ATTACHMENT_TRANSIT_DAYS,
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_PER_NOTE,
  type Seed,
  type SeedIssue,
} from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { createPairing, redeemPairing } from './session.ts';
import { handleRequest } from './app.ts';
import { WORKER, type World, memberOf, shareWith, signInTo, worlds } from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresAttachmentStore } from './attachments-postgres.ts';
import {
  ATTACHMENTS_PATH,
  type AttachmentStore,
  MAX_HELD_BYTES,
  MAX_HELD_FILES,
  type OutgoingFile,
  SIGNED_URL_MS,
  TRANSIT_MS,
  attachmentIdOf,
  attachmentIdsOf,
  attachmentName,
  checkAttachment,
  createMemoryAttachmentStore,
  signedAttachmentPath,
  verifiesSignedRead,
} from './attachments.ts';
import { type CreatedWithFiles, type SeedStore, StoreError } from './store.ts';

/**
 * The files of the notes in transit (FRU-331): `POST /attachments`, the files that `POST /feedback`
 * hands to the store of the site, the signed read of a delivery, and the store on PostgreSQL.
 */

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SECRETS_KEY = 'a-secrets-key-of-the-tests-0123456789';
const envWith = worlds();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2]);
const HTML = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');

/** A tracker that keeps what it is given, files included, and can be told to fail. */
function trackerDouble(options: { takes?: boolean; fails?: boolean; loses?: boolean } = {}) {
  const { takes = true } = options;
  const received: { seed: Seed; files: readonly OutgoingFile[] }[] = [];
  const kept: SeedIssue[] = [];
  const store: SeedStore = {
    name: 'tracker',
    scope: () => 'tracker',
    ...(takes ? { attachments: true as const } : {}),
    async create(seed, _client, _policy, files = []): Promise<CreatedWithFiles> {
      if (options.fails) throw new StoreError('the tracker is down');
      received.push({ seed, files });
      const n = kept.length + 1;
      kept.push({
        id: `trk_${n}`,
        identifier: `TRK-${n}`,
        url: `https://tracker.test/TRK-${n}`,
        title: seed.note,
        stage: 'seeded',
        stateName: 'Todo',
        updatedAt: '2026-10-21T00:00:00.000Z',
        attachments: files.map((file) => ({ name: file.name, url: `https://tracker.test/files/${file.name}` })),
        seed,
      });
      const ids = files.map((file) => file.id);

      return {
        id: `trk_${n}`,
        identifier: `TRK-${n}`,
        url: `https://tracker.test/TRK-${n}`,
        ...(files.length === 0
          ? {}
          : { files: options.loses ? { sent: [], lost: ids, waiting: [] } : { sent: ids, lost: [], waiting: [] } }),
      };
    },
    async findForPage({ url }) {
      return kept.filter((issue) => issue.seed.page.url === url);
    },
  };

  return { store, received };
}

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
  await accounts.addSite(globex.id, { origin: 'https://staging.globex.dev', visibility: 'members' });

  return {
    alice,
    acme,
    site: site.id,
    secret,
    tokenOf,
    alice_token: await tokenOf(alice.id, acme.id),
    bob_token: await tokenOf(bob.id, globex.id),
  };
}

let ip = 0;

function call(
  env: World,
  context: { attachments?: AttachmentStore; store?: SeedStore },
  path: string,
  init: { method?: string; token?: string; body?: Uint8Array | string; headers?: Record<string, string> } = {},
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
    { clientIp: `198.18.1.${ip % 250}`, ...env.context, ...context },
  );
}

function upload(
  env: World,
  context: { attachments?: AttachmentStore; store?: SeedStore },
  site: string,
  token: string,
  bytes: Uint8Array = PNG,
  type = 'image/png',
  name = 'capture.png',
): Promise<Response> {
  return call(env, context, `${ATTACHMENTS_PATH}?client=${site}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    token,
    body: bytes,
    headers: { 'Content-Type': type },
  });
}

function noteOf(site: string, id = 'sd_with_files'): Seed {
  const seed = seedFixture({ id });

  return { ...seed, page: { ...seed.page, url: 'https://staging.acme.dev/pricing' }, client: { id: site } };
}

function post(
  env: World,
  context: { attachments?: AttachmentStore; store?: SeedStore },
  token: string,
  body: unknown,
  ids: readonly string[],
): Promise<Response> {
  return call(env, context, `/feedback?attachments=${ids.join(',')}`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('what the worker keeps of a file (FRU-331)', () => {
  it('reads the type from the bytes of an image or a PDF, never from the word of the sender', () => {
    assert.deepEqual(checkAttachment('image/png', PNG), { ok: true, kind: 'image', type: 'image/png' });
    assert.deepEqual(checkAttachment('image/png', HTML), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkAttachment('IMAGE/JPEG; q=1', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), {
      ok: true,
      kind: 'image',
      type: 'image/jpeg',
    });
    assert.deepEqual(checkAttachment('image/jpeg', PNG), { ok: false, error: 'type-mismatch' });
    assert.deepEqual(checkAttachment('image/gif', new TextEncoder().encode('GIF89a...')), {
      ok: true,
      kind: 'image',
      type: 'image/gif',
    });
    assert.deepEqual(checkAttachment('image/webp', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), {
      ok: true,
      kind: 'image',
      type: 'image/webp',
    });
    assert.deepEqual(checkAttachment('application/pdf', new TextEncoder().encode('%PDF-1.7')), {
      ok: true,
      kind: 'pdf',
      type: 'application/pdf',
    });
    assert.deepEqual(checkAttachment('application/pdf', HTML), { ok: false, error: 'type-mismatch' });
  });

  it('takes a text that is UTF-8 with no NUL byte, and refuses the others', () => {
    assert.equal(checkAttachment('text/plain', new TextEncoder().encode('une ligne de log, é')).ok, true);
    assert.deepEqual(checkAttachment('text/csv', new Uint8Array([0x61, 0x00, 0x62])), {
      ok: false,
      error: 'type-mismatch',
    });
    assert.deepEqual(checkAttachment('application/json', new Uint8Array([0xc3, 0x28])), {
      ok: false,
      error: 'type-mismatch',
    });
  });

  it('keeps any other file as application/octet-stream, a page of HTML or SVG included', () => {
    for (const declared of ['text/html', 'image/svg+xml', 'application/javascript', null, '']) {
      assert.deepEqual(checkAttachment(declared, HTML), { ok: true, kind: 'file', type: 'application/octet-stream' });
    }
    assert.deepEqual(checkAttachment('image/png', new Uint8Array(0)), { ok: false, error: 'empty-file' });
  });

  it('cleans a name of its path, its controls and its quotes, and keeps the extension of a long one', () => {
    assert.equal(attachmentName('dir/sub\\name.png'), 'dir_sub_name.png');
    assert.equal(attachmentName('..hidden'), 'hidden');
    assert.equal(attachmentName('a\u0000b\u001fc\u007f"d".png'), 'abc_d_.png');
    assert.equal(attachmentName(null), 'attachment');
    assert.equal(attachmentName('   '), 'attachment');
    const long = `${'x'.repeat(300)}.png`;
    assert.equal([...attachmentName(long)].length, 120);
    assert.ok(attachmentName(long).endsWith('.png'));
  });

  it('reads a list of ids, and refuses one that is not', () => {
    const a = `att_${'a'.repeat(32)}`;
    const b = `att_${'b'.repeat(32)}`;
    assert.deepEqual(attachmentIdsOf(null, 5), []);
    assert.deepEqual(attachmentIdsOf(`${a},${b},${a}`, 5), [a, b]);
    assert.equal(attachmentIdsOf(`${a},shot_1`, 5), null);
    assert.equal(attachmentIdsOf([a, b, a.replace('a', 'c')].join(','), 2), null);
    assert.equal(attachmentIdOf(`/attachments/${a}`), a);
    assert.equal(attachmentIdOf(`/attachments/${a}/x`), undefined);
  });

  it('signs the address of a file for one id and one end, and nothing else verifies', () => {
    const id = `att_${'a'.repeat(32)}`;
    const now = Date.parse('2026-10-21T10:00:00Z');
    const expires = Math.floor((now + SIGNED_URL_MS) / 1_000);
    const query = (path: string) => new URL(`https://w.test${path}`).searchParams;
    const path = signedAttachmentPath(SECRETS_KEY, id, expires);

    assert.equal(verifiesSignedRead(SECRETS_KEY, id, query(path), now), true);
    // The controls: another key, another id, a later end, and the end that passed.
    assert.equal(verifiesSignedRead(`${SECRETS_KEY}x`, id, query(path), now), false);
    assert.equal(verifiesSignedRead(SECRETS_KEY, `att_${'b'.repeat(32)}`, query(path), now), false);
    assert.equal(verifiesSignedRead(SECRETS_KEY, id, query(path.replace(`${expires}`, `${expires + 1}`)), now), false);
    assert.equal(verifiesSignedRead(SECRETS_KEY, id, query(path), expires * 1_000), false);
    assert.equal(verifiesSignedRead(SECRETS_KEY, id, query(`/attachments/${id}`), now), false);
  });
});

describe('POST /attachments (FRU-331)', () => {
  it('keeps a file for a session of the workspace, and answers its id and its end, never an address', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const before = Date.now();

    const sent = await upload(env, { attachments }, site, alice_token);
    assert.equal(sent.status, 201, await sent.clone().text());
    const answer = (await sent.json()) as Record<string, unknown>;
    assert.match(String(answer.id), /^att_[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(answer).sort(), ['expiresAt', 'id', 'name', 'size', 'type']);
    assert.equal(answer.type, 'image/png');
    assert.equal(answer.size, PNG.byteLength);
    const end = Date.parse(String(answer.expiresAt));
    assert.ok(end >= before + TRANSIT_MS && end <= Date.now() + TRANSIT_MS);
    assert.equal(sent.headers.get('Access-Control-Allow-Origin'), EXTENSION);
    assert.equal(attachments.size(), 1);
  });

  it('is sent by every role of the workspace, a guest on a site shared with them, and by nobody else', async () => {
    const env = await envWith();
    const { acme, alice, bob_token, site, secret, tokenOf } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    for (const role of ['guest', 'member', 'admin'] as const) {
      const person = await signInTo(env, `${role}@client.dev`);
      const token = await tokenOf(person.id, acme.id);
      // The control: a session of the workspace with no role in it sends nothing.
      assert.equal((await upload(env, { attachments }, site, token)).status, 401, `${role}, before`);
      await memberOf(env, acme.id, person.id, role);
      if (role === 'guest') await shareWith(env, acme.id, person.id, [site]);
      assert.equal((await upload(env, { attachments }, site, token)).status, 201, role);
    }
    const ofSite = await signIdentityToken({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
    assert.equal((await upload(env, { attachments }, site, bob_token)).status, 401, 'a member of another workspace');
    assert.equal((await upload(env, { attachments }, site, ofSite)).status, 401, 'a token of a site');
    assert.equal(
      (
        await call(env, { attachments }, `${ATTACHMENTS_PATH}?client=${site}`, {
          method: 'POST',
          body: PNG,
          headers: { 'Content-Type': 'image/png' },
        })
      ).status,
      401,
      'no token',
    );
  });

  it('answers 409 attachments-not-taken for a site whose store takes no file, and keeps nothing', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { store } = trackerDouble({ takes: false });

    const refused = await upload(env, { attachments, store }, site, alice_token);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'attachments-not-taken' });
    assert.equal(attachments.size(), 0);
    // The control: the same file to a store that takes files.
    assert.equal((await upload(env, { attachments, store: trackerDouble().store }, site, alice_token)).status, 201);
  });

  it('refuses a file over the limit of its kind, a type that its bytes deny, and an empty one', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES.text + 1).fill(0x61);

    const tooBig = await upload(env, { attachments }, site, alice_token, big, 'text/plain', 'log.txt');
    assert.equal(tooBig.status, 413);
    assert.deepEqual(await tooBig.json(), { error: 'payload-too-large', maxBytes: MAX_ATTACHMENT_BYTES.text });
    // The control: the same bytes declared as another file, whose limit is higher.
    assert.equal(
      (await upload(env, { attachments }, site, alice_token, big, 'application/zip', 'log.zip')).status,
      201,
    );

    const lie = await upload(env, { attachments }, site, alice_token, HTML, 'image/png', 'x.png');
    assert.equal(lie.status, 400);
    assert.deepEqual(await lie.json(), { error: 'type-mismatch' });
    const empty = await upload(env, { attachments }, site, alice_token, new Uint8Array(0));
    assert.deepEqual(await empty.json(), { error: 'empty-file' });
  });

  it('keeps a page of HTML as an opaque file, under the name the sender gave, cleaned', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const sent = await upload(env, { attachments }, site, alice_token, HTML, 'text/html', '../page.html');
    assert.equal(sent.status, 201);
    const [kept] = attachments.all();
    assert.equal(kept?.type, 'application/octet-stream');
    assert.equal(kept?.name, '_page.html');
  });

  it('refuses a file to an account that already holds the most files in transit', async () => {
    const env = await envWith();
    const { alice, alice_token, acme, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    for (let n = 0; n < MAX_HELD_FILES; n += 1) {
      await attachments.put({
        id: `att_${String(n).padStart(32, '0')}`,
        workspace: acme.id,
        account: alice.id,
        site,
        name: 'x.png',
        type: 'image/png',
        content: PNG,
        createdAt: Date.now(),
        expiresAt: Date.now() + TRANSIT_MS,
      });
    }
    const full = await upload(env, { attachments }, site, alice_token);
    assert.equal(full.status, 429);
    assert.equal(((await full.json()) as { error: string }).error, 'transit-full');

    // The files whose transit ended no longer count.
    await attachments.endAt(
      attachments.all().map((each) => each.id),
      Date.now() - 1,
    );
    assert.equal((await upload(env, { attachments }, site, alice_token)).status, 201);
    assert.equal(attachments.size(), 1, 'the sweep removed the files whose transit ended');
  });

  it('serves no file to a member, a guest or a page: no route reads one without a signature', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { id } = (await (await upload(env, { attachments }, site, alice_token)).json()) as { id: string };

    for (const path of [`${ATTACHMENTS_PATH}/${id}`, `/screenshot/${id}`, `/screenshot/shot_${'0'.repeat(32)}`]) {
      const read = await call(env, { attachments }, path, { token: alice_token });
      assert.equal(read.status, 404, path);
      assert.deepEqual(await read.json(), { error: 'not-found' }, path);
    }
  });
});

describe('the files of a note, sent with it (FRU-331)', () => {
  it('hands the files to the store of the site, then removes them from the transit', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { store, received } = trackerDouble();
    const one = (await (await upload(env, { attachments, store }, site, alice_token)).json()) as { id: string };
    const two = (await (
      await upload(
        env,
        { attachments, store },
        site,
        alice_token,
        new TextEncoder().encode('log'),
        'text/plain',
        'a.log',
      )
    ).json()) as { id: string };

    const sent = await post(env, { attachments, store }, alice_token, noteOf(site), [one.id, two.id]);
    assert.equal(sent.status, 201, await sent.clone().text());
    const answer = (await sent.json()) as { issue: Record<string, unknown>; attachments: unknown };
    assert.deepEqual(answer.attachments, { sent: 2, lost: 0, waiting: 0 });
    assert.equal('files' in answer.issue, false, 'the answer of the store about its files stays in the worker');
    assert.deepEqual(
      received[0]?.files.map((file) => [file.name, file.type, file.content.byteLength]),
      [
        ['capture.png', 'image/png', PNG.byteLength],
        ['a.log', 'text/plain', 3],
      ],
    );
    assert.equal(attachments.size(), 0, 'the tracker has them: none stays in transit');

    // A read says the files of the note, with the address of the tracker.
    const read = await call(
      env,
      { attachments, store },
      `/feedback?url=${encodeURIComponent('https://staging.acme.dev/pricing')}&client=${site}`,
      { token: alice_token },
    );
    const { issues } = (await read.json()) as { issues: SeedIssue[] };
    assert.deepEqual(issues[0]?.attachments, [
      { name: 'capture.png', url: 'https://tracker.test/files/capture.png' },
      { name: 'a.log', url: 'https://tracker.test/files/a.log' },
    ]);
  });

  it('removes a file that the tracker refused once the note was written, and says so', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { store } = trackerDouble({ loses: true });
    const { id } = (await (await upload(env, { attachments, store }, site, alice_token)).json()) as { id: string };

    const sent = await post(env, { attachments, store }, alice_token, noteOf(site), [id]);
    assert.equal(sent.status, 201);
    assert.deepEqual(((await sent.json()) as { attachments: unknown }).attachments, { sent: 0, lost: 1, waiting: 0 });
    assert.equal(attachments.size(), 0);
  });

  it('keeps the files in transit when the note is not written, and sends them with the next attempt', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { id } = (await (await upload(env, { attachments }, site, alice_token)).json()) as { id: string };

    const down = await post(
      env,
      { attachments, store: trackerDouble({ fails: true }).store },
      alice_token,
      noteOf(site),
      [id],
    );
    assert.equal(down.status, 502);
    assert.equal(attachments.size(), 1, 'the widget sends the note again: its file waits');

    const up = trackerDouble();
    const again = await post(env, { attachments, store: up.store }, alice_token, noteOf(site), [id]);
    assert.equal(again.status, 201);
    assert.equal(up.received[0]?.files.length, 1);
    assert.equal(attachments.size(), 0);
  });

  it('answers 410 attachment-gone for a file of another person, another note, or past its transit, and writes nothing', async () => {
    const env = await envWith();
    const { acme, alice_token, site, tokenOf } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { store, received } = trackerDouble();
    const carl = await signInTo(env, 'carl@acme.dev');
    await memberOf(env, acme.id, carl.id, 'member');
    const carl_token = await tokenOf(carl.id, acme.id);
    const ofCarl = (await (await upload(env, { attachments, store }, site, carl_token)).json()) as { id: string };
    const mine = (await (await upload(env, { attachments, store }, site, alice_token)).json()) as { id: string };

    const another = await post(env, { attachments, store }, alice_token, noteOf(site), [mine.id, ofCarl.id]);
    assert.equal(another.status, 410);
    assert.deepEqual(await another.json(), { error: 'attachment-gone', ids: [ofCarl.id] });
    assert.equal(received.length, 0, 'no note is written');

    // Taken by one note, the file is not the file of a second.
    assert.equal(
      (await post(env, { attachments, store }, alice_token, noteOf(site, 'sd_first'), [mine.id])).status,
      201,
    );
    const mine2 = (await (await upload(env, { attachments, store }, site, alice_token)).json()) as { id: string };
    await attachments.claim([mine2.id], 'sd_other', Date.now());
    const taken = await post(env, { attachments, store }, alice_token, noteOf(site, 'sd_second'), [mine2.id]);
    assert.equal(taken.status, 410);

    const old = (await (await upload(env, { attachments, store }, site, alice_token)).json()) as { id: string };
    await attachments.endAt([old.id], Date.now() - 1);
    const ended = await post(env, { attachments, store }, alice_token, noteOf(site, 'sd_third'), [old.id]);
    assert.equal(ended.status, 410);
    assert.deepEqual(await ended.json(), { error: 'attachment-gone', ids: [old.id] });
  });

  it('answers 409 for a note with files to a store that takes none, and 400 for a batch with files', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { id } = (await (await upload(env, { attachments }, site, alice_token)).json()) as { id: string };

    const kept = await post(
      env,
      { attachments, store: trackerDouble({ takes: false }).store },
      alice_token,
      noteOf(site),
      [id],
    );
    assert.equal(kept.status, 409);
    assert.deepEqual(await kept.json(), { error: 'attachments-not-taken' });
    const batch = await post(env, { attachments }, alice_token, [noteOf(site)], [id]);
    assert.equal(batch.status, 400);
    assert.deepEqual(await batch.json(), { error: 'attachments-in-batch' });
    const bad = await post(env, { attachments }, alice_token, noteOf(site), ['shot_1']);
    assert.equal(bad.status, 400);
    assert.equal(attachments.size(), 1, 'the file still waits');
  });

  it('refuses a note whose files are over the limit of a note together', async () => {
    const env = await envWith();
    const { alice, acme, alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const id = `att_${String(n).padStart(32, '0')}`;
      ids.push(id);
      await attachments.put({
        id,
        workspace: acme.id,
        account: alice.id,
        site,
        name: 'big.bin',
        type: 'application/octet-stream',
        content: new Uint8Array(9 * 1_024 * 1_024),
        createdAt: Date.now(),
        expiresAt: Date.now() + TRANSIT_MS,
      });
    }
    const refused = await post(env, { attachments }, alice_token, noteOf(site), ids);
    assert.equal(refused.status, 413);
    // The control: two of them pass.
    assert.equal((await post(env, { attachments }, alice_token, noteOf(site), ids.slice(0, 2))).status, 201);
  });

  it('tells a reader with a session whether a note of this site can carry files', async () => {
    const env = await envWith();
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const read = async (store: SeedStore, token?: string) =>
      (await (
        await call(
          env,
          { attachments, store },
          `/feedback?url=${encodeURIComponent('https://staging.acme.dev/')}&client=${site}`,
          {
            ...(token === undefined ? {} : { token }),
            headers: { Origin: 'https://staging.acme.dev' },
          },
        )
      ).json()) as { canAttach?: boolean };

    assert.equal((await read(trackerDouble().store, alice_token)).canAttach, true);
    assert.equal((await read(trackerDouble({ takes: false }).store, alice_token)).canAttach, false);
  });
});

describe('the signed read of a file, for the receiver of a delivery (FRU-331)', () => {
  async function aFileOfANote() {
    const env = await envWith({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
    const { alice_token, site } = await setUp(env);
    const attachments = createMemoryAttachmentStore();
    const { id } = (await (await upload(env, { attachments }, site, alice_token)).json()) as { id: string };

    return { env, attachments, id };
  }

  it('answers the bytes, as a download that no page reads, until the end of the signature', async () => {
    const { env, attachments, id } = await aFileOfANote();
    await attachments.claim([id], 'sd_note', Date.now());
    const expires = Math.floor((Date.now() + SIGNED_URL_MS) / 1_000);

    const read = await call(env, { attachments }, signedAttachmentPath(SECRETS_KEY, id, expires));
    assert.equal(read.status, 200);
    assert.deepEqual(new Uint8Array(await read.arrayBuffer()), PNG);
    assert.equal(read.headers.get('Content-Type'), 'image/png');
    assert.equal(read.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''capture.png");
    assert.equal(read.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(read.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
    assert.equal(read.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(read.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(read.headers.get('Access-Control-Allow-Origin'), null, 'the call came with an Origin: no CORS header');
  });

  it('answers 404 to a signature that ended, that is not this one, or to a file no note took', async () => {
    const { env, attachments, id } = await aFileOfANote();
    const expires = Math.floor((Date.now() + SIGNED_URL_MS) / 1_000);
    const unclaimed = await call(env, { attachments }, signedAttachmentPath(SECRETS_KEY, id, expires));
    assert.equal(unclaimed.status, 404, 'no note took it yet');

    await attachments.claim([id], 'sd_note', Date.now());
    for (const path of [
      signedAttachmentPath(SECRETS_KEY, id, Math.floor(Date.now() / 1_000) - 1),
      signedAttachmentPath(`${SECRETS_KEY}-other`, id, expires),
      `${ATTACHMENTS_PATH}/${id}`,
    ]) {
      const read = await call(env, { attachments }, path);
      assert.equal(read.status, 404, path);
    }
    // The control: the right signature reads.
    assert.equal((await call(env, { attachments }, signedAttachmentPath(SECRETS_KEY, id, expires))).status, 200);
    await attachments.endAt([id], Date.now() - 1);
    assert.equal((await call(env, { attachments }, signedAttachmentPath(SECRETS_KEY, id, expires))).status, 404);
  });
});

describe('what SECURITY.md and docs/privacy.md say of the files (FRU-331)', () => {
  const MB = 1_024 * 1_024;
  const section = (file: string, heading: string): string => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `${heading} is not in ${file}`);
    const end = text.indexOf('\n### ', start + heading.length);

    return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  };

  it('states the numbers that the code holds', () => {
    const stated = section('../../../SECURITY.md', '### The files of a note, in transit (FRU-331)');
    assert.ok(stated.includes(`${MAX_ATTACHMENT_BYTES.image / MB} MB for an image, a PDF or another file`));
    assert.equal(MAX_ATTACHMENT_BYTES.pdf, MAX_ATTACHMENT_BYTES.image);
    assert.equal(MAX_ATTACHMENT_BYTES.file, MAX_ATTACHMENT_BYTES.image);
    assert.ok(stated.includes(`${MAX_ATTACHMENT_BYTES.text / MB} MB for a text`));
    assert.ok(
      stated.includes(`${MAX_ATTACHMENTS_PER_NOTE} files and ${MAX_ATTACHMENT_BYTES_PER_NOTE / MB} MB for one note`),
    );
    assert.ok(stated.includes(`${MAX_HELD_FILES} files or ${MAX_HELD_BYTES / MB} MB in transit for one account`));
    assert.ok(stated.includes(`cut at ${ATTACHMENT_NAME_LENGTH} characters`));
    assert.ok(stated.includes(`until the tracker has it, ${ATTACHMENT_TRANSIT_DAYS} days at most`));
    assert.equal(SIGNED_URL_MS, 60 * 60 * 1_000);
    assert.ok(stated.includes('answers for one hour'));
    assert.ok(stated.includes('`GET /screenshot/<id>` is gone'));

    const privacy = section('../../../docs/privacy.md', '- **The files of the notes, in transit');
    assert.ok(privacy.includes(`until the tracker has it, ${ATTACHMENT_TRANSIT_DAYS} days at most`));
  });
});

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the files in transit in the database, on ${label} (FRU-331)`, { skip }, () => {
    const file = (id: string, more: Partial<Parameters<AttachmentStore['put']>[0]> = {}) => ({
      id,
      workspace: 'ws_acme',
      account: 'acc_alice',
      site: 'site_acme',
      name: 'capture.png',
      type: 'image/png',
      content: PNG,
      createdAt: 1_000,
      expiresAt: 10_000,
      ...more,
    });

    it('keeps the bytes to the byte, reads nothing past its end, and sweeps it', async () => {
      const database = await opening(open);
      const store = createPostgresAttachmentStore(database);
      assert.equal(await store.get('att_0', 0), undefined);
      await rowsOf(
        database,
        `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'acme', now())`,
      );
      await store.put(file('att_1'));
      await store.put(file('att_2', { expiresAt: 5_000, account: 'acc_bob', content: new Uint8Array(3) }));

      const found = await store.get('att_1', 2_000);
      assert.ok(found?.content instanceof Uint8Array);
      assert.deepEqual({ ...found, content: [...found.content] }, { ...file('att_1'), content: [...PNG] });
      assert.equal(await store.get('att_2', 5_000), undefined, 'at its end, a file reads as absent');
      assert.deepEqual(await store.heldBy('acc_alice', 2_000), { files: 1, bytes: PNG.byteLength });
      assert.deepEqual(await store.heldBy('acc_bob', 6_000), { files: 0, bytes: 0 });

      assert.equal(await store.sweep(5_000), 1);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM screenshots'), [{ id: 'att_1' }]);
    });

    it('gives a file to one note only, and brings its end closer, never further', async () => {
      const database = await opening(open);
      const store = createPostgresAttachmentStore(database);
      await store.get('att_0', 0);
      await rowsOf(
        database,
        `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'acme', now())`,
      );
      await store.put(file('att_1'));
      await store.put(file('att_2'));

      assert.deepEqual(
        (await store.claim(['att_1', 'att_2'], 'sd_one', 2_000)).map((each) => [each.id, each.seed]),
        [
          ['att_1', 'sd_one'],
          ['att_2', 'sd_one'],
        ],
      );
      assert.deepEqual(await store.claim(['att_1'], 'sd_two', 2_000), [], 'another note takes none');
      assert.equal((await store.claim(['att_1'], 'sd_one', 2_000)).length, 1, 'the same note again takes it');

      await store.endAt(['att_1'], 3_000);
      await store.endAt(['att_1'], 9_000);
      assert.equal((await store.get('att_1', 2_000))?.expiresAt, 3_000);
      await store.remove(['att_2']);
      assert.equal(await store.get('att_2', 2_000), undefined);
    });

    it('migrates the pictures of before: the ones a kept note names go, the others end 7 days after they came', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0020_workspace_keeps_owner'));
      const now = Date.now();
      const day = 24 * 60 * 60 * 1_000;
      for (const statement of [
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
        `INSERT INTO screenshots (id, workspace_id, account_id, content, width, height, created_at) VALUES
           ('shot_kept', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 1, ${now - day}),
           ('shot_waiting', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 1, ${now - day}),
           ('shot_recent', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 1, ${now - day}),
           ('shot_old', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 1, ${now - 8 * day})`,
        `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES
           ('site_1', 'https://acme.dev/', 'seeded', '{"screenshot":{"url":"https://w.test/screenshot/shot_kept"}}', 1, 1),
           ('site_1', 'https://acme.dev/', 'seeded', '{"screenshot":{"url":"https://w.test/screenshot/shot_waiting"}}', 1, 1)`,
        `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES ('con_1', 'ws_acme', 'rest', 'REST', 'x', 1)`,
        `INSERT INTO deliveries (id, connector_id, body, created_at) VALUES
           ('dlv_1', 'con_1', '{"seed":{"screenshot":{"url":"https://w.test/screenshot/shot_waiting"}}}', 1)`,
      ]) {
        await rowsOf(database, statement);
      }

      await migrate(database);

      const rows = await rowsOf(database, 'SELECT id, expires_at, name, content_type FROM screenshots ORDER BY id');
      assert.deepEqual(
        rows.map((row) => [row.id, Number(row.expires_at), row.name, row.content_type]),
        [
          ['shot_recent', now - day + 7 * day, 'screenshot.png', 'image/png'],
          ['shot_waiting', now - day + 7 * day, 'screenshot.png', 'image/png'],
        ],
      );
    });
  });
}
