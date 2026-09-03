import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import type { ClientPolicy } from './clients.ts';
import { StoreError } from './store.ts';
import { closeSqliteConnections, createSqliteStore, createSqliteStoreSpec, sqliteConnectionsOpened } from './sqlite.ts';

/**
 * The second connector, and the one that had to be uncomfortable (SKG-524).
 *
 * These run against a real file rather than `:memory:`, because half of what this store promises is
 * about a file: that the schema is created on first open, that reopening finds the seeds again, and
 * that one connection is shared. An in-memory database would make all three vacuously true.
 */

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public' };
const QUIET: ClientPolicy = { ...POLICY, showComments: false };

let directories: string[] = [];

/** Writes straight to the table, standing in for whatever eventually posts a reply. */
function reply(path: string, seedId: number, body: string, author: string | null, at: string): void {
  const database = new DatabaseSync(path);
  database
    .prepare('INSERT INTO comments (seed_id, author, body, created_at) VALUES (?, ?, ?, ?)')
    .run(seedId, author, body, at);
  database.close();
}

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-sqlite-'));
  directories.push(directory);

  return join(directory, 'fruitback.db');
}

afterEach(() => {
  closeSqliteConnections();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe('a seed in a file', () => {
  it('stores one and reads it back as the same seed', async () => {
    // The assertion that matters most, exactly as it does for Linear: what comes back out is what
    // went in. A store that loses a field loses the note's meaning without losing the note.
    const store = createSqliteStore({ path: freshPath() });
    const seed = seedFixture();

    const created = await store.create(seed, undefined, POLICY);
    const issues = await store.findForPage({ url: seed.page.url, clientId: undefined }, undefined, POLICY);

    assert.equal(created.identifier, 'FB-1');
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.seed, seed);
  });

  it('reports no url, because there is no interface to open', async () => {
    // The place SQLite did not fit the contract, pinned. Inventing a URL to satisfy a schema would
    // have put a link on every pin that leads back to the page the reader is already on.
    const store = createSqliteStore({ path: freshPath() });
    const seed = seedFixture();

    const created = await store.create(seed, undefined, POLICY);
    const issues = await store.findForPage({ url: seed.page.url, clientId: undefined }, undefined, POLICY);

    assert.equal(created.url, undefined);
    assert.equal(issues[0]?.url, undefined);
  });

  it('answers with the stage as the state, because the vocabulary is already ours', async () => {
    // Linear needs a projection because its states are its own. Here there is nothing to translate,
    // and this asserts the absence of a translation layer rather than its behaviour.
    const store = createSqliteStore({ path: freshPath() });
    const seed = seedFixture();

    await store.create(seed, undefined, POLICY);
    const issues = await store.findForPage({ url: seed.page.url, clientId: undefined }, undefined, POLICY);

    assert.equal(issues[0]?.stage, 'seeded');
    assert.equal(issues[0]?.stateName, 'Seeded');
  });

  it('finds a page exactly, where a substring filter would mix two pages', async () => {
    // Linear can only filter with `description contains`, so `/pricing` also matches
    // `/pricing?tab=annual` and the connector re-checks afterwards. `findForPage` states the
    // intention rather than the method precisely so this one can be a plain equality.
    const store = createSqliteStore({ path: freshPath() });
    const base = seedFixture();
    const longer = seedFixture({ id: 'seed-longer', page: { ...base.page, url: `${base.page.url}?tab=annual` } });

    await store.create(base, undefined, POLICY);
    await store.create(longer, undefined, POLICY);
    const issues = await store.findForPage({ url: base.page.url, clientId: undefined }, undefined, POLICY);

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.seed.id, base.id);
  });

  it('keeps one client from reading another’s notes', async () => {
    const store = createSqliteStore({ path: freshPath() });
    const acme = seedFixture({ id: 'seed-acme', client: { id: 'acme' } });
    const globex = seedFixture({ id: 'seed-globex', client: { id: 'globex' } });

    await store.create(acme, undefined, POLICY);
    await store.create(globex, undefined, POLICY);
    const issues = await store.findForPage({ url: acme.page.url, clientId: 'acme' }, undefined, POLICY);

    assert.deepEqual(
      issues.map((issue) => issue.seed.id),
      ['seed-acme'],
    );
  });

  it('numbers its own handles, so a reporter has something to quote', async () => {
    const store = createSqliteStore({ path: freshPath() });

    const first = await store.create(seedFixture({ id: 'a' }), undefined, POLICY);
    const second = await store.create(seedFixture({ id: 'b' }), undefined, POLICY);

    assert.deepEqual([first.identifier, second.identifier], ['FB-1', 'FB-2']);
  });
});

