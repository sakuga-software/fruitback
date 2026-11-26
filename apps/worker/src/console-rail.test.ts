import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { NOTE_STAGES, type NoteStage } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import type { NoteIndex } from './notes-index.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

const open = worlds();
const BASE = Date.parse('2026-10-01T00:00:00.000Z');

type Rail = { sites: number; notes?: number; failing?: number; views?: { assigned: number } };

/**
 * A workspace of Alice with three sites and 30 notes, six of each stage, ten on each site. Bob is a
 * member and Gina a guest of the first site. Four notes are tasks of Alice, one of Bob; two notes are
 * archived. The connector of the workspace has three deliveries that did not arrive. Another workspace
 * has a site, notes, and a delivery of its own, which no count of this one reads.
 */
async function aWorkspace() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');

  const sites = [];
  for (const origin of ['https://acme.dev', 'https://quiet.acme.dev', 'https://shop.acme.dev']) {
    sites.push(await world.accounts.addSite(workspace, { origin, visibility: 'everyone' }));
  }
  const [first] = sites as [(typeof sites)[number]];
  await shareWith(world, workspace, gina.id, [first.id]);

  const plant = async (into: string, site: string, i: number, stage: NoteStage) =>
    index.record(
      [
        {
          workspace: into,
          site,
          note: noteFixture({ id: `sd_${into.slice(-4)}${String(i).padStart(3, '0')}` }),
          channel: 'script',
          author: { kind: 'visitor' },
          place: { kind: 'fruitback' },
          issue: { identifier: `FB-${i}` },
          stage,
        },
      ],
      BASE + i * 1_000,
    );
  for (let i = 0; i < 30; i += 1) {
    await plant(workspace, (sites[i % 3] as (typeof sites)[number]).id, i, NOTE_STAGES[i % 5] as NoteStage);
  }
  // Tasks of Alice: two open, one done; one open and archived. A task of Bob.
  const notesOf = (ids: number[]) => ids.map((i) => `'sd_${workspace.slice(-4)}${String(i).padStart(3, '0')}'`);
  await rowsOf(
    world.database,
    `UPDATE note_index SET task_assignee_id = '${alice.id}' WHERE note_id IN (${notesOf([0, 1, 3, 5]).join(',')})`,
  );
  await rowsOf(
    world.database,
    `UPDATE note_index SET task_assignee_id = '${bob.id}' WHERE note_id IN (${notesOf([2]).join(',')})`,
  );
  // Archived: note 5 (new, Alice's) and note 6 (todo).
  await rowsOf(
    world.database,
    `UPDATE note_index SET archived_at = ${BASE} WHERE note_id IN (${notesOf([5, 6]).join(',')})`,
  );

  const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.test', sealed: 'x' });
  for (let n = 0; n < 3; n += 1) await world.accounts.enqueueDelivery(hook.id, `{"n":${n}}`, BASE);
  // One gave up: no next attempt. It still did not arrive.
  await rowsOf(world.database, `UPDATE deliveries SET next_at = NULL, attempts = 6 WHERE body = '{"n":0}'`);

  const zed = await signInTo(world, 'zed@other.dev');
  const other = await workspaceIn(world, zed.token, 'Other');
  const elsewhere = await world.accounts.addSite(other, { origin: 'https://other.dev', visibility: 'everyone' });
  for (let i = 0; i < 4; i += 1) await plant(other, elsewhere.id, 100 + i, 'new');
  const theirs = await world.accounts.addConnector(other, { kind: 'rest', label: 'hooks.other.test', sealed: 'x' });
  await world.accounts.enqueueDelivery(theirs.id, '{"n":9}', BASE);

  return { world, index, alice, bob, gina, workspace, sites, other };
}

