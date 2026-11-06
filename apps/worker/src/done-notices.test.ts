import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import {
  DONE_CLAIM_MS,
  DONE_NOTICE_KEEP_MS,
  type DoneNotice,
  type DoneNotices,
  NOTIFY_TOKEN_TTL_MS,
  doneMessage,
  notifyToken,
  readEmail,
  readNotifyToken,
  sendDoneNotices,
} from './done-notices.ts';
import type { MailMessage } from './mail.ts';
import type { ClientPolicy } from './clients.ts';
import { createMemoryStore, resetMemoryLinear, setMemoryNoteStage } from './linear-memory.ts';
import { createPostgresDoneNotices } from './notes-index-postgres.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { invalidatePages } from './note-helpers.ts';
import { rowsOf } from './postgres.fixture.ts';
import { NOTIFY_LIMIT, NOTIFY_SITE_LIMIT } from './rate-limit.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';

/**
 * Telling the person who left a note that it is done (FRU-604): a member at the address of their
 * account, a visitor at the one address they gave for that note, once, then the row goes.
 */

const open = worlds();
const SECRET = 'a-secret-of-at-least-thirty-two-characters';
const ORIGIN = 'https://staging.acme.dev';
const PAGE = 'https://staging.acme.dev/pricing';

type Answer = { status: number; body: Record<string, any> };
const answerOf = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: (await response.json()) as Record<string, any>,
});

/** Waits for what `sendDoneNotices` sends without being awaited, a second at most. */
async function settled<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 1_000;
  let value = read();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }

  return value;
}

describe('readEmail', () => {
  it('takes an address, trimmed and in lower case', () => {
    assert.equal(readEmail('  Ana.Silva+qa@Example.CO.uk '), 'ana.silva+qa@example.co.uk');
  });

  it('refuses what is no address, and what would break a header or a line', () => {
    for (const value of [
      '',
      'ana',
      'ana@example',
      'ana@@example.com',
      'ana @example.com',
      'ana@example.com\r\nBcc: eve@example.com',
      '<ana@example.com>',
      '"ana"@example.com',
      `${'a'.repeat(65)}@example.com`,
      `ana@${'a'.repeat(250)}.com`,
      42,
      undefined,
    ]) {
      assert.equal(readEmail(value), undefined, String(value));
    }
  });
});

describe('the token of a note', () => {
  const now = 1_800_000_000_000;

  it('opens the note it was made for, until it runs out', () => {
    const token = notifyToken(SECRET, 'site', 'n_1', now);
    assert.equal(readNotifyToken(SECRET, 'site', 'n_1', token, now), true);
    assert.equal(readNotifyToken(SECRET, 'site', 'n_1', token, now + NOTIFY_TOKEN_TTL_MS), true);
    assert.equal(readNotifyToken(SECRET, 'site', 'n_1', token, now + NOTIFY_TOKEN_TTL_MS + 1), false);
  });

  it('opens no other note, no other site, and nothing under another secret', () => {
    const token = notifyToken(SECRET, 'site', 'n_1', now);
    assert.equal(readNotifyToken(SECRET, 'site', 'n_2', token, now), false);
    assert.equal(readNotifyToken(SECRET, 'other', 'n_1', token, now), false);
    assert.equal(readNotifyToken(`${SECRET}!`, 'site', 'n_1', token, now), false);
  });

  it('refuses an expiry moved later, one far in the future, and what is no token', () => {
    const token = notifyToken(SECRET, 'site', 'n_1', now);
    const [expiry, mac] = token.split('.') as [string, string];
    assert.equal(readNotifyToken(SECRET, 'site', 'n_1', `${Number(expiry) + 60_000}.${mac}`, now), false);
    const far = now + 10 * NOTIFY_TOKEN_TTL_MS;
    assert.equal(readNotifyToken(SECRET, 'site', 'n_1', notifyToken(SECRET, 'site', 'n_1', far), now), false);
    for (const value of [undefined, '', '.', `${expiry}.`, mac, 'x'.repeat(300), 7]) {
      assert.equal(readNotifyToken(SECRET, 'site', 'n_1', value, now), false, String(value));
    }
  });
});

