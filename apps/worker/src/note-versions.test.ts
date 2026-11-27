import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn, memberOf, shareWith, signInTo } from './console-world.fixture.ts';
import { noteIdOf } from './console-notes.ts';
import { NOTE_VERSION_LIMIT, type NoteVersions } from './note-versions.ts';
import { createPostgresNoteVersions } from './note-versions-postgres.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { type NoteStore, StoreError } from './store.ts';
import { type Handle, KEY_A, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * « Keep every version » of the card « Safeguards » (FRU-704). On a site that keeps them, an edit of
 * the text of a note keeps the text of before, and a deletion keeps the note as it was, in
 * `note_versions`; a member reads them on the page of the note in the console, oldest first. A guest
 * reads none, and a site that keeps none writes none. Each case goes through `handleRequest`, on
 * PostgreSQL (PGlite).
 */

const versionRows = async (world: World) =>
  Number((await rowsOf(world.database, 'SELECT count(*) AS count FROM note_versions'))[0]?.count);

/** A site that anyone writes on, a note that the browser of key A left on it, and the console of its owner. */
async function aKeepingSite(options: Parameters<typeof aVisitorSite>[0] & { keeps?: boolean } = {}) {
  const site = await aVisitorSite(options);
  if (options.keeps === false) {
    await rowsOf(site.world.database, `UPDATE sites SET keep_note_versions = false WHERE id = '${site.site}'`);
  }
  const issue = await site.send(site.noteOf('nv_1', 'The button is too small.', 'Camille'), { key: KEY_A });
  const alice = await signInTo(site.world, 'alice@acme.dev');
  /** The page of a note in the console, as `token` reads it. */
  const page = async (note = 'nv_1', token = alice.token) => {
    const response = await callOn(
      site.world,
      'GET',
      `/console/workspaces/${site.workspace}/notes/${noteIdOf(site.site, note)}`,
      { token },
      { store: site.store },
    );

    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  return { ...site, issue, alice, page };
}

/** The worker's own store, whose edits and withdrawals fail as a store that does not answer. */
const failingChanges = (world: World): NoteStore => {
  const store = createPostgresNoteStore(world.database);
  const down = async () => {
    throw new StoreError('the store is down');
  };

  return { ...store, edit: down, withdraw: down };
};

describe('the versions of a note (FRU-704)', () => {
  it('keeps the text of before each edit of a visitor, and a member reads them oldest first', async () => {
    const { world, edit, read, page, issue } = await aKeepingSite();
    // The widget tells the author before they save.
    assert.equal((await read({ key: KEY_A })).get('nv_1')?.versionsKept, true);

    assert.equal((await edit(issue, 'The button of the Latte is too small.', { key: KEY_A })).status, 200);
    assert.equal((await edit(issue, 'The button of the Latte is cut.', { key: KEY_A })).status, 200);

    const read1 = await page();
    assert.equal(read1.status, 200, JSON.stringify(read1.body));
    assert.equal(read1.body.note.note.text, 'The button of the Latte is cut.');
    assert.deepEqual(
      read1.body.versions.map((each: Record<string, any>) => [each.kind, each.text, each.author]),
      [
        ['edit', 'The button is too small.', { kind: 'anonymous' }],
        ['edit', 'The button of the Latte is too small.', { kind: 'anonymous' }],
      ],
    );
    assert.equal(typeof read1.body.versions[0].at, 'string');
    // A visitor is named by nothing: no key, no digest, no name they typed.
    assert.deepEqual(
      (await rowsOf(world.database, 'SELECT author_kind, author_account_id FROM note_versions')).map((row) => [
        row.author_kind,
        row.author_account_id,
      ]),
      [
        ['visitor', null],
        ['visitor', null],
      ],
    );
  });

  it('keeps a deletion with the note as it was, and its author', async () => {
    const { withdraw, page, issue } = await aKeepingSite();

    assert.equal((await withdraw(issue, { key: KEY_A })).status, 200);

    assert.deepEqual(
      (await page()).body.versions.map((each: Record<string, any>) => [each.kind, each.text, each.author.kind]),
      [['delete', 'The button is too small.', 'anonymous']],
    );
  });

  it('names a member by the name of their account now', async () => {
    const { world, send, noteOf, edit, page, bobToken } = await aKeepingSite();
    await rowsOf(world.database, `UPDATE "user" SET name = 'Bob Martin' WHERE email = 'bob@acme.dev'`);
    const theirs = await send(noteOf('nv_2', 'The menu overlaps.'), { token: bobToken });

    assert.equal((await edit(theirs, 'The menu overlaps the logo.', { token: bobToken })).status, 200);

    assert.deepEqual(
      (await page('nv_2')).body.versions.map((each: Record<string, any>) => each.author),
      [{ kind: 'member', name: 'Bob Martin' }],
    );
  });

  it('keeps nothing for the same text again, and nothing on a site that keeps no version', async () => {
    const kept = await aKeepingSite();
    assert.equal((await kept.edit(kept.issue, 'The button is too small.', { key: KEY_A })).status, 200);
    assert.equal(await versionRows(kept.world), 0);

    const { world, edit, withdraw, read, page, issue } = await aKeepingSite({ keeps: false });
    assert.equal((await read({ key: KEY_A })).get('nv_1')?.versionsKept, undefined);
    assert.equal((await read({ key: KEY_A })).get('nv_1')?.editable, true);
    assert.equal((await edit(issue, 'Another text.', { key: KEY_A })).status, 200);
    assert.equal((await withdraw(issue, { key: KEY_A })).status, 200);

    assert.equal(await versionRows(world), 0);
    assert.deepEqual((await page()).body.versions, []);
  });

  it('keeps nothing where only members write, as the card says « n/a »', async () => {
    const { world, site, send, noteOf, edit, bobToken } = await aKeepingSite();
    await rowsOf(world.database, `UPDATE sites SET writers = 'members' WHERE id = '${site}'`);
    const theirs = await send(noteOf('nv_3', 'The menu overlaps.'), { token: bobToken });

    assert.equal((await edit(theirs, 'The menu overlaps the logo.', { token: bobToken })).status, 200);
    assert.equal(await versionRows(world), 0);
  });

  it('shows a guest the note and no version', async () => {
    const { world, workspace, site, edit, page, issue } = await aKeepingSite();
    assert.equal((await edit(issue, 'The button of the Latte is too small.', { key: KEY_A })).status, 200);
    const carol = await signInTo(world, 'carol@client.dev');
    await memberOf(world, workspace, carol.id, 'guest');
    await shareWith(world, workspace, carol.id, [site]);

    const read = await page('nv_1', carol.token);

    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.note.note.text, 'The button of the Latte is too small.');
    assert.equal('versions' in read.body, false);
  });

  it('takes the version back when the store does not change the note, and changes nothing when the versions fail', async () => {
    const failing = await aKeepingSite({ storeOf: failingChanges });
    assert.equal((await failing.edit(failing.issue, 'Another text.', { key: KEY_A })).status, 502);
    assert.equal((await failing.withdraw(failing.issue, { key: KEY_A })).status, 502);
    assert.equal(await versionRows(failing.world), 0);

    const { world, store, workspace, site, issue } = await aKeepingSite();
    const down: NoteVersions = {
      keep: async () => {
        throw new Error('the database is down');
      },
      forget: async () => undefined,
      list: async () => [],
    };
    const response = await callOn(
      world,
      'POST',
      `/feedback/${issue}/text?client=${site}`,
      {
        origin: 'https://acme.dev',
        headers: { 'X-Fruitback-Visitor': KEY_A },
        body: { url: 'https://acme.dev/pricing', text: 'Lost?' },
      },
      { store, noteVersions: down },
    );
    assert.equal(response.status, 502);
    const [row] = await rowsOf(world.database, `SELECT excerpt FROM note_index WHERE workspace_id = '${workspace}'`);
    assert.equal(row?.excerpt, 'The button is too small.');
  });

  it('keeps the newest 50 versions of a note, and lets the oldest go', async () => {
    assert.equal(NOTE_VERSION_LIMIT, 50);
    const { world, workspace, site } = await aKeepingSite();
    const versions = createPostgresNoteVersions(world.database);
    for (let each = 0; each <= NOTE_VERSION_LIMIT; each += 1) {
      const kept = await versions.keep({
        workspace,
        site,
        note: 'nv_1',
        kind: 'edit',
        text: `Text ${each}`,
        author: { kind: 'visitor' },
        at: 1_000 + each,
      });
      assert.equal(typeof kept, 'string');
    }

    const listed = await versions.list(workspace, site, 'nv_1');
    assert.equal(listed.length, NOTE_VERSION_LIMIT);
    assert.equal(listed[0]?.text, 'Text 1');
    assert.equal(listed.at(-1)?.text, `Text ${NOTE_VERSION_LIMIT}`);
    // A note that is not in the index of the workspace keeps nothing, and another workspace reads nothing.
    assert.equal(
      await versions.keep({
        workspace,
        site,
        note: 'nv_none',
        kind: 'edit',
        text: 'x',
        author: { kind: 'visitor' },
        at: 1,
      }),
      undefined,
    );
    assert.deepEqual(await versions.list('ws_other', site, 'nv_1'), []);
  });

  it('lets the versions go with their note', async () => {
    const { world, site, edit, issue } = await aKeepingSite();
    assert.equal((await edit(issue, 'Another text.', { key: KEY_A })).status, 200);
    assert.equal(await versionRows(world), 1);

    await rowsOf(world.database, `DELETE FROM note_index WHERE site_id = '${site}'`);

    assert.equal(await versionRows(world), 0);
  });

  /** The worker's own store, whose edits find the note done meanwhile, as the team marks it between two reads. */
  const doneMeanwhile = (world: World): NoteStore => {
    const store = createPostgresNoteStore(world.database);

    return { ...store, edit: async () => 'not-open' as const };
  };

  const PLANTS: {
    guard: string;
    from: string;
    to: string;
    storeOf?: (world: World) => NoteStore;
    holds: (site: Awaited<ReturnType<typeof aKeepingSite>>) => Promise<boolean>;
  }[] = [
    {
      guard: 'an edit keeps the text of before',
      from: 'target?.keepNoteVersions === true && text !== found.note.text',
      to: 'false',
      holds: async ({ world, edit, issue }) => {
        await edit(issue, 'Another text.', { key: KEY_A });

        return (await versionRows(world)) === 1;
      },
    },
    {
      guard: 'an edit that does not happen takes its version back',
      from: 'if (!happened(answer)) await takeBack();',
      to: '',
      storeOf: doneMeanwhile,
      holds: async ({ world, edit, issue }) => {
        const refused = await edit(issue, 'Another text.', { key: KEY_A });

        return refused.status === 409 && (await versionRows(world)) === 0;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      const options = plant.storeOf === undefined ? {} : { storeOf: plant.storeOf };
      assert.equal(
        await plant.holds(await aKeepingSite(options)),
        true,
        'the control: the real module holds the guard',
      );

      const mutant = await mutatedModule('edit-routes.ts', { from: plant.from, to: plant.to });
      try {
        const handle = mutant.module.handleRequest as Handle;
        assert.equal(await plant.holds(await aKeepingSite({ ...options, handle })), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});
