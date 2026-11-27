import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn, memberOf, shareWith, signInTo } from './console-world.fixture.ts';
import { noteIdOf } from './console-notes.ts';
import { DAY_MS, type DeletedNotes, sweepAndForget } from './deleted-notes.ts';
import { createPostgresDeletedNotes } from './deleted-notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { KEY_A, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * « Deleted notes » of the card « Safeguards » (FRU-704). A note its visitor deleted is kept the days
 * of its site (30 by default): a member reads until when on the page of the note in the console, and
 * restores it meanwhile; then the sweep erases it for good. Each route goes through `handleRequest`, on
 * PostgreSQL (PGlite); the sweep is called as the timer of the worker calls it.
 */

const count = async (world: World, sql: string) => Number((await rowsOf(world.database, sql))[0]?.count);

/** A site that anyone writes on, a note its visitor deleted, and the console of its owner. */
async function aDeletedNote() {
  const site = await aVisitorSite();
  const issue = await site.send(site.noteOf('dn_1', 'The button is too small.', 'Camille'), { key: KEY_A });
  // An edit first, so that the note has a version that goes with it.
  assert.equal((await site.edit(issue, 'The button of the Latte is too small.', { key: KEY_A })).status, 200);
  assert.equal((await site.withdraw(issue, { key: KEY_A })).status, 200);
  const alice = await signInTo(site.world, 'alice@acme.dev');
  const consoleCall = async (method: string, path: string, token = alice.token) => {
    const response = await callOn(
      site.world,
      method,
      `/console/workspaces/${site.workspace}/notes/${noteIdOf(site.site, 'dn_1')}${path}`,
      { token },
      { store: site.store },
    );
    const text = await response.text();

    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  };

  return { ...site, issue, alice, consoleCall, deleted: createPostgresDeletedNotes(site.world.database) };
}