async function railOf(world: Awaited<ReturnType<typeof open>>, workspace: string, token: string) {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/rail`, { token });

  return { status: answer.status, body: (await answer.json()) as Rail };
}

describe('the counts of the bar of the console (FRU-711)', () => {
  it('counts the sites, the open notes, the tasks of the caller and the deliveries that did not arrive', async () => {
    const { world, alice, bob, workspace } = await aWorkspace();

    // 30 notes, six of each stage: 18 are new, to do or in progress. The two archived ones are of
    // those, so 16. The tasks of Alice: notes 0, 1 and 3 (done counts: the view has no stage), and 5
    // is archived.
    const owner = await railOf(world, workspace, alice.token);
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body, { sites: 3, notes: 16, failing: 3, views: { assigned: 3 } });

    // The tasks are of the caller: Bob has one.
    const member = await railOf(world, workspace, bob.token);
    assert.deepEqual(member.body, { sites: 3, notes: 16, failing: 3, views: { assigned: 1 } });
  });

  it('says the total the list of the notes answers for the same filter', async () => {
    const { world, alice, gina, workspace } = await aWorkspace();
    const totalOf = async (token: string, query: string) => {
      const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes?${query}`, { token });
      assert.equal(answer.status, 200, await answer.clone().text());

      return ((await answer.json()) as { total: number }).total;
    };

    for (const token of [alice.token, gina.token]) {
      const { body } = await railOf(world, workspace, token);
      assert.equal(body.notes, await totalOf(token, 'unresolved=1'));
      assert.equal(body.views?.assigned, await totalOf(token, 'assignee=me'));
    }
  });

  it('counts for a guest the sites shared with them and their notes, and no delivery', async () => {
    const { world, gina, workspace } = await aWorkspace();

    const guest = await railOf(world, workspace, gina.token);
    assert.equal(guest.status, 200);
    // The first site: notes 0, 3, 6, … 27, ten of them; stages new, done, progress, new, done, …
    // 6 is archived. Open: i % 5 in {0, 1, 2} among 0, 3, 6, 9, 12, 15, 18, 21, 24, 27 → 0, 6, 12, 15,
    // 21, 27 → six, less the archived 6: five.
    assert.deepEqual(guest.body, { sites: 1, notes: 5, views: { assigned: 0 } });
    assert.equal('failing' in guest.body, false);
  });

  it('answers 404 to a person who is not a member, 401 to nobody, 405 to a write', async () => {
    const { world, alice, workspace, other } = await aWorkspace();
    const stranger = await signInTo(world, 'stranger@else.dev');

    assert.equal((await railOf(world, workspace, stranger.token)).status, 404);
    // The other workspace exists: the answer is the same as for an id that is no workspace.
    assert.equal((await railOf(world, other, stranger.token)).status, 404);
    assert.equal((await railOf(world, 'ws_none', stranger.token)).status, 404);
    const anonymous = await callOn(world, 'GET', `/console/workspaces/${workspace}/rail`);
    assert.equal(anonymous.status, 401);
    const posted = await callOn(world, 'POST', `/console/workspaces/${workspace}/rail`, { token: alice.token });
    assert.equal(posted.status, 405);
  });

  it('answers the sites and the deliveries when the index of the notes does not answer', async () => {
    const { world, alice, workspace, index } = await aWorkspace();
    const down: NoteIndex = {
      ...index,
      frameCounts: () => Promise.reject(new Error('the index stopped')),
    };
    const answer = await callOn(
      world,
      'GET',
      `/console/workspaces/${workspace}/rail`,
      { token: alice.token },
      {
        noteIndex: down,
      },
    );
    assert.equal(answer.status, 200);
    // No count of the notes is no zero: absent.
    assert.deepEqual(await answer.json(), { sites: 3, failing: 3 });
  });

  it('counts an empty workspace as zeros', async () => {
    const world = await open();
    world.context = { ...world.context, noteIndex: createPostgresNoteIndex(world.database) };
    const alice = await signInTo(world, 'alice@acme.dev');
    const workspace = await workspaceIn(world, alice.token);

    const { body } = await railOf(world, workspace, alice.token);
    assert.deepEqual(body, { sites: 0, notes: 0, failing: 0, views: { assigned: 0 } });
  });
});
