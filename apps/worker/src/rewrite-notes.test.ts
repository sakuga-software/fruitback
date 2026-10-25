import assert from 'node:assert/strict';
import {
  type Note,
  buildIssueDescription,
  buildNoteBlock,
  parseNote,
  parseNoteFromDescription,
} from '@fruitback/shared';
import { minimalNoteFixture, noteFixture } from '@fruitback/shared/note.fixture';
import { afterEach, describe, it, vi } from 'vitest';
import { createIssueStore } from './github.ts';
import { createLinearStore } from './linear.ts';
import { installLinearStub, storedIssueFromNote } from './linear-stub.ts';
import { mockMethod } from './mock.fixture.ts';
import { createPgliteDatabase } from './postgres.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { migrate } from './postgres-migrate.ts';
import { rewriteRows } from './postgres-stores.ts';
import {
  LEGACY_KIND,
  fromLegacy,
  rewriteDeliveryBody,
  rewriteDescription,
  rewriteNotes,
  rewritePayload,
} from './rewrite-notes.ts';

/**
 * `rewrite-notes` (FRU-378): the payloads of before, turned once into the note of now, in the trackers
 * (a Linear and a GitHub of the tests) and in the database (PGlite). Each case runs the command twice:
 * the second run finds nothing.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** A note as a worker of before FRU-378 wrote it: its kind and version of then, its words in `note`. */
function legacyOf(note: Note, v: 1 | 2 = 2): Record<string, unknown> {
  const { kind: _kind, v: _v, id, createdAt, text, ...rest } = note;

  return { kind: LEGACY_KIND, v, id, createdAt, note: text, ...rest };
}

/** The description of an issue of before: the one of now, with the block of then. */
function legacyDescription(note: Note): string {
  const block = ['```json', JSON.stringify(legacyOf(note), null, 2), '```'].join('\n');

  return buildIssueDescription(note).replace(buildNoteBlock(note), block);
}

describe('a payload of before (FRU-378)', () => {
  it('is no note for the reader of now: the reason this command exists', () => {
    assert.deepEqual(parseNote(legacyOf(noteFixture())), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNoteFromDescription(legacyDescription(noteFixture())), { ok: false, reason: 'not-found' });
  });

  it('becomes the same note of now, at version 1 and 2, for the full and the minimal note', () => {
    for (const note of [noteFixture(), minimalNoteFixture()]) {
      for (const v of [1, 2] as const)
        assert.deepEqual(fromLegacy(JSON.parse(JSON.stringify(legacyOf(note, v)))), note);
    }
  });

  it('is nothing to rewrite when it is a note of now, of another kind, or no note at all', () => {
    const { note: _words, ...broken } = legacyOf(noteFixture());
    for (const value of [
      noteFixture(),
      { ...legacyOf(noteFixture()), v: 3 },
      { ...legacyOf(noteFixture()), kind: 'other' },
      broken,
      null,
      'x',
      [],
    ]) {
      assert.equal(fromLegacy(value), undefined, JSON.stringify(value));
    }
  });
});

describe('the description of an issue of before (FRU-378)', () => {
  it('takes the block of now, keeps every other line, and reads back as the note', () => {
    const note = noteFixture();
    const before = `${legacyDescription(note)}\nA line the team wrote under it.\n`;

    const after = rewriteDescription(before);

    assert.ok(after !== undefined);
    assert.deepEqual(parseNoteFromDescription(after), { ok: true, note });
    assert.equal(after, `${buildIssueDescription(note)}\nA line the team wrote under it.\n`);
    assert.equal(after.includes(LEGACY_KIND), false);
  });

  it('is left alone when it holds no block of before, so a second run writes nothing', () => {
    const now = buildIssueDescription(noteFixture());

    assert.equal(rewriteDescription(now), undefined);
    assert.equal(rewriteDescription(rewriteDescription(legacyDescription(noteFixture())) ?? ''), undefined);
    assert.equal(rewriteDescription(`A ticket that names ${LEGACY_KIND} in its words, with no block.`), undefined);
  });
});

describe('a row and a delivery of before (FRU-378)', () => {
  it('rewrites the payload of a note the worker keeps, and nothing else', () => {
    const note = noteFixture();

    assert.equal(rewritePayload(JSON.stringify(legacyOf(note))), JSON.stringify(note));
    assert.equal(rewritePayload(JSON.stringify(note)), undefined);
    assert.equal(rewritePayload('not json'), undefined);
  });

  it('rewrites a delivery of version 1 into version 2, with the note under note', () => {
    const note = noteFixture();
    const body = JSON.stringify({
      version: 1,
      event: 'note.created',
      workspace: 'ws_1',
      site: { id: 'site_1' },
      identifier: 'FB-1',
      seed: legacyOf(note),
      attachments: [{ id: 'att_1', name: 'a.png', type: 'image/png', size: 3 }],
    });

    assert.deepEqual(JSON.parse(rewriteDeliveryBody(body) ?? ''), {
      version: 2,
      event: 'note.created',
      workspace: 'ws_1',
      site: { id: 'site_1' },
      identifier: 'FB-1',
      note: JSON.parse(JSON.stringify(note)),
      attachments: [{ id: 'att_1', name: 'a.png', type: 'image/png', size: 3 }],
    });
    assert.equal(rewriteDeliveryBody(rewriteDeliveryBody(body) ?? ''), undefined);
  });
});

