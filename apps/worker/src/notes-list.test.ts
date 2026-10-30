import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { NOTE_STAGES, type NoteStage } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { cursorOf, noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import type { NoteEntry, Place } from './notes-index.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { deliverDue, deliveryBody, sealTarget } from './rest-connector.ts';
import { createPairing, redeemPairing } from './session.ts';

const open = worlds();
const SECRETS_KEY = 'a-key-of-the-test-that-seals-the-connectors';
const BASE = Date.parse('2026-10-01T00:00:00.000Z');

type Planted = {
  site: string;
  id: string;
  note: string;
  url: string;
  origin: string;
  stage: NoteStage;
  place: string;
  reference: string;
  author?: string;
  at: number;
};

type Answer = {
  notes: {
    id: string;
    excerpt: string;
    page: { url: string; host: string; path: string };
    site: { id: string };
    stage: string;
    channel: string | null;
    author: { kind: string; name?: string };
    place?: { kind: string; connector?: string; label?: string };
    ref?: string;
    url?: string;
    delivery?: { id: string; state: string; attempts: number; lastStatus?: number };
    createdAt: string;
    checkedAt: string;
  }[];
  total: number;
  counts: { all: number; byPlace?: Record<string, number>; byStage?: Record<string, number>; undelivered?: number };
  searched: string[];
  next?: string;
};

/**
 * A workspace of Alice with three sites, a Linear connector and a REST connector, and 60 notes in
 * its index: two of them in each millisecond, so that the order needs more than the date. Bob is a
 * member and the author of every sixth note; Gina is a guest. Another workspace has notes too.
 */
async function sixtyNotes() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Bob Martin' WHERE id = '${bob.id}'`);
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');

  const origins = ['https://acme.dev', 'https://quiet.acme.dev', 'https://shop.acme.dev'];
  const sites = [];
  for (const origin of origins) sites.push(await world.accounts.addSite(workspace, { origin, visibility: 'everyone' }));
  // Gina is a guest of the three sites (FRU-250): `guest-site.test.ts` holds a guest of one.
  await shareWith(
    world,
    workspace,
    gina.id,
    sites.map((site) => site.id),
  );
  const linear = await world.accounts.addConnector(workspace, { kind: 'linear', label: 'Linear ACM', sealed: 'x' });
  const rest = await world.accounts.addConnector(workspace, {
    kind: 'rest',
    label: 'hooks.acme.test',
    sealed: sealTarget({ url: 'https://hooks.acme.test/fruitback', secret: 'a-secret-of-the-test-only' }, SECRETS_KEY),
  });

  const planted: Planted[] = [];
  for (let i = 0; i < 60; i += 1) {
    const site = sites[i % 3] as (typeof sites)[number];
    const place: Place =
      i % 2 === 0 ? { kind: 'connector', connector: linear.id } : { kind: 'connector', connector: rest.id };
    const stage = NOTE_STAGES[i % 5] as NoteStage;
    const words = i % 7 === 0 ? 'The checkout button is hidden' : `Note number ${i}`;
    const url = `${site.origin}/page-${i % 4}`;
    const reference = i % 2 === 0 ? `ACM-${100 + i}` : `FB-${i}`;
    const author = i % 6 === 0 ? bob.id : undefined;
    const at = BASE + Math.floor(i / 2) * 1_000;
    const note = noteFixture({
      id: `sd_${String(i).padStart(2, '0')}`,
      text: words,
      page: { url, path: `/page-${i % 4}` },
    });
    const entry: NoteEntry = {
      workspace,
      site: site.id,
      note,
      channel: i % 3 === 0 ? 'extension' : 'script',
      author: author === undefined ? { kind: 'visitor' } : { kind: 'member', account: author },
      place,
      issue: { identifier: reference, url: `https://tracker.test/${reference}` },
      stage,
    };
    await index.record([entry], at);
    planted.push({
      site: site.id,
      id: note.id,
      note: words,
      url,
      origin: site.origin,
      stage,
      place: place.kind === 'connector' ? place.connector : 'fruitback',
      reference,
      ...(author === undefined ? {} : { author }),
      at,
    });
  }

  // Notes of another workspace, which no list of this one shows.
  const zed = await signInTo(world, 'zed@other.dev');
  const other = await workspaceIn(world, zed.token, 'Other');
  const otherSite = await world.accounts.addSite(other, { origin: 'https://other.dev', visibility: 'everyone' });
  await index.record(
    [
      {
        workspace: other,
        site: otherSite.id,
        note: noteFixture({ id: 'sd_other', text: 'The checkout of another workspace' }),
        channel: 'script',
        author: { kind: 'visitor' },
        place: { kind: 'fruitback' },
        issue: { identifier: 'FB-1' },
        stage: 'new',
      },
    ],
    BASE + 999_000,
  );

  return { world, index, alice, bob, gina, zed, workspace, sites, linear, rest, planted };
}

