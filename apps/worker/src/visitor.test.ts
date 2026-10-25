import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { type Note, canonicalizePageUrl } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type Verified, type handleRequest, verifyForClient, writesWith } from './app.ts';
import type { ClientPolicy } from './clients.ts';
import { mutatedModule } from './conformance.fixture.ts';
import { WORKER, type World, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresAttachmentStore } from './attachments-postgres.ts';
import { createMemoryAttachmentStore } from './attachments.ts';
import type { AttachmentSeams } from './attachment-routes.ts';
import { createMemoryKv } from './kv.ts';
import type { NoteStore } from './store.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * A visitor leaves a note with no account (FRU-224), on a worker that has accounts.
 *
 * Mathieu, 2026-10-13: « on peut créer un compte quoiqu'il arrive aussi pour la partie admin, par
 * contre pas forcément besoin de compte pour laisser des notes côté user ». The code was there: a
 * site that everyone reads takes a note from a page with no session and no token. No test held the
 * whole path on a worker whose sites come from the console: the ones that did ran on
 * `FRUITBACK_CLIENTS`, which is going (FRU-184).
 *
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite), with better-auth on. An admin
 * signs in and makes the site through the route of the console. The visitor then sends what the
 * `<script>` of the site sends: the id of the site, the `Origin` of the page, and nothing else. The
 * notes are in the store of the database (FRU-218).
 */

const SITE = 'https://staging.acme.test';
/** The origin of a site of another workspace of the worker, and one that is no site of anybody. */
const SERVED = 'https://staging.globex.test';
const NOWHERE = 'https://elsewhere.example';
const PAGE = canonicalizePageUrl(`${SITE}/pricing`);

const envOf = worlds();

function noteFor(site: string, more: Partial<Note> = {}): Note {
  const note = noteFixture({ id: 'sd_visitor', page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
  const { client: _own, ...rest } = note;

  return { ...rest, client: { id: site, name: 'Acme' }, ...more };
}

/**
 * A worker with one workspace, and the site that its admin made in the console. `writers` absent:
 * the console names none, and the site takes the default of a new site (FRU-330).
 */
async function workerWithASite(visibility: 'everyone' | 'members', writers?: 'members' | 'anyone') {
  const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
  const admin = await signInTo(world, 'ana@acme.dev');
  const workspace = await workspaceIn(world, admin.token);
  const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
    token: admin.token,
    body: { url: `${SITE}/pricing?tab=annual`, visibility, ...(writers === undefined ? {} : { writers }) },
  });
  assert.equal(made.status, 201, await made.clone().text());
  const site = ((await made.json()) as { id: string }).id;
  const store = createPostgresNoteStore(world.database);

  /**
   * What a page sends: an `Origin`, and no `Authorization` and no `Cookie`. `null` is no `Origin` at
   * all. `token` is what the relay of the extension adds: the session of a member (FRU-330).
   */
  const visitor = {
    send: (origin: string | null, note: Note | Note[] = noteFor(site), token?: string) =>
      callOn(world, 'POST', '/feedback', { origin, body: note, ...(token === undefined ? {} : { token }) }, { store }),
    read: (origin: string | null, client = site, token?: string) =>
      callOn(
        world,
        'GET',
        `/feedback?url=${encodeURIComponent(PAGE)}&client=${client}`,
        { origin, ...(token === undefined ? {} : { token }) },
        { store },
      ),
  };

  return { world, admin, workspace, site, store, visitor };
}

/** The access token of a session of the extension, for `account` in `workspace`: what the relay sends. */
async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

async function notesOf(answer: Response): Promise<{ note: string; verified: unknown; name: unknown }[]> {
  assert.equal(answer.status, 200, await answer.clone().text());
  const { issues } = (await answer.json()) as {
    issues: { note: { text: string; reporter?: { verified?: boolean; name?: string } } }[];
  };

  return issues.map((issue) => ({
    note: issue.note.text,
    verified: issue.note.reporter?.verified,
    name: issue.note.reporter?.name,
  }));
}

const rowsIn = async (world: World): Promise<number> =>
  Number((await rowsOf(world.database, 'SELECT count(*)::int AS n FROM notes'))[0]?.n);

