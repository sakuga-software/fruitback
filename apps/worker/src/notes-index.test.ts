import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import type { Seed, SeedIssue, SeedStage } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { EXCERPT_LENGTH, type NoteIndex, excerptOf } from './notes-index.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf, withoutOwnerRule } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { SeedStore } from './store.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

const open = worlds();

/** A store that keeps the notes in memory, and answers each with the stage a test sets. */
function storeOfStages() {
  const kept: Seed[] = [];
  const stages = new Map<string, SeedStage>();
  const store: SeedStore = {
    name: 'test',
    scope: () => 'test',
    async create(seed) {
      kept.push(seed);

      return {
        id: `issue_${kept.length}`,
        identifier: `FB-${kept.length}`,
        url: `https://tracker.test/${kept.length}`,
      };
    },
    async findForPage({ url, clientId }) {
      return kept
        .filter((seed) => seed.page.url === url && seed.client?.id === clientId)
        .map(
          (seed, index): SeedIssue => ({
            id: `issue_${index + 1}`,
            identifier: `FB-${kept.indexOf(seed) + 1}`,
            title: seed.note.slice(0, 20),
            stage: stages.get(seed.id) ?? 'seeded',
            stateName: 'Whatever',
            updatedAt: '2026-10-13T00:00:00.000Z',
            seed,
          }),
        );
    },
  };

  return { store, kept, stages };
}

/** A world with a workspace of Alice, two sites, the index on its database, and a store of stages. */
async function aWorkspace() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  const { store, kept, stages } = storeOfStages();
  world.context = { ...world.context, store, noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const site = async (url: string) => {
    const added = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url, visibility: 'everyone' },
    });
    assert.equal(added.status, 201, await added.clone().text());

    return ((await added.json()) as { id: string }).id;
  };
  const acme = await site('https://acme.dev');
  const quiet = await site('https://quiet.acme.dev');

  return { world, index, kept, stages, alice, workspace, acme, quiet };
}

/** A note of a page of `https://acme.dev`, by the script, or with the token of a session. */
async function leave(
  world: World,
  site: string,
  note: string,
  more: { token?: string; id?: string; origin?: string } = {},
) {
  const origin = more.origin ?? 'https://acme.dev';
  const seed = seedFixture({
    id: more.id ?? `sd_${Math.random().toString(36).slice(2, 10)}`,
    note,
    page: { url: `${origin}/pricing`, path: '/pricing', title: 'Pricing' },
    client: { id: site, name: 'Acme' },
    reporter: { name: 'Typed Name', email: 'typed@client.fr' },
  });
  const answer = await callOn(world, 'POST', '/feedback', {
    origin,
    body: seed,
    ...(more.token === undefined ? {} : { headers: { Authorization: `Bearer ${more.token}` } }),
  });
  assert.equal(answer.status, 201, await answer.clone().text());

  return seed;
}

async function sitesOf(world: World, workspace: string, token: string) {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return ((await answer.json()) as { sites: Record<string, unknown>[] }).sites;
}

async function extensionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

describe('the excerpt of a note (FRU-237)', () => {
  const codePoints = (text: string) => [...text].length;

  it('keeps the first 64 characters of a long note, and no more', () => {
    const long = 'a'.repeat(200);
    assert.equal(excerptOf(long), 'a'.repeat(EXCERPT_LENGTH));
    assert.equal(EXCERPT_LENGTH, 64);
  });

  it('cuts between two graphemes: a family emoji or an accented letter is kept whole, or not at all', () => {
    const family = '👨‍👩‍👧‍👦'; // seven code points, one grapheme
    const text = `${'b'.repeat(60)}${family}tail`;
    const excerpt = excerptOf(text);

    assert.equal(excerpt, 'b'.repeat(60));
    assert.ok(codePoints(excerpt) <= EXCERPT_LENGTH);
    // A letter and its combining accent are two code points and one grapheme.
    const accents = 'é'.repeat(40);
    assert.equal(excerptOf(accents), 'é'.repeat(32));
    for (const flag of ['🇫🇷'.repeat(40), '👍🏽'.repeat(40)]) {
      const cut = excerptOf(flag);
      assert.ok(codePoints(cut) <= EXCERPT_LENGTH && flag.startsWith(cut) && codePoints(cut) % 2 === 0);
    }
  });

  it('makes one space of spaces and line breaks, and nothing of an empty note', () => {
    assert.equal(excerptOf('  The price\n\n\tis cut   off  '), 'The price is cut off');
    assert.equal(excerptOf(''), '');
    assert.equal(excerptOf(' \n\t '), '');
  });
});

