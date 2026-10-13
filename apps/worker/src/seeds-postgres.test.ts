import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { type Seed, canonicalizePageUrl } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { envWith } from './auth-worker.fixture.ts';
import { runForget } from './cli.ts';
import type { ClientPolicy } from './clients.ts';
import { callOn, signInTo, worlds } from './console-world.fixture.ts';
import { readConfig } from './env.ts';
import { rowsOf } from './postgres.fixture.ts';
import { postgresSeedStore } from './postgres-stores.ts';
import { createPostgresSeedStore } from './seeds-postgres.ts';
import { StoreError } from './store.ts';
import { readStoreConfig } from './stores.ts';

/**
 * The notes in the database of the worker (FRU-218). `store-conformance.test.ts` runs the promises of
 * every `SeedStore` on this store, on PGlite and on a real server. This file holds what is its own:
 * the sites of two workspaces in one database, `forget`, a batch, and the rows it does not trust.
 */

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' };
const SITE = 'https://preview.shared.test';
const PAGE = canonicalizePageUrl(`${SITE}/pricing`);

function seedOf(id: string, client: string | undefined, more: Partial<Seed> = {}): Seed {
  const seed = seedFixture({ id, page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
  const { client: _own, ...rest } = seed;

  return { ...rest, ...(client === undefined ? {} : { client: { id: client, name: client } }), ...more };
}

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the notes in the database, on ${label} (FRU-218)`, { skip }, () => {
    async function opened() {
      const database = await opening(open);

      return { database, store: createPostgresSeedStore(database) };
    }

    it('numbers the notes of the whole instance, FB-1 then FB-2, whatever their site', async () => {
      const { store } = await opened();

      const first = await store.create(seedOf('sd_1', 'site_a'), undefined, POLICY);
      const second = await store.create(seedOf('sd_2', 'site_b'), undefined, POLICY);

      assert.deepEqual(
        [first, second],
        [
          { id: '1', identifier: 'FB-1' },
          { id: '2', identifier: 'FB-2' },
        ],
      );
    });

    it('gives a read that names no site the notes that name none, and never the notes of a site', async () => {
      const { store } = await opened();
      await store.create(seedOf('sd_site', 'site_a'), undefined, POLICY);
      await store.create(seedOf('sd_nobody', undefined), undefined, POLICY);

      const found = await store.findForPage({ url: PAGE, clientId: undefined }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.seed.id),
        ['sd_nobody'],
      );
    });

    it('writes every note of a batch, in order, or none of them', async () => {
      const { database, store } = await opened();
      const batch = [seedOf('sd_a', 'site_a'), seedOf('sd_b', 'site_a'), seedOf('sd_c', 'site_a')];

      const answers = await store.createBatch?.(batch, undefined, POLICY);

      assert.deepEqual(answers, [
        { issue: { id: '1', identifier: 'FB-1' } },
        { issue: { id: '2', identifier: 'FB-2' } },
        { issue: { id: '3', identifier: 'FB-3' } },
      ]);
      // A batch whose second note the database refuses: a text column takes no NUL byte.
      const refused = [seedOf('sd_d', 'site_a'), seedOf('sd_e', 'site_\u0000'), seedOf('sd_f', 'site_a')];
      await assert.rejects(Promise.resolve(store.createBatch?.(refused, undefined, POLICY)), StoreError);
      assert.deepEqual(
        (await rowsOf(database, 'SELECT id FROM seeds ORDER BY id')).map((row) => Number(row.id)),
        [1, 2, 3],
      );
    });

    it('keeps a note whose page has an address longer than a B-tree index takes', async () => {
      const { store } = await opened();
      // 6 400 characters that do not compress: PostgreSQL compresses a value before it indexes it, and
      // a B-tree took 6 000 times the same letter (measured on 17.11).
      const query = Array.from({ length: 200 }, (_, index) => createHash('md5').update(String(index)).digest('hex'));
      const url = canonicalizePageUrl(`${SITE}/search?q=${query.join('')}`);
      const seed = seedOf('sd_long', 'site_a', { page: { url, path: '/search', title: 'Search' } });

      await store.create(seed, undefined, POLICY);

      const found = await store.findForPage({ url, clientId: 'site_a' }, undefined, POLICY);
      assert.deepEqual(
        found.map((issue) => issue.seed.page.url),
        [url],
      );
    });

    it('keeps a note that holds a NUL character, as it was written', async () => {
      const { store } = await opened();
      const seed = seedOf('sd_nul', 'site_a', { note: 'before\u0000after' });

      await store.create(seed, undefined, POLICY);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);
      assert.equal(found?.seed.note, 'before\u0000after');
    });

    it('loses one note, and not the page, to a row that is not a note of that page', async () => {
      const { database, store } = await opened();
      for (const id of ['sd_good', 'sd_not_json', 'sd_other_page']) {
        await store.create(seedOf(id, 'site_a'), undefined, POLICY);
      }
      await rowsOf(database, `UPDATE seeds SET seed = 'not json' WHERE id = 2`);
      await rowsOf(database, `UPDATE seeds SET page_url = '${PAGE}?moved=1' WHERE id = 3`);

      const found = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);
      const moved = await store.findForPage({ url: `${PAGE}?moved=1`, clientId: 'site_a' }, undefined, POLICY);

      assert.deepEqual(
        found.map((issue) => issue.seed.id),
        ['sd_good'],
      );
      // The row says one page and its note another: it is drawn on neither.
      assert.deepEqual(moved, []);
    });

    it('says when a note was written and changed, as dates', async () => {
      const { database, store } = await opened();
      await store.create(seedOf('sd_dated', 'site_a'), undefined, POLICY);
      await rowsOf(database, `UPDATE seeds SET updated_at = ${Date.UTC(2026, 9, 13, 8, 30)}`);

      const [found] = await store.findForPage({ url: PAGE, clientId: 'site_a' }, undefined, POLICY);

      assert.equal(found?.updatedAt, '2026-10-13T08:30:00.000Z');
    });

    /** Three notes: Alice on two sites, Bob on one, and a reply on each. */
    async function withAliceAndBob() {
      const { database, store } = await opened();
      const alice = { name: 'Alice', email: 'Alice@Example.com' };
      await store.create(seedOf('sd_alice_a', 'site_a', { reporter: alice }), undefined, POLICY);
      await store.create(seedOf('sd_bob', 'site_a', { reporter: { name: 'Bob' } }), undefined, POLICY);
      await store.create(seedOf('sd_alice_b', 'site_b', { reporter: alice }), undefined, POLICY);
      await rowsOf(
        database,
        `INSERT INTO seed_comments (seed_id, author, body, created_at) VALUES (1, 'Team', 'one', 1), (2, 'Team', 'two', 2), (3, 'Team', 'three', 3)`,
      );
      const left = async () => ({
        seeds: (await rowsOf(database, 'SELECT id FROM seeds ORDER BY id')).map((row) => Number(row.id)),
        replies: (await rowsOf(database, 'SELECT seed_id FROM seed_comments ORDER BY seed_id')).map((row) =>
          Number(row.seed_id),
        ),
      });

      return { store, left };
    }

    it('lists on a dry run and deletes nothing, then deletes the notes of an address with their replies', async () => {
      const { store, left } = await withAliceAndBob();

      const listed = await store.forget?.({ email: ' alice@example.com ' }, { dryRun: true });

      assert.deepEqual(
        listed?.map((seed) => seed.identifier),
        ['FB-1', 'FB-3'],
      );
      assert.deepEqual(await left(), { seeds: [1, 2, 3], replies: [1, 2, 3] });

      const deleted = await store.forget?.({ email: 'alice@example.com' }, { dryRun: false });

      // The whole instance: the two sites. The note of Bob stays, with its reply.
      assert.deepEqual(
        deleted?.map((seed) => [seed.identifier, seed.pageUrl, seed.note.length > 0]),
        [
          ['FB-1', PAGE, true],
          ['FB-3', PAGE, true],
        ],
      );
      assert.deepEqual(await left(), { seeds: [2], replies: [2] });
    });

    it('deletes by name and by number, and only what each one names', async () => {
      const { store, left } = await withAliceAndBob();

      assert.deepEqual(
        (await store.forget?.({ identifiers: ['FB-3', 'FB-99'] }, { dryRun: false }))?.map((seed) => seed.identifier),
        ['FB-3'],
      );
      assert.deepEqual(await left(), { seeds: [1, 2], replies: [1, 2] });
      assert.deepEqual(
        (await store.forget?.({ name: 'bob' }, { dryRun: false }))?.map((seed) => seed.identifier),
        ['FB-2'],
      );
      assert.deepEqual(await left(), { seeds: [1], replies: [1] });
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
      assert.deepEqual(await left(), { seeds: [1, 2, 3], replies: [1, 2, 3] });

      const done = await runForget(['--id', 'FB-1', '--id', 'FB-3'], env, store);
      assert.ok(done.ok);
      assert.match(done.lines.join('\n'), /deleted 2 note\(s\), with their replies/);
      assert.deepEqual(await left(), { seeds: [2], replies: [2] });
    });
  });
}

describe('the store `postgres`, as a worker selects it (FRU-218)', () => {
  const envOf = worlds();

  it('needs the address of the database, and is not the store of a worker that names none', () => {
    const selected = readConfig(envWith({ FRUITBACK_STORE: 'postgres' }));
    assert.ok(selected.ok, selected.ok ? '' : selected.missing.join(', '));
    assert.equal(selected.config.store.provider, 'postgres');

    assert.deepEqual(readStoreConfig({ FRUITBACK_STORE: 'postgres' }), {
      ok: false,
      missing: ['FRUITBACK_DATABASE_URL'],
    });
    // Not the default: a worker that names no store is on Linear, as before.
    assert.deepEqual(readStoreConfig({}), { ok: false, missing: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'] });
  });

  it('says its name and its scope before any call, as the store it loads says them', async () => {
    const world = await envOf();
    const real = createPostgresSeedStore(world.database);
    // Nothing listens on port 1: these two are read with no call to the database.
    const lazy = postgresSeedStore('postgres://fruitback:not-a-password@127.0.0.1:1/fruitback', 'public');

    assert.deepEqual([lazy.name, lazy.scope(undefined), lazy.stages], [real.name, real.scope(undefined), real.stages]);
    assert.deepEqual(
      Object.keys(lazy).sort(),
      Object.keys(real).sort(),
      'the store that is loaded later does not have the methods of the real one',
    );
  });

  it('never gives a site of one workspace the notes of a site of another, on one page of one address', async () => {
    const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
    const store = createPostgresSeedStore(world.database);
    // Two workspaces review the same site: one database, one page, two sites.
    const sites: string[] = [];
    for (const who of ['alice@acme.dev', 'bob@globex.dev']) {
      const owner = await signInTo(world, who);
      const workspace = await world.accounts.createWorkspace(who, owner.id);
      sites.push((await world.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' })).id);
    }
    const [acme, globex] = sites as [string, string];
    const note = { ...seedOf('sd_acme', acme), note: 'A note of Acme.' };

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

      return ((await answer.json()) as { issues: { seed: { note: string } }[] }).issues.map((issue) => issue.seed.note);
    };
    assert.deepEqual(await read(acme), ['A note of Acme.']);
    assert.deepEqual(await read(globex), []);
  });
});