describe('a visitor with no account, on a site that everyone reads (FRU-224)', () => {
  it('leaves a note and reads it again, with no session, no token and no cookie', async () => {
    const { world, visitor } = await workerWithASite('everyone');

    const sent = await visitor.send(SITE, noteFor('ignored', { text: 'The button is too small.' }));
    // The note names a site that is not one: the control of the next lines, which name the right one.
    assert.equal(sent.status, 400, await sent.clone().text());
    assert.equal(await rowsIn(world), 0);

    const { site } = { site: (await rowsOf(world.database, 'SELECT id FROM sites'))[0]?.id as string };
    const kept = await visitor.send(SITE, noteFor(site, { text: 'The button is too small.' }));
    assert.equal(kept.status, 201, await kept.clone().text());
    assert.deepEqual(await kept.json(), { issue: { id: '1', identifier: 'FB-1' } });

    assert.deepEqual(
      (await notesOf(await visitor.read(SITE))).map((read) => read.note),
      ['The button is too small.'],
    );
    assert.equal(await rowsIn(world), 1);
  });

  it('keeps the name the visitor typed, and never says the worker verified it', async () => {
    const { site, visitor } = await workerWithASite('everyone');
    // A visitor can type anything, a `verified` of their own included.
    const typed = noteFor(site, {
      reporter: { name: 'Alice', email: 'alice@acme.dev', verified: true } as Note['reporter'],
    });

    assert.equal((await visitor.send(SITE, typed)).status, 201);

    const [read] = await notesOf(await visitor.read(SITE));
    assert.equal(read?.name, 'Alice');
    assert.notEqual(read?.verified, true);
  });

  it('refuses a note and a read that name the site from the page of another site', async () => {
    const { world, site, visitor } = await workerWithASite('everyone');
    assert.equal((await visitor.send(SITE)).status, 201);
    // Another workspace of the same worker has a site too: its origin is one the worker serves.
    const other = await signInTo(world, 'bob@globex.dev');
    const made = await callOn(
      world,
      'POST',
      `/console/workspaces/${await workspaceIn(world, other.token, 'Globex')}/sites`,
      {
        token: other.token,
        body: { url: SERVED, visibility: 'everyone' },
      },
    );
    assert.equal(made.status, 201);

    // Two refusals, by two checks. The origin of no site is refused before the site is looked for,
    // and the origin of another site is refused for this one.
    for (const [origin, error] of [
      [NOWHERE, 'origin-not-allowed'],
      [SERVED, 'origin-not-allowed-for-client'],
    ] as const) {
      for (const answer of [await visitor.send(origin), await visitor.read(origin)]) {
        assert.equal(answer.status, 403, origin);
        assert.deepEqual(await answer.json(), { error }, origin);
      }
    }
    assert.equal(await rowsIn(world), 1);
    // The site is not served under a name the worker does not know either.
    assert.deepEqual(await (await visitor.read(SITE, `${site}x`)).json(), { error: 'unknown-client' });
  });

  it('serves the site at its origin alone: the address the admin pasted had a path and a query', async () => {
    const { visitor } = await workerWithASite('everyone');

    for (const origin of [`${SITE}:8443`, SITE.replace('https:', 'http:'), 'https://acme.test']) {
      assert.equal((await visitor.read(origin)).status, 403, origin);
    }
    assert.equal((await visitor.read(SITE)).status, 200);
  });
});

describe('a visitor with no account, on a site that everyone reads and whose notes are « Members only » (FRU-330)', () => {
  it('leaves a note: the field decides nothing on a site that everyone reads', async () => {
    const { world, visitor } = await workerWithASite('everyone', 'members');

    const read = await visitor.read(SITE);
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { canWrite?: unknown }).canWrite, undefined);
    assert.equal((await visitor.send(SITE)).status, 201);
    assert.equal(await rowsIn(world), 1);
  });
});