describe('the summary of the sites of a workspace (FRU-237)', () => {
  it('counts the notes of each site by stage, says by which way they came, and when the last came', async () => {
    const { world, alice, workspace, acme, quiet } = await aWorkspace();
    await leave(world, acme, 'From the script.');
    await leave(world, acme, 'From the extension.', { token: await extensionOf(world, alice.id, workspace) });

    const sites = await sitesOf(world, workspace, alice.token);
    const one = sites.find((site) => site.id === acme);
    const none = sites.find((site) => site.id === quiet);

    assert.deepEqual(one?.notes, { seeded: 2, green: 0, ripening: 0, ripe: 0, composted: 0 });
    assert.deepEqual(one?.via, ['script', 'extension']);
    assert.equal(typeof one?.lastNoteAt, 'string');
    assert.equal(typeof one?.asOf, 'string');
    assert.equal(one?.undelivered, 0);
    // A site with no note: five zeros, no way, and no last note.
    assert.deepEqual(none?.notes, { seeded: 0, green: 0, ripening: 0, ripe: 0, composted: 0 });
    assert.deepEqual(none?.via, []);
    assert.equal('lastNoteAt' in (none ?? {}), false);
  });

  it('moves a count when a read of the page finds the note at another stage in its store', async () => {
    const { world, alice, workspace, acme, stages } = await aWorkspace();
    const seed = await leave(world, acme, 'Done in the tracker later.');
    stages.set(seed.id, 'ripe');

    const read = await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${acme}`,
      { origin: 'https://acme.dev' },
    );
    assert.equal(read.status, 200, await read.clone().text());

    const one = (await sitesOf(world, workspace, alice.token)).find((site) => site.id === acme);
    assert.deepEqual(one?.notes, { seeded: 0, green: 0, ripening: 0, ripe: 1, composted: 0 });
  });

  it('writes a note from before the index at the first read of its page, with what the read says and no way', async () => {
    const { world, alice, workspace, acme, kept, index } = await aWorkspace();
    // A note that a worker with no index planted: in the store, and not in the index.
    kept.push(
      seedFixture({
        id: 'sd_before',
        note: 'Planted before the index.',
        page: { url: 'https://acme.dev/pricing', path: '/pricing', title: 'Pricing' },
        client: { id: acme, name: 'Acme' },
      }),
    );
    assert.equal((await index.summary(workspace)).size, 0);

    await callOn(world, 'GET', `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${acme}`, {
      origin: 'https://acme.dev',
    });

    const [row] = await rowsOf(world.database, `SELECT channel, author_kind, excerpt FROM note_index`);
    assert.deepEqual(row, { channel: null, author_kind: 'visitor', excerpt: 'Planted before the index.' });
    const one = (await sitesOf(world, workspace, alice.token)).find((site) => site.id === acme);
    assert.deepEqual(one?.via, [], 'a way that nobody saw is not invented');
  });

  it('keeps no name a visitor typed, and the account of a member', async () => {
    const { world, alice, workspace, acme } = await aWorkspace();
    await leave(world, acme, 'A visitor.');
    await leave(world, acme, 'A member.', { token: await extensionOf(world, alice.id, workspace) });

    const rows = await rowsOf(
      world.database,
      `SELECT author_kind, author_account_id FROM note_index ORDER BY author_kind`,
    );
    assert.deepEqual(rows, [
      { author_kind: 'member', author_account_id: alice.id },
      { author_kind: 'visitor', author_account_id: null },
    ]);
    const everything = JSON.stringify(await rowsOf(world.database, 'SELECT * FROM note_index'));
    assert.doesNotMatch(everything, /Typed Name|typed@client\.fr/);
  });

  it('holds no more than 64 characters of the text of a note in any column', async () => {
    const { world, acme } = await aWorkspace();
    const notes = [
      `${'Long note, '.repeat(40)}end.`,
      `${'é'.repeat(30)}👨‍👩‍👧‍👦${'x'.repeat(80)}`,
      // Line breaks and runs of spaces: the excerpt makes one space of each, so a copy of the text
      // as it was typed would not be found in a row that holds it normalised.
      `${'Line one\n\n   line two\t '.repeat(10)}end.`,
      '',
    ];
    for (const note of notes) await leave(world, acme, note);

    const rows = await rowsOf(world.database, 'SELECT * FROM note_index');
    assert.equal(rows.length, notes.length);
    for (const note of notes) {
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          // No 65 characters of the note in a row, wherever they start: of the text as it was
          // typed, and of the text as the excerpt normalises it.
          for (const text of [note, note.replace(/\s+/gu, ' ').trim()]) {
            const characters = [...text];
            for (let start = 0; start + EXCERPT_LENGTH < characters.length; start += 1) {
              const window = characters.slice(start, start + EXCERPT_LENGTH + 1).join('');
              assert.equal(value.includes(window), false, `${column} holds more than 64 characters of a note`);
            }
          }
        }
      }
    }
  });

  it('answers each role as it reads the sites today, and nobody else', async () => {
    const { world, alice, workspace, acme } = await aWorkspace();
    await leave(world, acme, 'One note.');
    const people = {
      admin: await signInTo(world, 'admin@acme.dev'),
      member: await signInTo(world, 'member@acme.dev'),
      guest: await signInTo(world, 'guest@client.fr'),
    };
    for (const [role, person] of Object.entries(people)) await memberOf(world, workspace, person.id, role);
    // The guest of the site (FRU-250).
    await shareWith(world, workspace, people.guest.id, [acme]);
    const outsider = await signInTo(world, 'mallory@other.dev');
    await workspaceIn(world, outsider.token, 'Other');

    for (const [role, token] of [
      ['owner', alice.token],
      ['admin', people.admin.token],
      ['member', people.member.token],
      ['guest', people.guest.token],
    ] as const) {
      const one = (await sitesOf(world, workspace, token)).find((site) => site.id === acme);
      assert.equal((one?.notes as Record<string, number> | undefined)?.seeded, 1, role);
      // What did not arrive is about the tracker: `see-tracker`, which a guest does not have.
      assert.equal('undelivered' in (one ?? {}), role !== 'guest', role);
    }
    assert.equal(
      (await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, { token: outsider.token })).status,
      404,
    );
    assert.equal((await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, {})).status, 401);
    // The token of an extension opens no route of the console (FRU-202).
    const extension = await extensionOf(world, alice.id, workspace);
    assert.equal(
      (await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, { token: extension })).status,
      401,
    );
  });

  it('gives the extension the same counts, for the sites of its workspace', async () => {
    const { world, alice, workspace, acme } = await aWorkspace();
    const extension = await extensionOf(world, alice.id, workspace);
    await leave(world, acme, 'Seen in the popup.', { token: extension });

    const answer = await callOn(world, 'GET', '/session/sites', {
      origin: null,
      headers: { Authorization: `Bearer ${extension}` },
    });
    assert.equal(answer.status, 200, await answer.clone().text());
    const one = ((await answer.json()) as { sites: Record<string, unknown>[] }).sites.find((site) => site.id === acme);
    assert.deepEqual(one?.notes, { seeded: 1, green: 0, ripening: 0, ripe: 0, composted: 0 });
    assert.deepEqual(one?.via, ['extension']);
    assert.equal('undelivered' in (one ?? {}), false);
  });

  it('removes the index of a site with the site', async () => {
    const { world, alice, workspace, acme, quiet } = await aWorkspace();
    await leave(world, acme, 'Goes with its site.');
    await leave(world, quiet, 'Stays with its site.', { origin: 'https://quiet.acme.dev' });

    const removed = await callOn(world, 'DELETE', `/console/workspaces/${workspace}/sites/${acme}`, {
      token: alice.token,
    });
    assert.equal(removed.status, 204);
    assert.deepEqual(await rowsOf(world.database, 'SELECT site_id FROM note_index'), [{ site_id: quiet }]);
  });

  it('writes the note even when the index does not answer: the index never costs a note', async () => {
    const { world, workspace, acme } = await aWorkspace();
    const broken: NoteIndex = {
      ...createPostgresNoteIndex(world.database),
      record: async () => {
        throw new Error('the index is down');
      },
    };
    world.context = { ...world.context, noteIndex: broken };
    const logged = mockMethod(console, 'error', () => {});

    try {
      await leave(world, acme, 'Kept all the same.');
      assert.match(String(logged.mock.calls.at(-1)?.[0]), /index of the notes was not written/);
    } finally {
      logged.mockRestore();
    }
    void workspace;
  });
});

describe('forget, and the index (FRU-237)', () => {
  it('removes the rows of the notes it deletes, their excerpt with them, and no other, not even one of the same reference', async () => {
    const { createPgliteDatabase } = await import('./postgres.fixture.ts');
    const { createPostgresAccountStore } = await import('./accounts-postgres.ts');
    const { createPostgresSeedStore } = await import('./seeds-postgres.ts');
    const { runForget } = await import('./cli.ts');
    const database = await createPgliteDatabase();

    try {
      const accounts = createPostgresAccountStore(database);
      const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
      const acme = await accounts.createWorkspace('Acme', alice.id);
      const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'everyone' });
      const store = createPostgresSeedStore(database);
      const index = createPostgresNoteIndex(database);
      const planted = [];
      for (const [id, name] of [
        ['sd_alice', 'Alice'],
        ['sd_bob', 'Bob'],
      ] as const) {
        const seed = seedFixture({
          id,
          note: `A note of ${name}.`,
          client: { id: site.id, name: 'Acme' },
          reporter: { name, email: `${name.toLowerCase()}@client.fr` },
        });
        const issue = await store.create(seed, undefined, { read: 'public' } as never);
        planted.push(issue.identifier);
        await index.record(
          [
            {
              workspace: acme.id,
              site: site.id,
              seed,
              channel: 'script',
              author: { kind: 'visitor' },
              place: { kind: 'fruitback' },
              issue,
              stage: 'seeded',
            },
          ],
          Date.now(),
        );
      }

      // Another workspace, whose tracker also calls one of its issues as Alice's note is called here.
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@other.dev', email: 'bob@other.dev' });
      const other = await accounts.createWorkspace('Other', bob.id);
      const otherSite = await accounts.addSite(other.id, { origin: 'https://other.dev', visibility: 'everyone' });
      await index.record(
        [
          {
            workspace: other.id,
            site: otherSite.id,
            seed: seedFixture({ id: 'sd_other', note: 'A note of the other workspace.' }),
            channel: 'script',
            author: { kind: 'visitor' },
            place: { kind: 'fruitback' },
            issue: { identifier: planted[0] ?? '' },
            stage: 'seeded',
          },
        ],
        Date.now(),
      );

      const done = await runForget(
        ['--email', 'alice@client.fr'],
        beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }),
        store,
        index,
      );
      assert.equal(done.ok, true, done.lines.join('\n'));

      assert.deepEqual(await rowsOf(database, 'SELECT seed_id, excerpt FROM note_index ORDER BY seed_id'), [
        { seed_id: 'sd_bob', excerpt: 'A note of Bob.' },
        { seed_id: 'sd_other', excerpt: 'A note of the other workspace.' },
      ]);
    } finally {
      await database.close();
    }
  });
});

describe('the index, against what the review of #300 found (FRU-237)', () => {
  const issueOf = (seedId: string, identifier: string, note: string, stage: SeedStage): SeedIssue => ({
    id: identifier,
    identifier,
    title: note.slice(0, 20),
    stage,
    stateName: 'x',
    updatedAt: '2026-10-13T00:00:00.000Z',
    seed: seedFixture({ id: seedId, note }),
  });

  async function oneSite() {
    const { createPgliteDatabase } = await import('./postgres.fixture.ts');
    const { createPostgresAccountStore } = await import('./accounts-postgres.ts');
    const database = await createPgliteDatabase();
    const accounts = createPostgresAccountStore(database);
    const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'everyone' });

    return { database, accounts, alice, acme, site, index: createPostgresNoteIndex(database) };
  }

  it('writes the page when two of its issues carry one seed id, the first of them', async () => {
    const { database, acme, site, index } = await oneSite();
    try {
      await index.refresh(
        acme.id,
        site.id,
        { kind: 'fruitback' },
        [
          issueOf('sd_same', 'FB-1', 'first', 'ripe'),
          issueOf('sd_same', 'FB-2', 'second', 'green'),
          issueOf('sd_other', 'FB-3', 'third', 'ripe'),
        ],
        Date.now(),
      );

      assert.deepEqual(await rowsOf(database, 'SELECT seed_id, reference, stage FROM note_index ORDER BY seed_id'), [
        { seed_id: 'sd_other', reference: 'FB-3', stage: 'ripe' },
        { seed_id: 'sd_same', reference: 'FB-1', stage: 'ripe' },
      ]);
    } finally {
      await database.close();
    }
  });

  it('leaves no row of a forgotten note that a read of its page wrote back during the command', async () => {
    const { database, acme, site, index } = await oneSite();
    const { createPostgresSeedStore } = await import('./seeds-postgres.ts');
    const { runForget } = await import('./cli.ts');
    try {
      const real = createPostgresSeedStore(database);
      const seed = seedFixture({
        id: 'sd_alice',
        note: 'Secret note of Alice.',
        client: { id: site.id, name: 'Acme' },
        reporter: { name: 'Alice', email: 'alice@client.fr' },
      });
      const issue = await real.create(seed, undefined, { read: 'public' } as never);
      await index.record(
        [
          {
            workspace: acme.id,
            site: site.id,
            seed,
            channel: 'script',
            author: { kind: 'visitor' },
            place: { kind: 'fruitback' },
            issue,
            stage: 'seeded',
          },
        ],
        Date.now(),
      );
      // A reader's GET that misses the cache between the index and the store: it reads the note in
      // the store, still there, and writes its row back.
      const forget = real.forget?.bind(real);
      const store: SeedStore = {
        ...real,
        forget: async (which, options) => {
          if (!options.dryRun) {
            const issues = await real.findForPage({ url: seed.page.url, clientId: site.id }, undefined, {
              read: 'public',
            } as never);
            await index.refresh(acme.id, site.id, { kind: 'fruitback' }, issues, Date.now());
          }

          return (forget as NonNullable<SeedStore['forget']>)(which, options);
        },
      };

      const done = await runForget(
        ['--email', 'alice@client.fr'],
        beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }),
        store,
        index,
      );

      assert.equal(done.ok, true, done.lines.join('\n'));
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM seeds'), []);
      assert.deepEqual(await rowsOf(database, 'SELECT seed_id FROM note_index'), []);
    } finally {
      await database.close();
    }
  });

  it('removes with --seed the row of a note that went to a tracker, whatever the store, and no other', async () => {
    const { database, acme, site, index } = await oneSite();
    const { runForget } = await import('./cli.ts');
    try {
      for (const [id, note] of [
        ['sd_tracked', 'A note that went to Linear.'],
        ['sd_kept', 'Another note.'],
      ] as const) {
        await index.record(
          [
            {
              workspace: acme.id,
              site: site.id,
              seed: seedFixture({ id, note }),
              channel: 'script',
              author: { kind: 'visitor' },
              place: { kind: 'fruitback' },
              issue: { identifier: id === 'sd_tracked' ? 'ACM-151' : 'ACM-152' },
              stage: 'seeded',
            },
          ],
          Date.now(),
        );
      }
      // A store that deletes nothing from this command: Linear, REST, memory.
      const tracker: SeedStore = {
        name: 'linear',
        scope: () => 'linear',
        create: async () => ({ id: 'x', identifier: 'x' }),
        findForPage: async () => [],
      };
      const env = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' });

      const byEmail = await runForget(['--email', 'alice@client.fr'], env, tracker, index);
      assert.equal(byEmail.ok, false);
      assert.match(byEmail.lines.join('\n'), /--seed <id>/);

      const listed = await runForget(
        ['--seed', 'sd_tracked', '--seed', 'sd_nowhere', '--dry-run'],
        env,
        tracker,
        index,
      );
      assert.equal(listed.ok, true, listed.lines.join('\n'));
      assert.match(listed.lines.join('\n'), /sd_tracked {2}ACM-151 .* A note that went to Linear\./);
      assert.match(listed.lines.join('\n'), /no row of the index names sd_nowhere/);
      assert.equal((await rowsOf(database, 'SELECT seed_id FROM note_index')).length, 2, 'a dry run removes nothing');

      const done = await runForget(['--seed', 'sd_tracked'], env, tracker, index);
      assert.equal(done.ok, true, done.lines.join('\n'));
      assert.deepEqual(await rowsOf(database, 'SELECT seed_id FROM note_index'), [{ seed_id: 'sd_kept' }]);
    } finally {
      await database.close();
    }
  });

  it('keeps no account that was removed: the row stays, with no account', async () => {
    const { database, accounts, alice, acme, site, index } = await oneSite();
    try {
      await index.record(
        [
          {
            workspace: acme.id,
            site: site.id,
            seed: seedFixture({ id: 'sd_member', note: 'A note of a member.' }),
            channel: 'extension',
            author: { kind: 'member', account: alice.id },
            place: { kind: 'fruitback' },
            issue: { identifier: 'FB-1' },
            stage: 'seeded',
          },
        ],
        Date.now(),
      );
      void accounts;

      await withoutOwnerRule(database, `DELETE FROM "user" WHERE id = '${alice.id}'`);

      assert.deepEqual(await rowsOf(database, 'SELECT seed_id, author_kind, author_account_id FROM note_index'), [
        { seed_id: 'sd_member', author_kind: 'member', author_account_id: null },
      ]);
    } finally {
      await database.close();
    }
  });

  it('says that the notes are deleted, and how to end it, when the index fails after the store', async () => {
    const { database, acme, site, index } = await oneSite();
    const { createPostgresSeedStore } = await import('./seeds-postgres.ts');
    const { runForget } = await import('./cli.ts');
    try {
      const store = createPostgresSeedStore(database);
      const seed = seedFixture({
        id: 'sd_alice',
        note: 'A note of Alice.',
        client: { id: site.id, name: 'Acme' },
        reporter: { name: 'Alice', email: 'alice@client.fr' },
      });
      const issue = await store.create(seed, undefined, { read: 'public' } as never);
      await index.record(
        [
          {
            workspace: acme.id,
            site: site.id,
            seed,
            channel: 'script',
            author: { kind: 'visitor' },
            place: { kind: 'fruitback' },
            issue,
            stage: 'seeded',
          },
        ],
        Date.now(),
      );
      let calls = 0;
      const failing: NoteIndex = {
        ...index,
        forget: async (which, options) => {
          calls += 1;
          if (calls === 2) throw new Error('the index went away');

          return index.forget(which, options);
        },
      };

      const done = await runForget(
        ['--email', 'alice@client.fr'],
        beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }),
        store,
        failing,
      );

      assert.equal(done.ok, false);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM seeds'), []);
      assert.match(done.lines.join('\n'), /deleted 1 note\(s\)/);
      assert.match(done.lines.join('\n'), /Run: forget --seed sd_alice/);
    } finally {
      await database.close();
    }
  });

  it('removes the row of a note of the same reporter that arrived between the list and the deletion', async () => {
    const { database, acme, site, index } = await oneSite();
    const { createPostgresSeedStore } = await import('./seeds-postgres.ts');
    const { runForget } = await import('./cli.ts');
    try {
      const real = createPostgresSeedStore(database);
      const plant = async (id: string) => {
        const seed = seedFixture({
          id,
          note: `A note ${id}.`,
          client: { id: site.id, name: 'Acme' },
          reporter: { name: 'Alice', email: 'alice@client.fr' },
        });
        const issue = await real.create(seed, undefined, { read: 'public' } as never);
        await index.record(
          [
            {
              workspace: acme.id,
              site: site.id,
              seed,
              channel: 'script',
              author: { kind: 'visitor' },
              place: { kind: 'fruitback' },
              issue,
              stage: 'seeded',
            },
          ],
          Date.now(),
        );
      };
      await plant('sd_first');
      const forget = real.forget?.bind(real) as NonNullable<SeedStore['forget']>;
      // A second note of Alice arrives after the list the command read, before it deletes.
      const store: SeedStore = {
        ...real,
        forget: async (which, options) => {
          if (!options.dryRun) await plant('sd_late');

          return forget(which, options);
        },
      };

      const done = await runForget(
        ['--email', 'alice@client.fr'],
        beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }),
        store,
        index,
      );

      assert.equal(done.ok, true, done.lines.join('\n'));
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM seeds'), []);
      assert.deepEqual(await rowsOf(database, 'SELECT seed_id FROM note_index'), []);
    } finally {
      await database.close();
    }
  });
});