describe('the message of a note done', () => {
  it('says the host, links to the note on its page, and holds no word of the note', () => {
    const message = doneMessage('ana@example.com', 'https://staging.acme.dev/pricing?tab=pro', 'n_1', 'en', true);
    assert.equal(message.to, 'ana@example.com');
    assert.equal(message.subject, 'Your note on staging.​acme.​dev is fixed');
    assert.ok(message.text.includes('https://staging.acme.dev/pricing?tab=pro#fruitback-note=n_1'));
    assert.ok(message.html.includes('Check it on the page'));
    assert.ok(message.text.includes('Your address is not kept after this message.'));
    assert.ok(!message.html.includes('<img'), 'no picture: it would say when the message was opened');
  });

  it('is in French for a French reader, and says nothing of an address to a member', () => {
    const message = doneMessage('ana@example.com', PAGE, 'n_1', 'fr-FR');
    assert.equal(message.subject, 'Votre note sur staging.​acme.​dev est corrigée');
    assert.ok(message.html.includes('La vérifier sur la page'));
    assert.ok(!message.text.includes('adresse'));
  });

  it('escapes the page in the html', () => {
    const message = doneMessage('ana@example.com', 'https://acme.dev/a"b<c', 'n_1', 'en');
    assert.ok(!message.html.includes('"b<c'));
  });
});

/** A store of rows in memory, as `DoneNotices` says it behaves. */
function memoryNotices(rows: DoneNotice[] = []): DoneNotices & { rows: DoneNotice[] } {
  const claimed = new Set<string>();
  const key = (notice: Pick<DoneNotice, 'site' | 'note'>) => `${notice.site} ${notice.note}`;

  return {
    rows,
    async watch(notice) {
      if (rows.some((row) => row.site === notice.site && row.note === notice.note)) return false;
      rows.push(notice);

      return true;
    },
    async take(site, notes) {
      const taken = rows.filter((row) => row.site === site && notes.includes(row.note) && !claimed.has(key(row)));
      for (const row of taken) claimed.add(key(row));

      return taken;
    },
    async sent(notice) {
      const at = rows.findIndex((row) => key(row) === key(notice));
      if (at >= 0) rows.splice(at, 1);
      claimed.delete(key(notice));
    },
    async release(notice) {
      claimed.delete(key(notice));
    },
    async sweep() {
      return 0;
    },
  };
}

const issue = (id: string, stage: string) => ({ stage, note: { id, page: { url: PAGE } } });