describe('a visitor with no account, on a site that its members read (FRU-224, FRU-330)', () => {
  it('reads no note: the worker asks for a session, and says so', async () => {
    const { world, admin, workspace, store, visitor } = await workerWithASite('members');

    const read = await visitor.read(SITE);

    assert.equal(read.status, 401, await read.clone().text());
    // A new site is « Members only » (FRU-330): the refusal says that a note would be refused too.
    assert.deepEqual(await read.json(), { error: 'identity-required', reason: 'identity-required', canWrite: false });
    // The control, in the same world (one PGlite database for a process at a time, raised in
    // review): the same read, from a page of a site of the same workspace that everyone reads.
    const docs = 'https://docs.acme.test';
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: docs, visibility: 'everyone' },
    });
    const open = ((await made.json()) as { id: string }).id;
    const page = encodeURIComponent(canonicalizePageUrl(`${docs}/start`));
    const control = await callOn(world, 'GET', `/feedback?url=${page}&client=${open}`, { origin: docs }, { store });
    assert.equal(control.status, 200, await control.clone().text());
  });

  /**
   * « Anyone on the page » (FRU-330): the site of a team that wants notes from its visitors too. A
   * note that comes with no token is a claim (`attributionFor`), and is kept: a visitor writes a note
   * that they cannot read back. Every site made before FRU-330 has this value.
   */
  it('still takes a note sent with no session, which its sender cannot read back, where anyone on the page leaves one', async () => {
    const { world, visitor } = await workerWithASite('members', 'anyone');

    const sent = await visitor.send(SITE);

    assert.equal(sent.status, 201, await sent.clone().text());
    assert.equal(await rowsIn(world), 1);
    const read = await visitor.read(SITE);
    assert.equal(read.status, 401);
    // The refusal of the read says nothing of the note: the widget offers one, and it is kept.
    assert.equal(((await read.json()) as { canWrite?: unknown }).canWrite, undefined);
    // The note is one that nobody vouched for.
    assert.notEqual(
      (JSON.parse(String((await rowsOf(world.database, 'SELECT payload FROM notes'))[0]?.payload)) as Note).reporter
        ?.verified,
      true,
    );
  });

  it('refuses a note and a batch sent with no session where its notes are « Members only », with the answer of a refused read', async () => {
    const { world, site, visitor } = await workerWithASite('members', 'members');
    const read = await visitor.read(SITE);
    assert.equal(read.status, 401);
    const refusedRead = (await read.json()) as Record<string, unknown>;
    // The read says that a note would be refused too, so the widget offers none.
    assert.deepEqual(refusedRead, { error: 'identity-required', reason: 'identity-required', canWrite: false });

    for (const body of [noteFor(site), [noteFor(site), noteFor(site, { id: 'sd_visitor_2' })]]) {
      const sent = await visitor.send(SITE, body);

      assert.equal(sent.status, 401, await sent.clone().text());
      const { canWrite: _said, ...sameAsTheRead } = refusedRead;
      assert.deepEqual(await sent.json(), sameAsTheRead);
    }
    // No note was written, by the route or by the batch.
    assert.equal(await rowsIn(world), 0);
  });

  it('takes the note of a member, sent by the relay with their session, where its notes are « Members only »', async () => {
    const { world, admin, workspace, site, visitor } = await workerWithASite('members', 'members');
    const session = await sessionOf(world, admin.id, workspace);

    const read = await visitor.read(SITE, site, session);
    assert.equal(read.status, 200, await read.clone().text());
    // A member may write: the read does not say otherwise.
    assert.equal(((await read.json()) as { canWrite?: unknown }).canWrite, undefined);
    const one = await visitor.send(SITE, noteFor(site), session);
    assert.equal(one.status, 201, await one.clone().text());
    const batch = await visitor.send(
      SITE,
      [noteFor(site, { id: 'sd_member_2' }), noteFor(site, { id: 'sd_member_3' })],
      session,
    );
    assert.equal(batch.status, 201, await batch.clone().text());

    assert.equal(await rowsIn(world), 3);
  });

  it('refuses a token that is no session where its notes are « Members only », as a note with none', async () => {
    const { world, site, visitor } = await workerWithASite('members', 'members');

    const sent = await visitor.send(SITE, noteFor(site), 'not-a-token');

    assert.equal(sent.status, 401);
    assert.equal(((await sent.json()) as { error: string }).error, 'invalid-identity');
    assert.equal(await rowsIn(world), 0);
  });

  it('refuses a reply from the page sent with no session where its notes are « Members only »', async () => {
    const { world, site, visitor } = await workerWithASite('members', 'members');
    const answer = await callOn(world, 'POST', `/feedback/sd_visitor/replies?client=${site}`, {
      origin: SITE,
      body: { url: PAGE, body: 'Same here.', name: 'Bob' },
    });

    assert.equal(answer.status, 401);
    assert.equal(((await answer.json()) as { error: string }).error, 'identity-required');
    assert.equal((await visitor.read(SITE)).status, 401);
  });

  it('makes a new site « Members only » when the console names nobody, and keeps what a site had when it is added again', async () => {
    const { world, admin, workspace, site } = await workerWithASite('members');
    const writersOf = async () =>
      (await rowsOf(world.database, `SELECT writers FROM sites WHERE id = '${site}'`))[0]?.writers;
    assert.equal(await writersOf(), 'members');

    const opened = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: SITE, visibility: 'members', writers: 'anyone' },
    });
    assert.equal(((await opened.json()) as { writers: string }).writers, 'anyone');
    // A console of before sends no `writers`: it closes nothing that an admin opened.
    const again = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: SITE, visibility: 'members' },
    });
    assert.equal(((await again.json()) as { writers: string }).writers, 'anyone');
    assert.equal(await writersOf(), 'anyone');

    const wrong = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: SITE, visibility: 'members', writers: 'everyone' },
    });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { error: 'invalid-writers' });
    assert.equal(await writersOf(), 'anyone');
  });

  it('is the default of a site that the console makes with no visibility named', async () => {
    const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
    const admin = await signInTo(world, 'ana@acme.dev');
    const workspace = await workspaceIn(world, admin.token);

    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: SITE },
    });

    assert.equal(((await made.json()) as { visibility: string }).visibility, 'members');
  });
});