describe('the file survives the process', () => {
  it('creates its schema on first open and finds the seeds again on the next one', async () => {
    // The whole self-hosting promise in one assertion: a restarted container serves the same pins.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);

    closeSqliteConnections();
    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.equal(issues.length, 1);
  });

  it('opens the file once, however many stores are built on it', async () => {
    // `handleRequest` still falls back to building a store when the transport did not hand it one,
    // so without the shared handle that path opens a database per request — the exact hazard SKG-522
    // was written to prevent, and one nothing observable would have reported.
    const path = freshPath();
    const seed = seedFixture();

    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    await createSqliteStore({ path }).create(seedFixture({ id: 'second' }), undefined, POLICY);
    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    // How many handles were **opened**, not how many the map holds. Both spellings of this test were
    // wrong before this one: asserting that both writes landed passes without any sharing, because
    // SQLite lets one process open a file twice; and asserting `connections.size` passes too, because
    // the map is keyed by path and a non-reusing `connect` just overwrites the entry. Measured:
    // removing the reuse leaves this at 3.
    assert.equal(sqliteConnectionsOpened(), 1);
    assert.equal(issues.length, 2);
  });

  it('closes the handle when the file turns out not to be a database', async () => {
    // The constructor succeeds on any file; the first PRAGMA is what discovers it is not a database —
    // a bad restore, a truncated volume. The handle is open by then, and `handleRequest` still falls
    // back to building a store per request, so an unclosed one leaks a descriptor on every request
    // until the process runs out. Raised in review on SKG-524.
    const path = freshPath();
    writeFileSync(path, 'ceci n’est pas une base de donnees');
    const store = createSqliteStore({ path });
    const descriptors = () => readdirSync('/dev/fd').length;

    const before = descriptors();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(() => store.create(seedFixture(), undefined, POLICY), StoreError);
    }

    // **Open file descriptors**, not `connections.size`. The broken handle is never added to the map,
    // so the map is empty whether it was closed or not — the first version of this test asserted
    // exactly that and passed against the leak it was written to catch. Measured: five unclosed
    // handles hold five descriptors, and closing them gives every one back.
    assert.equal(sqliteConnectionsOpened(), 5);
    assert.equal(descriptors(), before, 'a failed initialisation must not keep the file open');
  });

  it('reports a path it cannot open as the store being unavailable', async () => {
    // A 502 the widget knows to retry, not a 400 blaming the reporter for a directory the operator
    // did not mount.
    const store = createSqliteStore({ path: join(freshPath(), 'no', 'such', 'directory', 'fruitback.db') });

    await assert.rejects(() => store.create(seedFixture(), undefined, POLICY), StoreError);
  });
});

describe('the replies', () => {
  it('come back oldest first, so the thread reads as a conversation', async () => {
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    reply(path, 1, 'et celle-ci ensuite', 'Bob', '2026-02-02T00:00:00.000Z');
    reply(path, 1, 'celle-ci en premier', 'Alice', '2026-01-01T00:00:00.000Z');

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.deepEqual(
      issues[0]?.comments?.map((comment) => comment.body),
      ['celle-ci en premier', 'et celle-ci ensuite'],
    );
  });

  it('says empty when it looked and says nothing when it did not', async () => {
    // Absent and empty mean different things (SKG-502): a client with replies switched off must not
    // read as a team that never answered.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);

    const asked = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );
    const quiet = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      QUIET,
    );

    assert.deepEqual(asked[0]?.comments, []);
    assert.equal(quiet[0]?.comments, undefined);
    assert.ok(quiet[0] !== undefined && !('comments' in quiet[0]), 'the field must be absent, not undefined');

    // With a reply present, so the two branches differ by more than an empty array. Without this the
    // suite passed against a store that read the table whatever the policy said: a seed with no
    // replies falls back to `undefined` either way, so the mutation was invisible.
    reply(path, 1, 'une reponse', 'Alice', '2026-01-01T00:00:00.000Z');
    const withReply = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      QUIET,
    );

    assert.ok(
      withReply[0] !== undefined && !('comments' in withReply[0]),
      'showComments: false must not put the table’s rows on the pin',
    );
  });

  it('keeps each thread on its own seed', async () => {
    // One statement fetches every reply for the page, so a mis-grouped row would put one reporter's
    // answer under another's note — which reads as the team replying to the wrong person.
    const path = freshPath();
    const first = seedFixture({ id: 'first' });
    const second = seedFixture({ id: 'second' });
    const store = createSqliteStore({ path });
    await store.create(first, undefined, POLICY);
    await store.create(second, undefined, POLICY);
    closeSqliteConnections();

    reply(path, 1, 'pour la premiere', null, '2026-01-01T00:00:00.000Z');
    reply(path, 2, 'pour la seconde', null, '2026-01-01T00:00:00.000Z');

    const issues = await createSqliteStore({ path }).findForPage(
      { url: first.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.deepEqual(
      issues.map((issue) => [issue.seed.id, issue.comments?.map((comment) => comment.body)]),
      [
        ['first', ['pour la premiere']],
        ['second', ['pour la seconde']],
      ],
    );
  });

  it('caps a long thread rather than shipping all of it to the page', async () => {
    // A pin is not a forum. Past the cap the conversation belongs wherever the team actually talks —
    // and an uncapped thread is a payload that grows without anyone deciding it should.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    for (let index = 0; index < 25; index += 1) {
      reply(path, 1, `reponse ${index}`, 'Alice', `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`);
    }

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.equal(issues[0]?.comments?.length, 20);
    // The oldest ones, since that is the end the thread reads from.
    assert.equal(issues[0]?.comments?.[0]?.body, 'reponse 0');
  });

  it('leaves the author out when nobody signed it', async () => {
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    reply(path, 1, 'sans signature', null, '2026-01-01T00:00:00.000Z');
    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    const comment = issues[0]?.comments?.[0];
    assert.ok(comment !== undefined);
    assert.ok(!('author' in comment), 'an unsigned reply must omit the field, not carry an empty name');
  });
});