describe('the notes their visitors deleted (FRU-704)', () => {
  it('tells a member until when the site keeps the note, 30 days by default', async () => {
    const { consoleCall } = await aDeletedNote();

    const read = await consoleCall('GET', '');

    assert.equal(read.status, 200, JSON.stringify(read.body));
    const { at, until } = read.body.deleted as { at: string; until: string };
    assert.equal(Date.parse(until) - Date.parse(at), 30 * DAY_MS);
  });

  it('restores the note for a member: its pin shows on its page again, and the console says it is kept no more', async () => {
    const { read, consoleCall } = await aDeletedNote();
    assert.equal((await read()).has('dn_1'), false);

    assert.equal((await consoleCall('POST', '/restore')).status, 204);

    assert.equal((await read()).get('dn_1')?.stage, 'closed');
    assert.equal('deleted' in (await consoleCall('GET', '')).body, false);
    // Restored once: there is nothing to restore again.
    assert.equal((await consoleCall('POST', '/restore')).status, 404);
  });

  it('refuses a guest the restore and the date, and restores nothing once the days ran out', async () => {
    const { world, workspace, site, read, consoleCall } = await aDeletedNote();
    const carol = await signInTo(world, 'carol@client.dev');
    await memberOf(world, workspace, carol.id, 'guest');
    await shareWith(world, workspace, carol.id, [site]);

    assert.equal((await consoleCall('POST', '/restore', carol.token)).status, 403);
    assert.equal('deleted' in (await consoleCall('GET', '', carol.token)).body, false);

    await rowsOf(
      world.database,
      `UPDATE note_index SET removed_at = ${Date.now() - 31 * DAY_MS} WHERE note_id = 'dn_1'`,
    );
    assert.equal((await consoleCall('POST', '/restore')).status, 404);
    assert.equal('deleted' in (await consoleCall('GET', '')).body, false);
    assert.equal((await read()).has('dn_1'), false);
  });

  it('erases a note the worker keeps once the days of its site ran out: the note, its row, its versions', async () => {
    const { world, site, read, deleted } = await aDeletedNote();
    await rowsOf(world.database, `UPDATE sites SET deleted_notes_keep_days = 7 WHERE id = '${site}'`);
    const now = Date.now();
    assert.equal(await count(world, 'SELECT count(*) AS count FROM note_versions'), 2);

    // Six days on, it is kept.
    assert.equal((await deleted.sweep(now + 6 * DAY_MS)).erased, 0);
    assert.equal(await count(world, `SELECT count(*) AS count FROM note_index WHERE note_id = 'dn_1'`), 1);

    assert.equal((await deleted.sweep(now + 8 * DAY_MS)).erased, 1);

    assert.equal(await count(world, `SELECT count(*) AS count FROM note_index WHERE note_id = 'dn_1'`), 0);
    assert.equal(await count(world, 'SELECT count(*) AS count FROM notes'), 0);
    assert.equal(await count(world, 'SELECT count(*) AS count FROM note_versions'), 0);
    assert.equal((await read()).has('dn_1'), false);
    assert.equal((await deleted.sweep(now + 8 * DAY_MS)).erased, 0);
  });

  it('drops the cached read of the page of a note it erased, so its pin never shows again (review of #999)', async () => {
    const { world, read, deleted } = await aDeletedNote();
    // A read after the deletion: the page is cached with the note, which only the mark of its row hides.
    assert.equal((await read()).has('dn_1'), false);

    assert.equal(await sweepAndForget(deleted, world.context.kv, Date.now() + 31 * DAY_MS), 1);

    assert.equal((await read()).has('dn_1'), false);
  });

  it('erases the words it keeps of a note of a tracker, and keeps its row so that the issue never shows again', async () => {
    const { world, workspace, site, deleted } = await aDeletedNote();
    // A note sent to a connector removed since: a tracker holds it, and the worker keeps no row of it.
    await rowsOf(
      world.database,
      `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, author_visitor, selector, place, created_at, checked_at, removed_at)
         VALUES ('${site}', 'dn_t', '${workspace}', 'https://acme.dev/pricing', 'Sent to a tracker.', 'closed', 'visitor', 'digest-of-a-test-key', '.buy', 'connector', 1, 1, 1)`,
    );
    await rowsOf(
      world.database,
      `INSERT INTO note_versions (id, site_id, note_id, workspace_id, kind, text, author_kind, at) VALUES ('ver_t', '${site}', 'dn_t', '${workspace}', 'edit', 'Before.', 'visitor', 1)`,
    );

    assert.equal((await deleted.sweep(Date.now())).erased, 1);

    const [row] = await rowsOf(
      world.database,
      `SELECT excerpt, author_visitor, selector, removed_at, erased_at FROM note_index WHERE note_id = 'dn_t'`,
    );
    assert.equal(row?.excerpt, '');
    assert.equal(row?.author_visitor, null);
    assert.equal(row?.selector, null);
    assert.notEqual(row?.removed_at, null);
    assert.notEqual(row?.erased_at, null);
    assert.equal(await count(world, `SELECT count(*) AS count FROM note_versions WHERE note_id = 'dn_t'`), 0);
    // Erased once: the next sweep leaves it, and nothing restores it.
    assert.equal((await deleted.sweep(Date.now())).erased, 0);
    assert.equal(await deleted.restore(workspace, site, 'dn_t', Date.now()), undefined);
    // Still marked deleted for the page, so its issue stays off it, and out of the lists of the console.
    assert.deepEqual([...(await world.context.noteIndex!.removed(workspace, site, ['dn_t']))], ['dn_t']);
    const listed = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes`, {
      token: (await signInTo(world, 'alice@acme.dev')).token,
    });
    const notes = ((await listed.json()) as { notes: { excerpt: string }[] }).notes;
    assert.equal(
      notes.some((each) => each.excerpt === ''),
      false,
    );
  });

  it('sees « a deletion whose days ran out is not restored » go when it is taken out', async () => {
    const restoreLate = async (store: DeletedNotes, world: World, workspace: string, site: string) => {
      await rowsOf(
        world.database,
        `UPDATE note_index SET removed_at = ${Date.now() - 31 * DAY_MS} WHERE note_id = 'dn_1'`,
      );

      return store.restore(workspace, site, 'dn_1', Date.now());
    };
    const real = await aDeletedNote();
    assert.equal(await restoreLate(real.deleted, real.world, real.workspace, real.site), undefined, 'the control');

    const mutant = await mutatedModule('deleted-notes-postgres.ts', {
      from: 'gt(note_index.removed_at, deadline(now)),',
      to: '',
    });
    try {
      const create = mutant.module.createPostgresDeletedNotes as typeof createPostgresDeletedNotes;
      const other = await aDeletedNote();
      assert.notEqual(
        await restoreLate(create(other.world.database), other.world, other.workspace, other.site),
        undefined,
      );
    } finally {
      mutant.remove();
    }
  });
});