type Handle = typeof handleRequest;

/** What a page sends, through `handle`: the `handleRequest` of `app.ts`, or of a changed copy of it. */
function pageCall(
  handle: Handle,
  world: World,
  store: ReturnType<typeof createPostgresNoteStore>,
  method: 'GET' | 'POST',
  site: string,
): Promise<Response> {
  const path = method === 'GET' ? `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}` : '/feedback';
  const headers: Record<string, string> = {
    Origin: SITE,
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
  };

  return handle(
    new Request(`${WORKER}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(noteFor(site)) } : {}),
    }),
    world.env,
    { clientIp: '198.18.1.1', ...world.context, store },
  );
}

/**
 * Each guard of FRU-330, taken out of a copy of `app.ts`: the case that holds it sees the change.
 * The real module is the control of each one, in the same world.
 */
describe('the guards of « Members only », each planted out (FRU-330)', () => {
  const PLANTS: readonly { guard: string; file: string; from: string; to: string; shows: string }[] = [
    {
      guard: 'a note with no session is refused',
      file: 'app.ts',
      from: `    if (policy.write === 'authenticated') {
      return { ok: false, error: 'identity-required', reason: 'identity-required' };
    }`,
      to: '',
      shows: 'POST /feedback',
    },
    {
      guard: 'the refusal of a read says that a note would be refused',
      file: 'feedback-routes.ts',
      from: 'const closed = (await writesHere(request, route.policy)) ? {} : { canWrite: false };',
      to: 'const closed = {};',
      shows: 'GET /feedback',
    },
  ];

  /** What the page sees: `true` when the guard holds. */
  async function holds(handle: Handle, shows: string): Promise<boolean> {
    const { world, site, store } = await workerWithASite('members', 'members');
    if (shows === 'POST /feedback') {
      const sent = await pageCall(handle, world, store, 'POST', site);

      return sent.status === 401 && (await rowsIn(world)) === 0;
    }
    const read = await pageCall(handle, world, store, 'GET', site);

    return ((await read.json()) as { canWrite?: unknown }).canWrite === false;
  }

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      const { handleRequest: real } = await import('./app.ts');
      assert.equal(await holds(real, plant.shows), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, { from: plant.from, to: plant.to });
      try {
        assert.equal(await holds(mutant.module.handleRequest as Handle, plant.shows), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }

  it('takes no token that a site signs as a session, and sees it taken when the check is out', async () => {
    const policy: ClientPolicy = {
      identitySecret: 'the-own-key-of-a-site-of-enough-length',
      showComments: true,
      read: 'authenticated',
      write: 'authenticated',
      locale: 'en',
      sessions: { secret: 'the-key-of-the-worker-of-enough-length', workspace: 'ws_acme', reaches: async () => true },
    };
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdentityToken(
      { sub: 'visitor-42', iat: now, exp: now + 600 },
      policy.identitySecret as string,
    );
    const verified = (await verifyForClient(token, policy)) as Verified;
    // The token verifies: a read takes it. A note does not.
    assert.equal(verified.ok, true);
    assert.equal(writesWith(policy, verified), false);
    assert.equal(writesWith({ write: 'public' }, verified), true);

    const mutant = await mutatedModule('app.ts', {
      from: 'return verified?.ok === true && verified.session === true;',
      to: 'return verified?.ok === true;',
    });
    try {
      assert.equal((mutant.module.writesWith as typeof writesWith)(policy, verified), true);
    } finally {
      mutant.remove();
    }
  });
});

/** A PNG of one grey pixel: what the extension sends, the smallest that `pngSize` reads. */
function onePixel(): Uint8Array {
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
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header.set([8, 0, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array([0, 0x80])))),
    chunk('IEND', new Uint8Array()),
  ];
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }

  return all;
}

/**
 * `POST /attachments` as the relay sends it (FRU-331, which replaced `POST /screenshot`): the PNG as
 * the body, and the site of the note.
 */
function sendPicture(handle: Handle, world: World, site: string, token?: string): Promise<Response> {
  return handle(
    new Request(`${WORKER}/attachments?client=${site}&name=page.png`, {
      method: 'POST',
      headers: {
        Origin: SITE,
        'Content-Type': 'image/png',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: onePixel(),
    }),
    world.env,
    { clientIp: '198.18.1.2', ...world.context, attachments: createPostgresAttachmentStore(world.database) },
  );
}

describe('a picture with a note, on a site that its members read (FRU-330)', () => {
  it('is refused with no session, whoever may leave a note, and passes the guard for a member', async () => {
    const { handleRequest: real } = await import('./app.ts');
    for (const writers of ['members', 'anyone'] as const) {
      const { world, admin, workspace, site } = await workerWithASite('members', writers);

      const refused = await sendPicture(real, world, site);
      assert.equal(refused.status, 401, writers);
      assert.deepEqual(await refused.json(), { error: 'identity-required' }, writers);
      // The control: the session that the relay sends passes the guard. The notes of this site stay
      // in Fruitback, which takes no file (FRU-331): the next answer is that one.
      const kept = await sendPicture(real, world, site, await sessionOf(world, admin.id, workspace));
      assert.equal(kept.status, 409, `${writers}: ${await kept.clone().text()}`);
      assert.deepEqual(await kept.json(), { error: 'attachments-not-taken' }, writers);
    }
  });

  it('is kept with no session when the guard of the route is taken out', async () => {
    // The route of the files, with a place that takes them and a request with no session.
    const seams = (): AttachmentSeams => ({
      files: createMemoryAttachmentStore(),
      store: { attachments: true } as unknown as NoteStore,
      headers: {},
      secretsKey: undefined,
      kv: () => createMemoryKv(),
      route: () => ({ ok: true, workspace: 'ws_acme', place: async () => undefined }),
      writer: async () => undefined,
    });
    const request = () =>
      new Request(`${WORKER}/attachments?client=site_acme&name=page.png`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: onePixel(),
      });
    const { handleAttachment } = await import('./attachment-routes.ts');
    // The control: the route as it is refuses it.
    assert.equal((await handleAttachment(request(), '/attachments', seams())).status, 401);

    const mutant = await mutatedModule('attachment-routes.ts', {
      from: 'if (workspace === undefined || account === undefined || site === undefined)',
      to: 'if (workspace === undefined || site === undefined)',
    });
    try {
      const mutated = mutant.module.handleAttachment as typeof handleAttachment;
      const passed = await mutated(request(), '/attachments', seams()).then(
        (sent) => sent.status !== 401,
        (error: unknown) => /account/.test(String(error)),
      );
      assert.equal(passed, true);
    } finally {
      mutant.remove();
    }
  });
});