describe('a row the code did not write', () => {
  it('costs that one pin and never the page', async () => {
    // The file is on a volume an operator can edit, and a restore can be older than the code. One
    // unreadable row must not blank every note on the page.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    const database = new DatabaseSync(path);
    database
      .prepare('INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(null, seed.page.url, 'seeded', '{ not json at all', '2026-01-01', '2026-01-01');
    database.close();

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.seed.id, seed.id);
  });

  it('drops a row that parses but is not a seed', async () => {
    // JSON.parse succeeding is not the same as the column holding a seed. A restore older than the
    // contract, or an operator's hand-edit, lands here — and must cost that row alone.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    const database = new DatabaseSync(path);
    database
      .prepare('INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(null, seed.page.url, 'seeded', '{ "hello": "world" }', '2026-01-01', '2026-01-01');
    database.close();

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.seed.id, seed.id);
  });

  it('drops a row whose column and seed disagree about which page it is on', async () => {
    // Written together, so they can only drift through an edit or a restore. If they do, this seed
    // belongs to another page, and returning it puts one page's note on top of another's element.
    // The Linear connector keeps the same invariant for a different reason — its filter is a
    // substring match. Raised in review on SKG-524.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    const elsewhere = seedFixture({ id: 'ailleurs', page: { ...seed.page, url: 'https://acme.test/autre' } });
    const database = new DatabaseSync(path);
    database
      .prepare('INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      // The column says this page; the seed inside says another.
      .run(null, seed.page.url, 'seeded', JSON.stringify(elsewhere), '2026-01-01', '2026-01-01');
    database.close();

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.deepEqual(
      issues.map((issue) => issue.seed.id),
      [seed.id],
    );
  });

  it('colours a pin whose stage it does not recognise rather than hiding the note', async () => {
    // The contract's own tolerance, and the reason it lives in `shared`: a stage this version does
    // not know must not make someone's feedback disappear.
    const path = freshPath();
    const seed = seedFixture();
    await createSqliteStore({ path }).create(seed, undefined, POLICY);
    closeSqliteConnections();

    const database = new DatabaseSync(path);
    database.prepare('UPDATE seeds SET stage = ? WHERE id = 1').run('marmalade');
    database.close();

    const issues = await createSqliteStore({ path }).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.stage, 'seeded');
  });
});

describe('the store spec', () => {
  it('names its own variable, and only its own', () => {
    const spec = createSqliteStoreSpec();
    const result = spec.readFrom({});

    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.missing, ['FRUITBACK_SQLITE_PATH']);
  });

  it('builds a store from the path it was given', () => {
    const spec = createSqliteStoreSpec();
    const result = spec.readFrom({ FRUITBACK_SQLITE_PATH: freshPath() });

    assert.ok(result.ok);
    assert.equal(result.config.provider, 'sqlite');
    assert.equal(result.config.create().name, 'sqlite');
  });

  it('is not dev-only, because a file on a volume is where production data belongs', () => {
    assert.equal(createSqliteStoreSpec().devOnly, false);
  });
});