describe('sendDoneNotices', () => {
  it('sends one message for each note done that has a row, once', async () => {
    const sent: MailMessage[] = [];
    const notices = memoryNotices([
      { site: 's', note: 'n_done', email: 'ana@example.com' },
      { site: 's', note: 'n_todo', email: 'bo@example.com' },
      { site: 's', note: 'n_member', account: 'acc_1' },
    ]);
    const seams = {
      notices,
      mailer: { send: async (message: MailMessage) => void sent.push(message) },
      accountOf: async (id: string) => (id === 'acc_1' ? { email: 'carla@acme.dev', locale: 'fr' } : undefined),
    };
    const issues = [issue('n_done', 'done'), issue('n_todo', 'todo'), issue('n_member', 'done')];

    assert.equal(await sendDoneNotices(seams, 's', issues), 2);
    assert.equal(await sendDoneNotices(seams, 's', issues), 0);

    assert.deepEqual(
      sent.map((message) => message.to),
      ['ana@example.com', 'carla@acme.dev'],
    );
    assert.ok(sent[1]?.subject.startsWith('Votre note'));
    assert.deepEqual(notices.rows, [{ site: 's', note: 'n_todo', email: 'bo@example.com' }]);
  });

  it('keeps the row when the provider refuses, and the next read sends it', async () => {
    const notices = memoryNotices([{ site: 's', note: 'n_1', email: 'ana@example.com' }]);
    let refuse = true;
    const sent: MailMessage[] = [];
    const seams = {
      notices,
      mailer: {
        send: async (message: MailMessage) => {
          if (refuse) throw new Error('down');
          sent.push(message);
        },
      },
      accountOf: async () => undefined,
    };

    assert.equal(await sendDoneNotices(seams, 's', [issue('n_1', 'done')]), 0);
    assert.equal(notices.rows.length, 1);
    refuse = false;
    assert.equal(await sendDoneNotices(seams, 's', [issue('n_1', 'done')]), 1);
    assert.equal(sent.length, 1);
  });

  it('releases a row whose page the read does not hold, and never deletes it unsent', async () => {
    // A store that answers a row it was not asked for: the read has no page for it.
    const notices = memoryNotices([{ site: 's', note: 'n_other', email: 'ana@example.com' }]);
    const sent: MailMessage[] = [];
    const seams = {
      notices: { ...notices, take: async () => [...notices.rows] },
      mailer: { send: async (message: MailMessage) => void sent.push(message) },
      accountOf: async () => undefined,
    };
    assert.equal(await sendDoneNotices(seams, 's', [issue('n_1', 'done')]), 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(notices.rows, [{ site: 's', note: 'n_other', email: 'ana@example.com' }]);
  });

  it('tells nobody for an account that is gone, and sends nothing without a mailer', async () => {
    const notices = memoryNotices([{ site: 's', note: 'n_1', account: 'gone' }]);
    assert.equal(
      await sendDoneNotices({ notices, mailer: undefined, accountOf: async () => undefined }, 's', [
        issue('n_1', 'done'),
      ]),
      0,
    );
    assert.equal(notices.rows.length, 1, 'no mailer: the row waits');
    const sent: MailMessage[] = [];
    const mailer = { send: async (message: MailMessage) => void sent.push(message) };
    assert.equal(
      await sendDoneNotices({ notices, mailer, accountOf: async () => undefined }, 's', [issue('n_1', 'done')]),
      0,
    );
    assert.deepEqual(sent, []);
  });
});

/** A site that everybody reads and anybody writes on, with its notes in the database. */
async function aPublicSite(more: { env?: Record<string, string> } = {}) {
  const world = await open(more);
  const store = createPostgresNoteStore(world.database);
  const notices = createPostgresDoneNotices(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'everyone', writers: 'anyone' }))
    .id;

  return { world, store, notices, alice, workspace, site };
}

function plant(
  world: World,
  store: NoteStore,
  notices: DoneNotices,
  note: ReturnType<typeof noteFixture>,
  token?: string,
): Promise<Answer> {
  return callOn(
    world,
    'POST',
    '/feedback',
    { origin: ORIGIN, body: note, ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }) },
    { store, doneNotices: notices },
  ).then(answerOf);
}