describe('rewrite-notes on a database (FRU-378)', () => {
  const opened: PgDatabase[] = [];
  afterEach(async () => {
    for (const database of opened.splice(0)) await database.close();
  });

  async function filled(): Promise<{ database: PgDatabase; old: Note; now: Note }> {
    const database = await createPgliteDatabase();
    opened.push(database);
    await migrate(database);
    const old = noteFixture({ id: 'sd_old' });
    const now = noteFixture({ id: 'sd_now' });
    for (const payload of [JSON.stringify(legacyOf(old)), JSON.stringify(now)]) {
      await rowsOf(
        database,
        `INSERT INTO notes (client_id, page_url, stage, payload, created_at, updated_at) VALUES ('site_1', '${old.page.url}', 'new', '${payload.replaceAll("'", "''")}', 1, 1)`,
      );
    }
    await rowsOf(
      database,
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_1', 'W', 'ws_1', now())`,
    );
    await rowsOf(
      database,
      `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES ('con_1', 'ws_1', 'rest', 'Hook', 'x', 1)`,
    );
    const body = JSON.stringify({
      version: 1,
      event: 'note.created',
      workspace: 'ws_1',
      site: { id: 'site_1' },
      identifier: 'FB-1',
      seed: legacyOf(old),
    });
    await rowsOf(
      database,
      `INSERT INTO deliveries (id, connector_id, body, created_at) VALUES ('dlv_1', 'con_1', '${body.replaceAll("'", "''")}', 1)`,
    );

    return { database, old, now };
  }

  const payloads = async (database: PgDatabase) =>
    (await rowsOf(database, 'SELECT payload FROM notes ORDER BY id')).map((row) => String(row.payload));
  const bodies = async (database: PgDatabase) =>
    (await rowsOf(database, 'SELECT body FROM deliveries ORDER BY id')).map((row) => String(row.body));

  it('lists on a dry run and writes nothing, then rewrites the rows of before, then finds nothing', async () => {
    const { database, old, now } = await filled();
    const before = { payloads: await payloads(database), bodies: await bodies(database) };

    const dry = await rewriteNotes({ database, sources: [], dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.lines, [
      'notes kept by the worker: 1 to rewrite, of 2',
      'deliveries in the queue: 1 to rewrite, of 1',
      'dry run: nothing was written.',
    ]);
    assert.deepEqual({ payloads: await payloads(database), bodies: await bodies(database) }, before);

    const done = await rewriteNotes({ database, sources: [], dryRun: false });
    assert.equal(done.ok, true);
    assert.deepEqual(done.lines, [
      'notes kept by the worker: 1 rewritten, of 2',
      'deliveries in the queue: 1 rewritten, of 1',
    ]);
    assert.deepEqual(await payloads(database), [JSON.stringify(old), JSON.stringify(now)]);
    assert.deepEqual(JSON.parse((await bodies(database))[0] ?? '').note, JSON.parse(JSON.stringify(old)));

    const again = await rewriteNotes({ database, sources: [], dryRun: false });
    assert.deepEqual(again.lines, [
      'notes kept by the worker: 0 rewritten, of 2',
      'deliveries in the queue: 0 rewritten, of 1',
    ]);
  });

  it('leaves a row that another worker wrote between the read and the write, and does not count it', async () => {
    const { database } = await filled();
    const written = JSON.stringify(noteFixture({ id: 'sd_old', text: 'Written by a worker still running' }));
    let racing: Promise<unknown> | undefined;

    const counts = await rewriteRows(database, {
      payload: rewritePayload,
      // Called once the rows are read and before any is written: the update of the other worker lands
      // in between, as the database runs its statements in the order they came.
      body: (text) => {
        racing ??= rowsOf(
          database,
          `UPDATE notes SET payload = '${written.replaceAll("'", "''")}' WHERE payload LIKE '%${LEGACY_KIND}%'`,
        );

        return rewriteDeliveryBody(text);
      },
      dryRun: false,
    });
    await racing;

    assert.deepEqual(counts, { notes: { rewritten: 0, of: 2 }, deliveries: { rewritten: 1, of: 1 } });
    assert.equal((await payloads(database))[0], written);
  });
});

describe('rewrite-notes on the trackers (FRU-378)', () => {
  it('rewrites the issues of before of a Linear team, leaves the others, and a second run finds nothing', async () => {
    const old = noteFixture({ id: 'sd_old' });
    const now = noteFixture({ id: 'sd_now' });
    const stored = [
      { ...storedIssueFromNote(old), id: 'issue_old', identifier: 'SKG-1', description: legacyDescription(old) },
      { ...storedIssueFromNote(now), id: 'issue_now', identifier: 'SKG-2' },
    ];
    const stub = installLinearStub({ storedIssues: stored });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });
    const sources = [{ name: 'Linear', store, clients: [undefined] }];

    const dry = await rewriteNotes({ database: undefined, sources, dryRun: true });
    assert.deepEqual(dry.lines, ['Linear: 1 issue(s) to rewrite: SKG-1', 'dry run: nothing was written.']);
    assert.equal(
      stub.calls.some((call) => call.operation === 'FruitbackRewriteDescription'),
      false,
    );

    const done = await rewriteNotes({ database: undefined, sources, dryRun: false });
    assert.equal(done.ok, true);
    assert.deepEqual(done.lines, ['Linear: 1 issue(s) rewritten: SKG-1']);
    assert.deepEqual(parseNoteFromDescription(stored[0]?.description), { ok: true, note: old });
    // The query names the team of the store, and the kind of before.
    assert.deepEqual(stub.calls.find((call) => call.operation === 'FruitbackBlockIssues')?.variables.filter, {
      team: { id: { eq: 'team_1' } },
      description: { contains: LEGACY_KIND },
    });

    const again = await rewriteNotes({ database: undefined, sources, dryRun: false });
    assert.deepEqual(again.lines, ['Linear: 0 issue(s) rewritten']);
  });

  it('rewrites the issues of before of a GitHub repository, and says one that failed', async () => {
    const old = noteFixture({ id: 'sd_old' });
    const other = noteFixture({ id: 'sd_other' });
    const issues = [
      { id: 1, number: 12, body: legacyDescription(old), labels: [{ name: 'fruitback' }] },
      { id: 2, number: 13, body: legacyDescription(other), labels: [{ name: 'fruitback' }] },
      {
        id: 3,
        number: 14,
        body: buildIssueDescription(noteFixture({ id: 'sd_now' })),
        labels: [{ name: 'fruitback' }],
      },
      { id: 4, number: 15, body: 'A pull request', labels: [{ name: 'fruitback' }], pull_request: {} },
    ].map((issue) => ({
      html_url: `https://github.com/acme/site/issues/${issue.number}`,
      title: 't',
      state: 'open',
      state_reason: null,
      updated_at: '2026-10-25T00:00:00Z',
      comments: 0,
      ...issue,
    }));
    const patched: { number: number; body: string }[] = [];
    mockMethod(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/repos/acme/site/issues') {
        const page = Number(url.searchParams.get('page'));

        return Response.json(page === 1 ? issues : []);
      }
      const number = Number(/\/issues\/(\d+)$/.exec(url.pathname)?.[1]);
      if (init.method === 'PATCH' && number === 13) return Response.json({ message: 'Server Error' }, { status: 500 });
      if (init.method === 'PATCH') {
        const { body } = JSON.parse(String(init.body)) as { body: string };
        patched.push({ number, body });
        const issue = issues.find((each) => each.number === number);
        if (issue !== undefined) issue.body = body;

        return Response.json({});
      }

      return Response.json({ message: 'Not Found' }, { status: 404 });
    });
    const store = createIssueStore({
      repositoryOf: () => 'acme/site',
      tokens: { get: async () => 'ghs_test', drop: () => {} },
      api: 'https://github.test',
    });
    const sources = [{ name: 'GitHub', store, clients: [undefined] }];

    const done = await rewriteNotes({ database: undefined, sources, dryRun: false });

    assert.equal(done.ok, false);
    assert.deepEqual(done.lines.slice(0, 2), [
      'GitHub: 1 issue(s) rewritten: acme/site#12',
      'GitHub: acme/site#13 failed: GitHub responded 500',
    ]);
    assert.deepEqual(
      patched.map((each) => each.number),
      [12],
    );
    assert.deepEqual(parseNoteFromDescription(patched[0]?.body), { ok: true, note: old });
  });
});

describe('the command rewrite-notes (FRU-378)', () => {
  it('refuses a flag it does not know, so a typo cannot write what --dry-run would only list', async () => {
    const { runRewriteNotes } = await import('./rewrite-notes.ts');
    const refused = await runRewriteNotes(['--dryrun'], {});

    assert.equal(refused.ok, false);
    assert.deepEqual(refused.lines, ['usage: rewrite-notes [--dry-run]', 'unexpected: --dryrun']);
  });
});