/** The planted notes, newest first, in the order of the list. */
function ordered(planted: readonly Planted[]): Planted[] {
  // By date, then by site and by note, in their bytes (`COLLATE "C"`), as the list orders them.
  const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(b), Buffer.from(a));

  return [...planted].sort((a, b) => b.at - a.at || bytes(a.site, b.site) || bytes(a.id, b.id));
}

async function listOf(world: World, workspace: string, token: string, query = ''): Promise<Answer> {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes${query}`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as Answer;
}

/** Every page of a query, walked with its cursor. */
async function walk(
  world: World,
  workspace: string,
  token: string,
  query: string,
  between?: (page: number) => Promise<void>,
) {
  const seen: Answer['notes'] = [];
  let next: string | undefined;
  let page = 0;
  do {
    const joiner = query === '' ? '?' : '&';
    const answer = await listOf(
      world,
      workspace,
      token,
      `${query === '' ? '' : `?${query}`}${next === undefined ? '' : `${query === '' ? '?' : joiner}cursor=${next}`}`,
    );
    seen.push(...answer.notes);
    next = answer.next;
    page += 1;
    await between?.(page);
  } while (next !== undefined && page < 100);

  return seen;
}

const contains = (field: string, word: string) => field.toLowerCase().includes(word.toLowerCase());

describe('the notes of a workspace (FRU-244)', () => {
  it('answers 25 notes, the newest first, with the counts of the whole filter and a cursor', async () => {
    const { world, alice, workspace, linear, rest, planted } = await sixtyNotes();

    const answer = await listOf(world, workspace, alice.token);

    assert.equal(answer.notes.length, 25);
    assert.deepEqual(
      answer.notes.map((note) => note.id),
      ordered(planted)
        .slice(0, 25)
        .map((note) => noteIdOf(note.site, note.id)),
    );
    assert.equal(answer.total, 60);
    assert.deepEqual(answer.counts, {
      all: 60,
      byPlace: { [linear.id]: 30, [rest.id]: 30 },
      byStage: { new: 12, todo: 12, progress: 12, done: 12, closed: 12 },
      undelivered: 0,
    });
    assert.deepEqual(answer.searched, ['excerpt', 'page', 'site', 'stage', 'reference']);
    assert.equal(typeof answer.next, 'string');

    const first = answer.notes[0];
    const newest = ordered(planted)[0] as Planted;
    assert.deepEqual(first, {
      id: noteIdOf(newest.site, newest.id),
      excerpt: newest.note,
      page: { url: newest.url, host: new URL(newest.url).host, path: new URL(newest.url).pathname },
      site: { id: newest.site },
      stage: newest.stage,
      channel: 'script',
      author: { kind: 'anonymous' },
      place:
        newest.place === rest.id
          ? { kind: 'rest', connector: rest.id, label: 'hooks.acme.test' }
          : { kind: 'linear', connector: linear.id, label: 'Linear ACM' },
      ref: newest.reference,
      url: `https://tracker.test/${newest.reference}`,
      createdAt: new Date(newest.at).toISOString(),
      checkedAt: new Date(newest.at).toISOString(),
    });
  });

  it('walks every note once with its cursor, a note that arrives between two pages included', async () => {
    const { world, index, alice, workspace, sites, planted } = await sixtyNotes();
    const late = (id: string, at: number): Promise<void> =>
      index.record(
        [
          {
            workspace,
            site: (sites[0] as { id: string }).id,
            note: noteFixture({ id, text: 'Late' }),
            channel: 'script',
            author: { kind: 'visitor' },
            place: { kind: 'fruitback' },
            issue: { identifier: id },
            stage: 'new',
          },
        ],
        at,
      );

    const seen = await walk(world, workspace, alice.token, 'limit=8', async (page) => {
      // After the second page: one note newer than all, which a walk begun before it does not owe,
      // and one in the middle of the pages still to come, which it does.
      if (page === 2) {
        await late('sd_newest', BASE + 10_000_000);
        await late('sd_older', BASE + 5_500);
      }
    });

    const ids = seen.map((note) => note.id);
    assert.equal(new Set(ids).size, ids.length, 'no note twice');
    const expected = ordered([
      ...planted,
      { site: (sites[0] as { id: string }).id, id: 'sd_older', at: BASE + 5_500 } as Planted,
    ]).map((note) => noteIdOf(note.site, note.id));
    assert.deepEqual(ids, expected, 'every note, in order, the late older one too');
  });

  it('filters by site, stage, place and author, and searches what the index keeps', async () => {
    const { world, alice, bob, workspace, sites, linear, rest, planted } = await sixtyNotes();
    const site = (sites[1] as { id: string }).id;
    const cases: [string, (note: Planted) => boolean][] = [
      [`site=${site}`, (note) => note.site === site],
      ['stage=done', (note) => note.stage === 'done'],
      [`place=${rest.id}`, (note) => note.place === rest.id],
      [
        `site=${site}&stage=todo&place=${linear.id}`,
        (note) => note.site === site && note.stage === 'todo' && note.place === linear.id,
      ],
      ['q=checkout', (note) => contains(note.note, 'checkout')],
      ['q=quiet', (note) => contains(note.origin, 'quiet')],
      ['q=page-3', (note) => contains(note.url, 'page-3')],
      ['q=ACM-1', (note) => contains(note.reference, 'ACM-1')],
      ['q=done', (note) => contains(note.stage, 'done')],
      ['q=checkout%20shop', (note) => contains(note.note, 'checkout') && contains(note.origin, 'shop')],
      ['q=%25', () => false],
      ['q=_', () => false],
    ];
    for (const [query, keeps] of cases) {
      const answer = await listOf(world, workspace, alice.token, `?${query}&limit=50`);
      const expected = ordered(planted.filter(keeps));
      assert.deepEqual(
        answer.notes.map((note) => note.id),
        expected.map((note) => noteIdOf(note.site, note.id)),
        query,
      );
      assert.equal(answer.total, expected.length, `${query}: total`);
      // The counts are those of the filter without its place.
      const withoutPlace = query.replace(/&?place=[^&]+/u, '');
      const all = planted.filter((note) =>
        withoutPlace === query
          ? keeps(note)
          : (note.site === site || !query.includes('site=')) && (note.stage === 'todo' || !query.includes('stage=')),
      );
      assert.equal(answer.counts.all, all.length, `${query}: all`);
    }

    // `mine`: the notes whose author is the account that asks. Bob's, and his name.
    const his = await listOf(world, workspace, bob.token, '?mine=1&limit=50');
    assert.deepEqual(
      his.notes.map((note) => note.id),
      ordered(planted.filter((note) => note.author === bob.id)).map((note) => noteIdOf(note.site, note.id)),
    );
    assert.ok(his.notes.length > 0);
    assert.ok(his.notes.every((note) => note.author.kind === 'you' && note.author.name === 'Bob Martin'));
    // The same notes, read by Alice: a member, with his name.
    const hers = await listOf(world, workspace, alice.token, '?q=checkout&limit=50');
    assert.ok(hers.notes.some((note) => note.author.kind === 'member' && note.author.name === 'Bob Martin'));
    assert.equal((await listOf(world, workspace, alice.token, '?mine=1')).total, 0);
  });

  it('refuses a query that is not one, and pages of fewer than 8 or more than 50 notes', async () => {
    const { world, alice, workspace } = await sixtyNotes();
    for (const query of [
      'limit=7',
      'limit=51',
      'limit=abc',
      'stage=ripe',
      'site=a%20b',
      'mine=yes',
      `q=${'a'.repeat(201)}`,
      'cursor=not-a-cursor',
      `cursor=${Buffer.from('[1,2]').toString('base64url')}`,
    ]) {
      const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes?${query}`, {
        token: alice.token,
      });
      assert.equal(answer.status, 400, query);
    }
    assert.equal((await listOf(world, workspace, alice.token, '?limit=8')).notes.length, 8);
    assert.equal((await listOf(world, workspace, alice.token, '?limit=50')).notes.length, 50);
    assert.equal(
      (await listOf(world, workspace, alice.token, `?cursor=${cursorOf({ at: BASE, site: '', note: '' })}`)).notes
        .length,
      0,
    );
  });
});

/** The planted notes in the order of a list by status (FRU-551): the rank of the stage, then the date. */
function byStatus(planted: readonly Planted[]): Planted[] {
  const ranks = ['progress', 'todo', 'new', 'closed', 'done'];
  const dated = ordered(planted);

  return [...dated].sort(
    (a, b) => ranks.indexOf(a.stage) - ranks.indexOf(b.stage) || dated.indexOf(a) - dated.indexOf(b),
  );
}

describe('the notes of a workspace by status (FRU-551)', () => {
  it('reads in progress, to do, new, closed then done, the newest first in each, and counts each stage', async () => {
    const { world, alice, workspace, planted } = await sixtyNotes();

    const answer = await listOf(world, workspace, alice.token, '?order=status&limit=50');

    assert.deepEqual(
      answer.notes.map((note) => note.id),
      byStatus(planted)
        .slice(0, 50)
        .map((note) => noteIdOf(note.site, note.id)),
    );
    assert.deepEqual(
      [...new Set(answer.notes.map((note) => note.stage))],
      ['progress', 'todo', 'new', 'closed', 'done'],
    );
    assert.equal(answer.total, 60);
    assert.deepEqual(answer.counts.byStage, { new: 12, todo: 12, progress: 12, done: 12, closed: 12 });
  });

  it('walks every note once with its cursor, across the stages, a note that arrives between two pages included', async () => {
    const { world, index, alice, workspace, sites, planted } = await sixtyNotes();
    const site = (sites[0] as { id: string }).id;
    const seen = await walk(world, workspace, alice.token, 'order=status&limit=8', async (page) => {
      // After the second page, which ends in « in progress »: an old note « to do », which the walk
      // still owes, and a new one « in progress », which it does not.
      if (page === 2) {
        for (const [id, stage, at] of [
          ['sd_late_todo', 'todo', BASE + 500],
          ['sd_late_progress', 'progress', BASE + 10_000_000],
        ] as const) {
          await index.record(
            [
              {
                workspace,
                site,
                note: noteFixture({ id, text: 'Late' }),
                channel: 'script',
                author: { kind: 'visitor' },
                place: { kind: 'fruitback' },
                issue: { identifier: id },
                stage,
              },
            ],
            at,
          );
        }
      }
    });

    const ids = seen.map((note) => note.id);
    assert.equal(new Set(ids).size, ids.length, 'no note twice');
    const expected = byStatus([...planted, { site, id: 'sd_late_todo', stage: 'todo', at: BASE + 500 } as Planted]).map(
      (note) => noteIdOf(note.site, note.id),
    );
    assert.deepEqual(ids, expected, 'every note, in order, the late one « to do » too');
  });

  it('keeps the filters, and the counts of each stage follow the place', async () => {
    const { world, alice, workspace, rest, planted } = await sixtyNotes();

    const answer = await listOf(world, workspace, alice.token, `?order=status&place=${rest.id}&stage=todo&limit=50`);

    const kept = planted.filter((note) => note.place === rest.id && note.stage === 'todo');
    assert.deepEqual(
      answer.notes.map((note) => note.id),
      byStatus(kept).map((note) => noteIdOf(note.site, note.id)),
    );
    assert.deepEqual(answer.counts.byStage, { todo: kept.length });
  });

  it('counts by stage the notes of a source that was removed, as it lists them (review of #764)', async () => {
    const { world, alice, workspace, rest, planted } = await sixtyNotes();
    assert.equal(await world.accounts.removeConnector(workspace, rest.id), true);

    const answer = await listOf(world, workspace, alice.token, '?order=status&place=removed&limit=50');

    const gone = planted.filter((note) => note.place === rest.id);
    assert.deepEqual(
      answer.notes.map((note) => note.id),
      byStatus(gone).map((note) => noteIdOf(note.site, note.id)),
    );
    const counted: Record<string, number> = {};
    for (const note of gone) counted[note.stage] = (counted[note.stage] ?? 0) + 1;
    assert.deepEqual(answer.counts.byStage, counted);
    assert.equal(
      Object.values(answer.counts.byStage ?? {}).reduce((sum, notes) => sum + notes, 0),
      answer.total,
    );
    assert.equal(answer.counts.byPlace?.removed, gone.length);

    // Every place, the one that was removed included: the counts by stage add up to the list, and to
    // the count of the place on its chip.
    for (const place of Object.keys(answer.counts.byPlace ?? {})) {
      const one = await listOf(world, workspace, alice.token, `?order=status&place=${place}&limit=50`);
      const sum = Object.values(one.counts.byStage ?? {}).reduce((total, notes) => total + notes, 0);
      assert.equal(sum, one.total, place);
      assert.equal(sum, answer.counts.byPlace?.[place], place);
    }
  });

  it('refuses another order, and a cursor of the other order', async () => {
    const { world, alice, workspace } = await sixtyNotes();
    const dated = (await listOf(world, workspace, alice.token, '?limit=8')).next as string;
    const ranked = (await listOf(world, workspace, alice.token, '?order=status&limit=8')).next as string;
    for (const query of [
      'order=date',
      'order=',
      `order=status&cursor=${dated}`,
      `cursor=${ranked}`,
      `order=status&cursor=${Buffer.from(JSON.stringify([BASE, 'a', 'b', 5])).toString('base64url')}`,
      `order=status&cursor=${Buffer.from(JSON.stringify([BASE, 'a', 'b', 1.5])).toString('base64url')}`,
    ]) {
      const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes?${query}`, {
        token: alice.token,
      });
      assert.equal(answer.status, 400, query);
    }
  });
});