function notify(
  world: World,
  notices: DoneNotices,
  site: string,
  note: string,
  body: Record<string, unknown>,
  clientIp?: string,
): Promise<Answer> {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/notify?client=${site}`,
    { origin: ORIGIN, body },
    {
      doneNotices: notices,
      ...(clientIp === undefined ? {} : { clientIp }),
    },
  ).then(answerOf);
}

async function read(world: World, store: NoteStore, notices: DoneNotices, site: string): Promise<Answer> {
  return callOn(
    world,
    'GET',
    `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`,
    { origin: ORIGIN },
    {
      store,
      doneNotices: notices,
    },
  ).then(answerOf);
}

const doneMails = (world: World) => world.mail.sent.filter((message) => /is fixed|est corrigée/.test(message.subject));

async function moveToDone(world: World, note: string): Promise<void> {
  const moved = await rowsOf(
    world.database,
    `UPDATE notes SET stage = 'done' WHERE (payload::jsonb ->> 'id') = '${note}' RETURNING id`,
  );
  assert.equal(moved.length, 1);
  // As a change of status does: the read cache holds the answer of before for 15 seconds.
  await invalidatePages(world.kv, [PAGE]);
}

describe('POST /feedback/<note>/notify (FRU-604)', () => {
  it('gives a visitor a token, takes their address once, and writes to them once when the note is done', async () => {
    const { world, store, notices, site } = await aPublicSite();
    const note = noteFixture({ id: 'nv_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await plant(world, store, notices, note);
    assert.equal(planted.status, 201, JSON.stringify(planted.body));
    const token = planted.body.notify?.token as string;
    assert.equal(typeof token, 'string');

    assert.equal(
      (await notify(world, notices, site, 'nv_1', { email: 'Ana@Example.com', token, locale: 'fr' })).status,
      201,
    );
    assert.equal((await notify(world, notices, site, 'nv_1', { email: 'eve@example.com', token })).status, 409);
    const [row] = await rowsOf(world.database, 'SELECT email, locale, account_id FROM done_notices');
    assert.deepEqual({ ...row }, { email: 'ana@example.com', locale: 'fr', account_id: null });

    // Not done: nothing is sent, and the address stays.
    await read(world, store, notices, site);
    assert.deepEqual(doneMails(world), []);

    await moveToDone(world, 'nv_1');
    assert.equal((await read(world, store, notices, site)).status, 200);
    const mails = await settled(
      () => doneMails(world),
      (sent) => sent.length > 0,
    );
    assert.deepEqual(
      mails.map((mail) => [mail.to, mail.subject]),
      [['ana@example.com', 'Votre note sur staging.​acme.​dev est corrigée']],
    );
    assert.deepEqual(
      await rowsOf(world.database, 'SELECT * FROM done_notices'),
      [],
      'the address goes with its message',
    );

    // Read again: the note is still done, and nobody is written to a second time.
    await read(world, store, notices, site);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(doneMails(world).length, 1);
  });

  it('refuses a token of another note, and an address that is none, and writes nothing', async () => {
    const { world, store, notices, site } = await aPublicSite();
    const first = await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nv_a', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nv_b', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    const tokenOfA = first.body.notify.token as string;

    const other = await notify(world, notices, site, 'nv_b', { email: 'ana@example.com', token: tokenOfA });
    assert.deepEqual(other, { status: 403, body: { error: 'invalid-token' } });
    const none = await notify(world, notices, site, 'nv_a', { email: 'ana@example.com' });
    assert.equal(none.status, 403);
    const bad = await notify(world, notices, site, 'nv_a', { email: 'not an address', token: tokenOfA });
    assert.deepEqual(bad, { status: 400, body: { error: 'invalid-email' } });

    assert.deepEqual(await rowsOf(world.database, 'SELECT * FROM done_notices'), []);
  });

  it('takes 3 addresses a minute from one caller, then answers 429', async () => {
    assert.equal(NOTIFY_LIMIT, 3);
    const { world, store, notices, site } = await aPublicSite();
    const answers: number[] = [];
    for (let at = 0; at <= NOTIFY_LIMIT; at += 1) {
      const id = `nv_l${at}`;
      const planted = await plant(
        world,
        store,
        notices,
        noteFixture({ id, page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
      );
      const token = planted.body.notify.token as string;
      answers.push(
        (await notify(world, notices, site, id, { email: `p${at}@example.com`, token }, '203.0.113.9')).status,
      );
    }
    assert.deepEqual(answers, [...Array.from({ length: NOTIFY_LIMIT }, () => 201), 429]);
  });

  it('takes 10 addresses a minute for one site, from many callers', async () => {
    assert.equal(NOTIFY_SITE_LIMIT, 10);
    const { world, store, notices, site } = await aPublicSite();
    const answers: number[] = [];
    for (let at = 0; at <= NOTIFY_SITE_LIMIT; at += 1) {
      const id = `nv_s${at}`;
      const planted = await plant(
        world,
        store,
        notices,
        noteFixture({ id, page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
      );
      const token = planted.body.notify.token as string;
      answers.push(
        (await notify(world, notices, site, id, { email: `p${at}@example.com`, token }, `203.0.113.${at + 20}`)).status,
      );
    }
    assert.deepEqual(answers, [...Array.from({ length: NOTIFY_SITE_LIMIT }, () => 201), 429]);
  });

  it('is no route on a worker that sends no mail, and offers no token there', async () => {
    const { world, store, notices, site } = await aPublicSite();
    const note = noteFixture({ id: 'nv_m', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await callOn(
      world,
      'POST',
      '/feedback',
      { origin: ORIGIN, body: note },
      {
        store,
        doneNotices: notices,
        mailer: undefined,
      },
    ).then(answerOf);
    assert.equal(planted.status, 201);
    assert.equal(planted.body.notify, undefined);
    const token = notifyToken(world.env.FRUITBACK_AUTH_SECRET as string, site, 'nv_m', Date.now());
    const answer = await callOn(
      world,
      'POST',
      `/feedback/nv_m/notify?client=${site}`,
      { origin: ORIGIN, body: { email: 'ana@example.com', token } },
      { doneNotices: notices, mailer: undefined },
    ).then(answerOf);
    assert.deepEqual(answer, { status: 404, body: { error: 'not-found' } });
  });

  it('offers no token for a page of another origin than the site', async () => {
    const { world, store, notices, site } = await aPublicSite();
    const note = noteFixture({
      id: 'nv_o',
      page: { url: 'https://phish.example/pricing', path: '/pricing' },
      client: { id: site, name: 'Acme' },
    });
    const planted = await plant(world, store, notices, note);
    assert.equal(planted.status, 201, JSON.stringify(planted.body));
    assert.equal(planted.body.notify, undefined);
  });
});

async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

describe('a member is told at the address of their account (FRU-604)', () => {
  it('keeps the account and no address, offers no token, and writes once when the note is done', async () => {
    const { world, store, notices, workspace, site } = await aPublicSite();
    const bob = await signInTo(world, 'bob@acme.dev');
    await memberOf(world, workspace, bob.id, 'member');
    const token = await sessionOf(world, bob.id, workspace);
    const note = noteFixture({ id: 'nm_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });

    const planted = await plant(world, store, notices, note, token);
    assert.equal(planted.status, 201, JSON.stringify(planted.body));
    assert.equal(planted.body.notify, undefined, 'a member is never asked for an address');
    const [row] = await rowsOf(world.database, 'SELECT account_id, email FROM done_notices');
    assert.deepEqual({ ...row }, { account_id: bob.id, email: null });

    await moveToDone(world, 'nm_1');
    await read(world, store, notices, site);
    const mails = await settled(
      () => doneMails(world),
      (sent) => sent.length > 0,
    );
    assert.deepEqual(
      mails.map((mail) => mail.to),
      ['bob@acme.dev'],
    );
  });
});

describe('a note moved to Done by its status (FRU-604)', () => {
  it('tells the visitor at once, with no read of the page', async () => {
    const { world, store, notices, alice, workspace, site } = await aPublicSite();
    const note = noteFixture({ id: 'ns_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await plant(world, store, notices, note);
    const token = planted.body.notify.token as string;
    assert.equal((await notify(world, notices, site, 'ns_1', { email: 'ana@example.com', token })).status, 201);

    // The owner manages the sites, so moves a note a visitor left.
    const session = await sessionOf(world, alice.id, workspace);
    const moved = await callOn(
      world,
      'POST',
      `/feedback/${planted.body.issue.id as string}/status?client=${site}`,
      { origin: ORIGIN, body: { url: PAGE, status: 'own:done' }, headers: { Authorization: `Bearer ${session}` } },
      { store, doneNotices: notices },
    ).then(answerOf);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const mails = await settled(
      () => doneMails(world),
      (sent) => sent.length > 0,
    );
    assert.deepEqual(
      mails.map((mail) => mail.to),
      ['ana@example.com'],
    );
  });
});

describe('the rows of done_notices (FRU-604)', () => {
  it('takes no row for a note the index does not hold, and one row for a note', async () => {
    const { world, store, notices, site } = await aPublicSite();
    const now = Date.now();
    assert.equal(await notices.watch({ site, note: 'nowhere', email: 'ana@example.com' }, now), false);
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nr_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    assert.equal(await notices.watch({ site, note: 'nr_1', email: 'ana@example.com' }, now), true);
    assert.equal(await notices.watch({ site, note: 'nr_1', email: 'eve@example.com' }, now), false);
  });

  it('keeps a row that a read took and did not send, and gives it again once its claim ran out', async () => {
    const { world, store, notices, site } = await aPublicSite();
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nr_5', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    const at = Date.now();
    await notices.watch({ site, note: 'nr_5', email: 'ana@example.com' }, at);
    // A read takes the row, and its process stops before it sends: the row is still there.
    assert.equal((await notices.take(site, ['nr_5'], at)).length, 1);
    assert.equal((await rowsOf(world.database, 'SELECT * FROM done_notices')).length, 1);
    // Another read meanwhile does not send it a second time; one after the claim ran out does.
    assert.deepEqual(await notices.take(site, ['nr_5'], at + DONE_CLAIM_MS - 1), []);
    assert.equal((await notices.take(site, ['nr_5'], at + DONE_CLAIM_MS + 1)).length, 1);
    // Released, it is taken at once; sent, it is gone.
    await notices.release({ site, note: 'nr_5' });
    assert.equal((await notices.take(site, ['nr_5'], at + DONE_CLAIM_MS + 2)).length, 1);
    await notices.sent({ site, note: 'nr_5' });
    assert.deepEqual(await rowsOf(world.database, 'SELECT * FROM done_notices'), []);
  });

  it('answers a row to one of two takes at once', async () => {
    const { world, store, notices, site } = await aPublicSite();
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nr_2', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    await notices.watch({ site, note: 'nr_2', email: 'ana@example.com' }, Date.now());
    const [one, two] = await Promise.all([
      notices.take(site, ['nr_2'], Date.now()),
      notices.take(site, ['nr_2'], Date.now()),
    ]);
    assert.equal(one.length + two.length, 1);
  });

  it(`sweeps a row ${DONE_NOTICE_KEEP_MS / 86_400_000} days after it was written, and takes none after`, async () => {
    const { world, store, notices, site } = await aPublicSite();
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nr_3', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    const at = Date.now();
    await notices.watch({ site, note: 'nr_3', email: 'ana@example.com' }, at);
    assert.deepEqual(await notices.take(site, ['nr_3'], at + DONE_NOTICE_KEEP_MS + 1), []);
    assert.equal(await notices.sweep(at + DONE_NOTICE_KEEP_MS - 1), 0);
    assert.equal(await notices.sweep(at + DONE_NOTICE_KEEP_MS + 1), 1);
    assert.deepEqual(await rowsOf(world.database, 'SELECT * FROM done_notices'), []);
  });

  it('goes with the note of the index, and with the site', async () => {
    const { world, store, notices, workspace, site } = await aPublicSite();
    await plant(
      world,
      store,
      notices,
      noteFixture({ id: 'nr_4', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } }),
    );
    await notices.watch({ site, note: 'nr_4', email: 'ana@example.com' }, Date.now());
    await world.accounts.removeSite(workspace, site);
    assert.deepEqual(await rowsOf(world.database, 'SELECT * FROM done_notices'), []);
  });

  it('refuses a row that names both an account and an address, or neither', async () => {
    const { notices, site } = await aPublicSite();
    await assert.rejects(notices.watch({ site, note: 'x', email: 'a@b.co', account: 'acc' }, Date.now()), TypeError);
    await assert.rejects(notices.watch({ site, note: 'x' }, Date.now()), TypeError);
  });
});

describe('POST /__dev/stage on the Linear in memory (FRU-604)', () => {
  it('moves the note of that id, and not a note whose other fields hold the same words', async () => {
    resetMemoryLinear();
    const store = createMemoryStore();
    const policy = { locale: 'en' } as unknown as ClientPolicy;
    await store.create(noteFixture({ id: 'nd_1', page: { url: PAGE, path: '/pricing' } }), undefined, policy);
    // The control: a name that is the id of the other note, which a search of the text would match.
    await store.create(
      noteFixture({ id: 'nd_2', page: { url: PAGE, path: '/pricing' }, reporter: { name: 'nd_1' } }),
      undefined,
      policy,
    );

    assert.equal(setMemoryNoteStage('nd_1', 'done'), 1);
    const stages = (await store.findForPage({ url: PAGE, clientId: undefined }, undefined, policy)).map((each) => [
      each.note.id,
      each.stage,
    ]);
    assert.deepEqual(stages.toSorted(), [
      ['nd_1', 'done'],
      ['nd_2', 'progress'],
    ]);
  });
});
