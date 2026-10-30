import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it, vi } from 'vitest';
import { type Note, canonicalizePageUrl } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { envWith } from './auth-worker.fixture.ts';
import { runForget } from './cli.ts';
import type { ClientPolicy } from './clients.ts';
import { callOn, signInTo, worlds } from './console-world.fixture.ts';
import { readConfig } from './env.ts';
import { rowsOf } from './postgres.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { postgresNoteStore } from './postgres-stores.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { StoreError } from './store.ts';
import { readStoreConfig } from './stores.ts';

/**
 * The notes in the database of the worker (FRU-218). `store-conformance.test.ts` runs the promises of
 * every `NoteStore` on this store, on PGlite and on a real server. This file holds what is its own:
 * the sites of two workspaces in one database, `forget`, a batch, and the rows it does not trust.
 */

const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};
const SITE = 'https://preview.shared.test';
const PAGE = canonicalizePageUrl(`${SITE}/pricing`);

function noteFixtureOf(id: string, client: string | undefined, more: Partial<Note> = {}): Note {
  const note = noteFixture({ id, page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
  const { client: _own, ...rest } = note;

  return { ...rest, ...(client === undefined ? {} : { client: { id: client, name: client } }), ...more };
}

const { opening } = databasesOfACase();

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the notes in the database, on ${label} (FRU-218)`, { skip: skip !== false }, () => {
    async function opened() {
      const database = await opening(open);

      return { database, store: createPostgresNoteStore(database) };
    }

    it('numbers the notes of the whole instance, FB-1 then FB-2, whatever their site', async () => {
      const { store } = await opened();

      const first = await store.create(noteFixtureOf('sd_1', 'site_a'), undefined, POLICY);
      const second = await store.create(noteFixtureOf('sd_2', 'site_b'), undefined, POLICY);

      assert.deepEqual(
        [first, second],
        [
          { id: '1', identifier: 'FB-1' },
          { id: '2', identifier: 'FB-2' },
        ],
      );
    });

    it('writes a reply under a note of its site only, and under no number that is not a note (FRU-257)', async () => {
      const { database, store } = await opened();
      const ours = await store.create(noteFixtureOf('sd_ours', 'site_a'), undefined, POLICY);
      const reply = { body: 'Seen.', author: { kind: 'visitor' as const } };

      assert.equal(await store.reply?.({ issue: ours.id, clientId: 'site_b' }, reply, undefined, POLICY), undefined);
      assert.equal(await store.reply?.({ issue: ours.id, clientId: undefined }, reply, undefined, POLICY), undefined);
      assert.equal(await store.reply?.({ issue: '999', clientId: 'site_a' }, reply, undefined, POLICY), undefined);
      assert.equal(await store.reply?.({ issue: 'FB-1', clientId: 'site_a' }, reply, undefined, POLICY), undefined);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM note_comments'), []);

      const written = await store.reply?.({ issue: ours.id, clientId: 'site_a' }, reply, undefined, POLICY);
      assert.ok(written !== undefined);
      assert.equal((await rowsOf(database, 'SELECT id FROM note_comments')).length, 1);
    });

    it('answers the stage of before as the write finds it, under the lock of the row (FRU-468)', async () => {
      const { database, store } = await opened();
      // The note first: on a real server, the first call of the store applies the migrations.
      const note = await store.create(noteFixtureOf('sd_moved', 'site_a'), undefined, POLICY);
      await rowsOf(
        database,
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_a', 'A', 'ws_a', now())`,
      );
      await rowsOf(
        database,
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_a', 'ws_a', '${SITE}', 'everyone', 1)`,
      );
      const target = { issue: note.id, clientId: 'site_a' };
      const todo = { key: null, stage: 'todo' as const };

      assert.deepEqual(await store.setStatus?.(target, todo, undefined), { stage: 'todo', was: 'new', page: PAGE });
      assert.deepEqual(await store.setStatus?.(target, todo, undefined), { stage: 'todo', was: 'todo', page: PAGE });
      await store.setStatus?.(target, { key: null, stage: 'done' }, undefined);

      // Another write holds the row and moves the note to To do while this one waits: the stage of
      // before is the one that write left, never the one before it. PGlite has one connection, where
      // nothing waits: the case is the real server's.
      if (label === 'PGlite') return;
      const client = await (await (database as PgDatabase).pool()).connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE notes SET stage = 'todo' WHERE id = $1`, [Number(note.id)]);
        const waiting = store.setStatus?.(target, todo, undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await client.query('COMMIT');
        assert.deepEqual(await waiting, { stage: 'todo', was: 'todo', page: PAGE });
      } finally {
        client.release();
      }
    });

    it('reads twenty replies of a long thread, and one note for a write, never the whole page (FRU-499)', async () => {
      const { database } = await opened();
      // The rows that each statement of a read answers, in order.
      const answered: number[] = [];
      const counted = createPostgresNoteStore({
        ...database,
        run: (work) =>
          database.run(async (db) => {
            const rows = await work(db);
            if (Array.isArray(rows)) answered.push(rows.length);

            return rows;
          }),
      });
      const long = await counted.create(noteFixtureOf('sd_long', 'site_a'), undefined, POLICY);
      const reply = { body: 'Seen.', author: { kind: 'visitor' as const } };
      for (let n = 0; n < 25; n++)
        await counted.reply?.({ issue: long.id, clientId: 'site_a' }, reply, undefined, POLICY);
      for (let n = 0; n < 4; n++) {
        const other = await counted.create(noteFixtureOf(`sd_other_${n}`, 'site_a'), undefined, POLICY);
        for (let r = 0; r < 3; r++)
          await counted.reply?.({ issue: other.id, clientId: 'site_a' }, reply, undefined, POLICY);
      }

      answered.length = 0;
      const page = await counted.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);
      // Five notes, then 20 + 4 × 3 replies: the database stops at twenty for the long thread.
      assert.deepEqual(answered, [5, 32]);
      const shown = page.find((issue) => issue.id === long.id);
      assert.equal(shown?.comments?.length, 20);

      for (const by of ['issue', 'note'] as const) {
        answered.length = 0;
        const id = by === 'issue' ? long.id : 'sd_long';
        const one = await counted.findNote?.({ url: PAGE, clientId: 'site_a', id, by }, undefined, POLICY);
        assert.deepEqual(one, shown);
        // One row of `notes`, and its twenty newest replies.
        assert.deepEqual(answered, [1, 20]);
      }
    });

    it('finds a note by the id the widget gave, when its row writes that id escaped (review of #733)', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_café', 'site_a'), undefined, POLICY);
      await store.create(noteFixtureOf('sd_plain', 'site_a'), undefined, POLICY);
      // As a writer that escapes what is not ASCII writes it, and one that escapes `_`: the same JSON.
      await rowsOf(
        database,
        `UPDATE notes SET payload = replace(replace(payload, 'é', '\\u00e9'), 'sd_plain', 'sd\\u005fplain')`,
      );
      assert.deepEqual(
        (await rowsOf(database, 'SELECT payload FROM notes ORDER BY id')).map(
          (row) => /"id":"([^"]*)"/.exec(String(row.payload))?.[1],
        ),
        ['sd_caf\\u00e9', 'sd\\u005fplain'],
      );
      const lookUp = (id: string) =>
        store.findNote?.({ url: PAGE, clientId: 'site_a', id, by: 'note' }, undefined, POLICY);

      assert.equal((await lookUp('sd_café'))?.note.id, 'sd_café');
      assert.equal((await lookUp('sd_plain'))?.note.id, 'sd_plain');
      assert.equal(await lookUp('sd_cafe'), undefined);
    });

    it('gives a read that names no site the notes that name none, and never the notes of a site', async () => {
      const { store } = await opened();
      await store.create(noteFixtureOf('sd_site', 'site_a'), undefined, POLICY);
      await store.create(noteFixtureOf('sd_nobody', undefined), undefined, POLICY);

      const found = await store.findForPage({ url: PAGE, clientId: undefined }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.note.id),
        ['sd_nobody'],
      );
    });

    it('writes every note of a batch, in order, or none of them', async () => {
      const { database, store } = await opened();
      const batch = [noteFixtureOf('sd_a', 'site_a'), noteFixtureOf('sd_b', 'site_a'), noteFixtureOf('sd_c', 'site_a')];

      const answers = await store.createBatch?.(batch, undefined, POLICY);

      assert.deepEqual(answers, [
        { issue: { id: '1', identifier: 'FB-1' } },
        { issue: { id: '2', identifier: 'FB-2' } },
        { issue: { id: '3', identifier: 'FB-3' } },
      ]);
      // A batch whose second note the database refuses: a text column takes no NUL byte.
      const refused = [
        noteFixtureOf('sd_d', 'site_a'),
        noteFixtureOf('sd_e', 'site_\u0000'),
        noteFixtureOf('sd_f', 'site_a'),
      ];
      await assert.rejects(Promise.resolve(store.createBatch?.(refused, undefined, POLICY)), StoreError);
      assert.deepEqual(
        (await rowsOf(database, 'SELECT id FROM notes ORDER BY id')).map((row) => Number(row.id)),
        [1, 2, 3],
      );
    });

    it('keeps a note whose page has an address longer than a B-tree index takes', async () => {
      const { store } = await opened();
      // 6 400 characters that do not compress: PostgreSQL compresses a value before it indexes it, and
      // a B-tree took 6 000 times the same letter (measured on 17.11).
      const query = Array.from({ length: 200 }, (_, index) => createHash('md5').update(String(index)).digest('hex'));
      const url = canonicalizePageUrl(`${SITE}/search?q=${query.join('')}`);
      const note = noteFixtureOf('sd_long', 'site_a', { page: { url, path: '/search', title: 'Search' } });

      await store.create(note, undefined, POLICY);

      const found = await store.findForPage({ url, clientId: 'site_a' }, undefined, POLICY);
      assert.deepEqual(
        found.map((issue) => issue.note.page.url),
        [url],
      );
    });

    it('keeps a note that holds a NUL character, as it was written', async () => {
      const { store } = await opened();
      const note = noteFixtureOf('sd_nul', 'site_a', { text: 'before\u0000after' });

      await store.create(note, undefined, POLICY);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);
      assert.equal(found?.note.text, 'before\u0000after');
    });

    it('loses one note, and not the page, to a row that is not a note of that page', async () => {
      const { database, store } = await opened();
      for (const id of ['sd_good', 'sd_not_json', 'sd_other_page']) {
        await store.create(noteFixtureOf(id, 'site_a'), undefined, POLICY);
      }
      await rowsOf(database, `UPDATE notes SET payload = 'not json' WHERE id = 2`);
      await rowsOf(database, `UPDATE notes SET page_url = '${PAGE}?moved=1' WHERE id = 3`);

      const found = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);
      const moved = await store.findForPage({ url: `${PAGE}?moved=1`, clientId: 'site_a' }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.note.id),
        ['sd_good'],
      );
      // The row says one page and its note another: it is drawn on neither.
      assert.deepEqual(moved, []);
    });

    it('reports no url, because there is no interface to open', async () => {
      const { store } = await opened();

      const created = await store.create(noteFixtureOf('sd_no_url', 'site_a'), undefined, POLICY);
      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.equal(created.url, undefined);
      assert.ok(found !== undefined);
      assert.equal(found.url, undefined);
    });

    it('names no state, so the widget writes the stage in its own words (FRU-114)', async () => {
      const { store } = await opened();
      await store.create(noteFixtureOf('sd_no_state', 'site_a'), undefined, POLICY);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.equal(found?.stage, 'new');
      assert.equal(found?.stateName, '');
    });

    it('keeps each thread on its own note', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('first', 'site_a'), undefined, POLICY);
      await store.create(noteFixtureOf('second', 'site_a'), undefined, POLICY);
      await rowsOf(
        database,
        `INSERT INTO note_comments (note_id, body, created_at) VALUES (1, 'pour la premiere', 1), (2, 'pour la seconde', 1)`,
      );

      const found = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => [issue.note.id, issue.comments?.map((comment) => comment.body)]),
        [
          ['first', ['pour la premiere']],
          ['second', ['pour la seconde']],
        ],
      );
    });

    it('leaves the author out when nobody signed it', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_unsigned', 'site_a'), undefined, POLICY);
      await rowsOf(database, `INSERT INTO note_comments (note_id, body, created_at) VALUES (1, 'sans signature', 1)`);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      const comment = found?.comments?.[0];
      assert.ok(comment !== undefined);
      assert.ok(!('author' in comment), 'an unsigned reply must omit the field, not carry an empty name');
    });

    it('drops a row that parses but is not a note', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_good', 'site_a'), undefined, POLICY);
      await store.create(noteFixtureOf('sd_hello', 'site_a'), undefined, POLICY);
      await rowsOf(database, `UPDATE notes SET payload = '{ "hello": "world" }' WHERE id = 2`);

      const found = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.note.id),
        ['sd_good'],
      );
    });

    it('drops a row whose column and note disagree about which page it is on', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_here', 'site_a'), undefined, POLICY);
      const elsewhere = noteFixtureOf('sd_elsewhere', 'site_a', {
        page: { url: canonicalizePageUrl(`${SITE}/autre`), path: '/autre', title: 'Autre' },
      });
      await store.create(elsewhere, undefined, POLICY);
      // The column says this page, and the note in it says another.
      await rowsOf(database, `UPDATE notes SET page_url = '${PAGE}' WHERE id = 2`);

      const found = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.note.id),
        ['sd_here'],
      );
    });

    it('says when a note was written and changed, as dates', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_dated', 'site_a'), undefined, POLICY);
      await rowsOf(database, `UPDATE notes SET updated_at = ${Date.UTC(2026, 9, 13, 8, 30)}`);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.equal(found?.updatedAt, '2026-10-13T08:30:00.000Z');
    });

    /** Three notes: Alice on two sites, Bob on one, and a reply on each. */
    async function withAliceAndBob() {
      const { database, store } = await opened();
      const alice = { name: 'Alice', email: 'Alice@Example.com' };
      await store.create(noteFixtureOf('sd_alice_a', 'site_a', { reporter: alice }), undefined, POLICY);
      await store.create(noteFixtureOf('sd_bob', 'site_a', { reporter: { name: 'Bob' } }), undefined, POLICY);
      await store.create(noteFixtureOf('sd_alice_b', 'site_b', { reporter: alice }), undefined, POLICY);
      await rowsOf(
        database,
        `INSERT INTO note_comments (note_id, author, body, created_at) VALUES (1, 'Team', 'one', 1), (2, 'Team', 'two', 2), (3, 'Team', 'three', 3)`,
      );
      const left = async () => ({
        notes: (await rowsOf(database, 'SELECT id FROM notes ORDER BY id')).map((row) => Number(row.id)),
        replies: (await rowsOf(database, 'SELECT note_id FROM note_comments ORDER BY note_id')).map((row) =>
          Number(row.note_id),
        ),
      });

      return { store, left };
    }

    it('lists on a dry run and deletes nothing, then deletes the notes of an address with their replies', async () => {
      const { store, left } = await withAliceAndBob();

      const listed = await store.forget?.({ email: ' alice@example.com ' }, { dryRun: true });

      assert.deepEqual(
        listed?.map((note) => note.identifier),
        ['FB-1', 'FB-3'],
      );
      assert.deepEqual(await left(), { notes: [1, 2, 3], replies: [1, 2, 3] });

      const deleted = await store.forget?.({ email: 'alice@example.com' }, { dryRun: false });

      // The whole instance: the two sites. The note of Bob stays, with its reply.
      assert.deepEqual(
        deleted?.map((note) => [note.identifier, note.pageUrl, note.text.length > 0]),
        [
          ['FB-1', PAGE, true],
          ['FB-3', PAGE, true],
        ],
      );
      assert.deepEqual(await left(), { notes: [2], replies: [2] });
    });

    it('deletes by name and by number, and only what each one names', async () => {
      const { store, left } = await withAliceAndBob();

      assert.deepEqual(
        (await store.forget?.({ identifiers: ['FB-3', 'FB-99'] }, { dryRun: false }))?.map((note) => note.identifier),
        ['FB-3'],
      );
      assert.deepEqual(await left(), { notes: [1, 2], replies: [1, 2] });
      assert.deepEqual(
        (await store.forget?.({ name: 'bob' }, { dryRun: false }))?.map((note) => note.identifier),
        ['FB-2'],
      );
      assert.deepEqual(await left(), { notes: [1], replies: [1] });
    });

    it('finds the notes signed with a name, whatever its case and the spaces around it', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_a', 'site_a', { reporter: { name: ' Alice ' } }), undefined, POLICY);
      await store.create(noteFixtureOf('sd_b', 'site_a', { reporter: { name: 'Alicia' } }), undefined, POLICY);
      await store.create(noteFixtureOf('sd_c', 'site_a'), undefined, POLICY);

      const listed = await store.forget?.({ name: 'ALICE' }, { dryRun: true });

      assert.deepEqual(
        listed?.map((note) => note.identifier),
        ['FB-1'],
      );
      assert.deepEqual(await rowsOf(database, 'SELECT count(*)::int AS n FROM notes'), [{ n: 3 }]);
    });

    it('parses only the rows that can hold the address or the name (FRU-539)', async () => {
      const { store } = await opened();
      await store.create(
        noteFixtureOf('sd_alice', 'site_a', { reporter: { name: 'Alice', email: 'alice@example.com' } }),
        undefined,
        POLICY,
      );
      for (let n = 0; n < 12; n++) {
        await store.create(noteFixtureOf(`sd_bob_${n}`, 'site_b', { reporter: { name: 'Bob' } }), undefined, POLICY);
      }
      const parse = vi.spyOn(JSON, 'parse');
      try {
        const listed = await store.forget?.({ email: 'Alice@Example.com' }, { dryRun: true });
        const parsed = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('sd_bob_'));

        assert.deepEqual(
          listed?.map((note) => note.identifier),
          ['FB-1'],
        );
        assert.equal(parsed.length, 0, 'no note of Bob is parsed to forget Alice');
      } finally {
        parse.mockRestore();
      }
      assert.equal((await store.forget?.({ name: ' BOB ' }, { dryRun: true }))?.length, 12);
    });

    it('finds an address or a name that a row escapes, in any case (FRU-539)', async () => {
      const { database, store } = await opened();
      const signed = async (id: string, name: string, email?: string) =>
        store.create(
          noteFixtureOf(id, 'site_a', { reporter: { name, ...(email === undefined ? {} : { email }) } }),
          undefined,
          POLICY,
        );
      await signed('sd_escaped', 'Alice', 'Alice@Example.com');
      await signed('sd_kelvin', 'Kim');
      await signed('sd_dotted', 'AL\u0130');
      await signed('sd_plain', 'Ali');
      await signed('sd_slash', 'AC/DC');
      // As a restore or an operator can write them: `A` for `A`, and `\/` for `/`.
      await rowsOf(
        database,
        `UPDATE notes SET payload = replace(payload, 'Alice@Example', '\\u0041lice@Example') WHERE id = 1`,
      );
      await rowsOf(database, `UPDATE notes SET payload = replace(payload, 'AC/DC', 'AC\\/DC') WHERE id = 5`);
      const found = async (which: { email: string } | { name: string }) =>
        (await store.forget?.(which, { dryRun: true }))?.map((note) => note.identifier);

      assert.deepEqual(await found({ email: 'ALICE@example.com' }), ['FB-1']);
      assert.deepEqual(await found({ name: 'kim' }), ['FB-2']);
      assert.deepEqual(await found({ name: 'AL\u0130' }), ['FB-3']);
      assert.deepEqual(await found({ name: 'ali' }), ['FB-4']);
      assert.deepEqual(await found({ name: 'ac/dc' }), ['FB-5']);
    });

    it('reads and deletes more notes than one statement takes (FRU-539)', async () => {
      const { database, store } = await opened();
      await store.create(noteFixtureOf('sd_bob', 'site_a', { reporter: { name: 'Bob' } }), undefined, POLICY);
      await store.create(noteFixtureOf('sd_carol', 'site_a', { reporter: { name: 'Carol' } }), undefined, POLICY);
      await rowsOf(
        database,
        `INSERT INTO notes (client_id, page_url, stage, payload, created_at, updated_at)
         SELECT client_id, page_url, stage, payload, created_at, updated_at FROM notes, generate_series(1, 1200) WHERE id = 1`,
      );

      const deleted = await store.forget?.({ name: 'bob' }, { dryRun: false });

      assert.equal(deleted?.length, 1201);
      assert.deepEqual(new Set(deleted?.map((note) => note.id)), new Set(['sd_bob']));
      assert.deepEqual(
        (await rowsOf(database, 'SELECT id FROM notes')).map((row) => Number(row.id)),
        [2],
      );
    });

    it('is not stopped by a row that is not JSON, and leaves that row alone', async () => {
      const { database, store } = await opened();
      await store.create(
        noteFixtureOf('sd_alice', 'site_a', { reporter: { name: 'Alice', email: 'alice@example.com' } }),
        undefined,
        POLICY,
      );
      await store.create(noteFixtureOf('sd_broken', 'site_a'), undefined, POLICY);
      await rowsOf(database, `UPDATE notes SET payload = '{not json' WHERE id = 2`);

      const forgotten = await store.forget?.({ email: 'alice@example.com' }, { dryRun: false });

      assert.equal(forgotten?.length, 1);
      assert.deepEqual(
        (await rowsOf(database, 'SELECT id FROM notes')).map((row) => Number(row.id)),
        [2],
      );
    });

    it('is what `forget` of the command deletes, and a number that names no note deletes none', async () => {
      const { store, left } = await withAliceAndBob();
      const env = envWith({ FRUITBACK_STORE: 'postgres' });

      const dry = await runForget(['--email', 'alice@example.com', '--dry-run'], env, store);
      assert.ok(dry.ok);
      assert.match(
        dry.lines.join('\n'),
        /2 note\(s\) give alice@example\.com\. Nothing was deleted[\s\S]*FB-1 [\s\S]*FB-3 /,
      );
      const typo = await runForget(['--id', 'FB-1', '--id', 'FB-99'], env, store);
      assert.deepEqual([typo.ok, typo.lines], [false, ['no note is FB-99. Nothing was deleted.']]);
      assert.deepEqual(await left(), { notes: [1, 2, 3], replies: [1, 2, 3] });

      const done = await runForget(['--id', 'FB-1', '--id', 'FB-3'], env, store);
      assert.ok(done.ok);
      assert.match(done.lines.join('\n'), /deleted 2 note\(s\), with their replies/);
      assert.deepEqual(await left(), { notes: [2], replies: [2] });
    });
  });
}

describe('the store `postgres`, as a worker selects it (FRU-218)', () => {
  const envOf = worlds();

  it('needs the address of the database, and is the store of a worker that names none (FRU-225)', () => {
    const selected = readConfig(envWith({ FRUITBACK_STORE: 'postgres' }));
    assert.ok(selected.ok, selected.ok ? '' : selected.missing.join(', '));
    assert.equal(selected.config.store.provider, 'postgres');

    assert.deepEqual(readStoreConfig({ FRUITBACK_STORE: 'postgres' }), {
      ok: false,
      missing: ['FRUITBACK_DATABASE_URL'],
    });
    // The default since FRU-225: a worker that names no store keeps its notes in its database.
    assert.deepEqual(readStoreConfig({}), { ok: false, missing: ['FRUITBACK_DATABASE_URL'] });
    const unnamed = readConfig(envWith({ FRUITBACK_STORE: undefined }));
    assert.ok(unnamed.ok, unnamed.ok ? '' : unnamed.missing.join(', '));
    assert.equal(unnamed.config.store.provider, 'postgres');
  });

  it('says its name and its scope before any call, as the store it loads says them', async () => {
    const world = await envOf();
    const real = createPostgresNoteStore(world.database);
    // Nothing listens on port 1: these two are read with no call to the database.
    const lazy = postgresNoteStore('postgres://fruitback:not-a-password@127.0.0.1:1/fruitback', 'public');

    assert.deepEqual([lazy.name, lazy.scope(undefined), lazy.stages], [real.name, real.scope(undefined), real.stages]);
    assert.deepEqual(
      Object.keys(lazy).sort(),
      Object.keys(real).sort(),
      'the store that is loaded later does not have the methods of the real one',
    );
  });

  it('never gives a site of one workspace the notes of a site of another, on one page of one address', async () => {
    const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
    const store = createPostgresNoteStore(world.database);
    // Two workspaces review the same site: one database, one page, two sites.
    const sites: string[] = [];
    for (const who of ['alice@acme.dev', 'bob@globex.dev']) {
      const owner = await signInTo(world, who);
      const workspace = await world.accounts.createWorkspace(who, owner.id);
      sites.push((await world.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' })).id);
    }
    const [acme, globex] = sites as [string, string];
    const note = { ...noteFixtureOf('sd_acme', acme), text: 'A note of Acme.' };

    const written = await callOn(world, 'POST', '/feedback', { origin: SITE, body: note }, { store });
    assert.equal(written.status, 201, await written.clone().text());

    const read = async (site: string): Promise<string[]> => {
      const answer = await callOn(
        world,
        'GET',
        `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`,
        { origin: SITE },
        { store },
      );
      assert.equal(answer.status, 200, await answer.clone().text());

      return ((await answer.json()) as { issues: { note: { text: string } }[] }).issues.map((issue) => issue.note.text);
    };
    assert.deepEqual(await read(acme), ['A note of Acme.']);
    assert.deepEqual(await read(globex), []);
  });
});