describe('who reads the notes (FRU-244)', () => {
  it('gives a guest the notes, and nothing of where they went', async () => {
    const { world, alice, gina, workspace, rest } = await sixtyNotes();

    const answer = await listOf(world, workspace, gina.token, '?limit=50');

    assert.equal(answer.total, 60);
    // The stages of a note are no secret of the tracker: a guest reads them on each row too (FRU-551).
    assert.deepEqual(answer.counts, { all: 60, byStage: { new: 12, todo: 12, progress: 12, done: 12, closed: 12 } });
    for (const note of answer.notes) {
      assert.deepEqual(
        Object.keys(note).filter((key) => ['place', 'ref', 'url', 'delivery'].includes(key)),
        [],
        'no place, no reference, no link, no delivery',
      );
    }
    // Nor by a search: a guest who tries references finds none, and is told what was searched.
    const probed = await listOf(world, workspace, gina.token, '?q=ACM-1&limit=50');
    assert.equal(probed.total, 0);
    assert.deepEqual(probed.searched, ['excerpt', 'page', 'site', 'stage']);
    assert.ok((await listOf(world, workspace, alice.token, '?q=ACM-1&limit=50')).total > 0, 'the owner finds them');
    const filtered = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes?place=${rest.id}`, {
      token: gina.token,
    });
    assert.equal(filtered.status, 403);
    const retry = await callOn(world, 'POST', `/console/workspaces/${workspace}/notes/${noteIdOf('x', 'y')}/retry`, {
      token: gina.token,
    });
    assert.equal(retry.status, 403);
  });

  it('answers 404 to another workspace, 401 to no session and to the token of an extension', async () => {
    const { world, zed, alice, workspace } = await sixtyNotes();
    const path = `/console/workspaces/${workspace}/notes`;

    assert.equal((await callOn(world, 'GET', path, { token: zed.token })).status, 404);
    assert.equal((await callOn(world, 'GET', path, {})).status, 401);
    const { code } = await createPairing(world.sessions, { subject: alice.id, workspace });
    const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(redeemed.ok);
    assert.equal((await callOn(world, 'GET', path, { token: redeemed.session.accessToken })).status, 401);
  });

  it('shows a member that left without a name, and a typed name nowhere', async () => {
    const { world, alice, bob, workspace } = await sixtyNotes();
    await rowsOf(world.database, `DELETE FROM member WHERE "userId" = '${bob.id}'`);

    const answer = await listOf(world, workspace, alice.token, '?q=checkout&limit=50');

    const authors = answer.notes.map((note) => note.author);
    assert.ok(authors.some((author) => author.kind === 'former-member'));
    assert.ok(authors.every((author) => author.kind !== 'former-member' || author.name === undefined));
    assert.ok(!JSON.stringify(answer).includes('Bob Martin'));
  });
});

describe('a note that did not arrive, and « Send again » (FRU-244)', () => {
  it('carries its delivery, and a new attempt sends it', async () => {
    const { world, alice, bob, workspace, rest, planted } = await sixtyNotes();
    const note = planted.find((planted) => planted.place === rest.id) as Planted;
    await world.accounts.enqueueDelivery(
      rest.id,
      deliveryBody({
        workspace,
        site: { id: note.site },
        identifier: note.reference,
        note: noteFixture({ id: note.id }),
      }),
      BASE,
    );
    // A delivery the worker gave up: no next attempt.
    await rowsOf(world.database, `UPDATE deliveries SET next_at = NULL, attempts = 6, last_status = 503`);
    const id = noteIdOf(note.site, note.id);
    const read = async () =>
      (await listOf(world, workspace, alice.token, `?place=${rest.id}&limit=50`)).notes.find((n) => n.id === id);

    const before = await listOf(world, workspace, alice.token, '?limit=50');
    assert.equal(before.counts.undelivered, 1);
    const gaveUp = (await read())?.delivery;
    assert.equal(typeof gaveUp?.id, 'string');
    assert.deepEqual({ ...gaveUp, id: '' }, { id: '', state: 'gave-up', attempts: 6, lastStatus: 503 });

    const path = `/console/workspaces/${workspace}/notes/${id}/retry`;
    assert.equal((await callOn(world, 'POST', path, { token: bob.token })).status, 403, 'a member does not');
    assert.equal((await callOn(world, 'GET', path, { token: alice.token })).status, 405);
    const other = planted.find((planted) => planted.place !== rest.id) as Planted;
    assert.equal(
      (
        await callOn(world, 'POST', `/console/workspaces/${workspace}/notes/${noteIdOf(other.site, other.id)}/retry`, {
          token: alice.token,
        })
      ).status,
      404,
      'a note with no delivery',
    );
    assert.equal((await callOn(world, 'POST', path, { token: alice.token })).status, 204);
    assert.equal((await read())?.delivery?.state, 'waiting');

    const sent: string[] = [];
    await deliverDue({
      accounts: world.accounts,
      secretsKey: SECRETS_KEY,
      send: async (url) => {
        sent.push(url);

        return { status: 200 };
      },
      now: () => Date.now() + 1_000,
    });
    assert.deepEqual(sent, ['https://hooks.acme.test/fruitback']);
    assert.equal((await read())?.delivery, undefined);
    assert.equal((await listOf(world, workspace, alice.token)).counts.undelivered, 0);
  });

  it('does not send again the note of another workspace', async () => {
    const { world, zed, alice, workspace, rest, planted } = await sixtyNotes();
    const note = planted.find((planted) => planted.place === rest.id) as Planted;
    await world.accounts.enqueueDelivery(
      rest.id,
      deliveryBody({
        workspace,
        site: { id: note.site },
        identifier: note.reference,
        note: noteFixture({ id: note.id }),
      }),
      BASE,
    );
    const zedsOwn = await callOn(world, 'GET', '/console/me', { token: zed.token });
    const other = ((await zedsOwn.json()) as { workspaces: { id: string }[] }).workspaces[0]?.id as string;

    const answer = await callOn(
      world,
      'POST',
      `/console/workspaces/${other}/notes/${noteIdOf(note.site, note.id)}/retry`,
      {
        token: zed.token,
      },
    );

    assert.equal(answer.status, 404);
    assert.equal((await listOf(world, workspace, alice.token)).counts.undelivered, 1);
  });
});
