import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { Note } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { readSiteChoices, readSitePage } from './console-sites.ts';
import type { NoteStore } from './store.ts';

const open = worlds();

/** A store that keeps the notes in memory: the index is what these tests read. */
function keptStore(): NoteStore {
  const kept: Note[] = [];

  return {
    name: 'test',
    scope: () => 'test',
    async create(note) {
      kept.push(note);

      return {
        id: `issue_${kept.length}`,
        identifier: `FB-${kept.length}`,
        url: `https://tracker.test/${kept.length}`,
      };
    },
    async findForPage() {
      return [];
    },
  };
}

/** A world with a workspace of Alice, the index on its database, and the sites of `origins`, in that order. */
async function aWorkspace(origins: readonly string[]) {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, store: keptStore(), noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const ids: string[] = [];
  for (const url of origins) {
    const added = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url, visibility: 'everyone' },
    });
    assert.equal(added.status, 201, await added.clone().text());
    ids.push(((await added.json()) as { id: string }).id);
    // Two sites added in the same millisecond have no order of their own: the list is by date.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  return { world, index, alice, workspace, ids };
}

async function leave(world: World, site: string, origin: string) {
  const answer = await callOn(world, 'POST', '/feedback', {
    origin,
    body: noteFixture({
      id: `sd_${Math.random().toString(36).slice(2, 10)}`,
      text: 'A note.',
      page: { url: `${origin}/pricing`, path: '/pricing', title: 'Pricing' },
      client: { id: site, name: 'Acme' },
    }),
  });
  assert.equal(answer.status, 201, await answer.clone().text());
}

async function read(world: World, path: string, token: string) {
  const answer = await callOn(world, 'GET', path, { token });

  return {
    status: answer.status,
    body: (await answer.json()) as Record<string, unknown> & { sites: Record<string, unknown>[] },
  };
}

describe('the reads of the sites of a workspace besides the whole list (FRU-497)', () => {
  it('counts the notes of the sites asked for, and of no other site', async () => {
    const { world, index, workspace, ids } = await aWorkspace(['https://acme.dev', 'https://quiet.acme.dev']);
    const [acme, quiet] = ids as [string, string];
    await leave(world, acme, 'https://acme.dev');
    await leave(world, quiet, 'https://quiet.acme.dev');

    const one = await index.summary(workspace, [acme]);
    assert.deepEqual([...one.keys()], [acme]);
    assert.equal((await index.summary(workspace, [])).size, 0);
    assert.deepEqual([...(await index.summary(workspace)).keys()].sort(), [acme, quiet].sort());
  });

  it('reads one site by its id, with its notes, and 404 for a site of another workspace', async () => {
    const { world, alice, workspace, ids } = await aWorkspace(['https://acme.dev', 'https://quiet.acme.dev']);
    const [acme] = ids as [string];
    await leave(world, acme, 'https://acme.dev');
    const other = await workspaceIn(world, alice.token, 'Other');

    const answer = await read(world, `/console/workspaces/${workspace}/sites/${acme}`, alice.token);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.id, acme);
    assert.equal(answer.body.origin, 'https://acme.dev');
    assert.deepEqual(answer.body.notes, { new: 1, todo: 0, progress: 0, done: 0, closed: 0 });
    assert.equal(answer.body.undelivered, 0);

    assert.equal((await read(world, `/console/workspaces/${other}/sites/${acme}`, alice.token)).status, 404);
    assert.equal((await read(world, `/console/workspaces/${workspace}/sites/site_gone`, alice.token)).status, 404);
  });

  it('answers a guest the sites shared with them, and 404 for another', async () => {
    const { world, workspace, ids } = await aWorkspace(['https://acme.dev', 'https://quiet.acme.dev']);
    const [acme, quiet] = ids as [string, string];
    const guest = await signInTo(world, 'guest@client.fr');
    await memberOf(world, workspace, guest.id, 'guest');
    await shareWith(world, workspace, guest.id, [acme]);

    const one = await read(world, `/console/workspaces/${workspace}/sites/${acme}`, guest.token);
    assert.equal(one.status, 200);
    assert.equal('undelivered' in one.body, false);
    assert.equal((await read(world, `/console/workspaces/${workspace}/sites/${quiet}`, guest.token)).status, 404);

    const choices = await read(world, `/console/workspaces/${workspace}/sites/choices`, guest.token);
    assert.deepEqual(
      choices.body.sites.map((site) => site.id),
      [acme],
    );
    const page = await read(world, `/console/workspaces/${workspace}/sites?limit=12`, guest.token);
    assert.deepEqual(
      page.body.sites.map((site) => site.id),
      [acme],
    );
    assert.equal(page.body.total, 1);
  });

  it('answers a page of the grid in the order of the list, with the total of the search', async () => {
    const origins = ['https://one.dev', 'https://two.dev', 'https://three.dev', 'https://www.thirty.dev'];
    const { world, alice, workspace, ids } = await aWorkspace(origins);
    await leave(world, ids[1] as string, 'https://two.dev');

    const first = await read(world, `/console/workspaces/${workspace}/sites?limit=2`, alice.token);
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.body.sites.map((site) => site.origin),
      ['https://one.dev', 'https://two.dev'],
    );
    assert.equal(first.body.total, 4);
    assert.deepEqual(first.body.sites[1]?.notes, { new: 1, todo: 0, progress: 0, done: 0, closed: 0 });

    const second = await read(world, `/console/workspaces/${workspace}/sites?limit=2&offset=2`, alice.token);
    assert.deepEqual(
      second.body.sites.map((site) => site.origin),
      ['https://three.dev', 'https://www.thirty.dev'],
    );
    // A page past the last one: no site, and the total still.
    const past = await read(world, `/console/workspaces/${workspace}/sites?limit=2&offset=8`, alice.token);
    assert.deepEqual(past.body, { sites: [], total: 4 });

    // The search is in the host, with no case: `https` finds nothing, `TH` finds two.
    const th = await read(world, `/console/workspaces/${workspace}/sites?limit=12&q=TH`, alice.token);
    assert.deepEqual(
      th.body.sites.map((site) => site.origin),
      ['https://three.dev', 'https://www.thirty.dev'],
    );
    assert.equal(th.body.total, 2);
    assert.equal(
      (await read(world, `/console/workspaces/${workspace}/sites?limit=12&q=https`, alice.token)).body.total,
      0,
    );
    // A `%` is a character, not every character.
    assert.equal(
      (await read(world, `/console/workspaces/${workspace}/sites?limit=12&q=%25`, alice.token)).body.total,
      0,
    );

    // With no page asked, every site, as before.
    const every = await read(world, `/console/workspaces/${workspace}/sites`, alice.token);
    assert.equal(every.body.sites.length, 4);
    assert.equal('total' in every.body, false);
    // `counts=none`: no read of the notes.
    const bare = await read(world, `/console/workspaces/${workspace}/sites?counts=none`, alice.token);
    assert.equal(bare.body.sites.length, 4);
    assert.equal('notes' in (bare.body.sites[1] ?? {}), false);
  });

  it('answers the sites to choose from by address, a page at a time, with no count', async () => {
    const origins = ['https://charlie.dev', 'https://alpha.dev', 'https://bravo.dev'];
    const { world, alice, workspace } = await aWorkspace(origins);
    const base = `/console/workspaces/${workspace}/sites/choices`;

    const first = await read(world, `${base}?limit=2`, alice.token);
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.body.sites.map((site) => Object.keys(site).sort()),
      [
        ['id', 'origin', 'visibility'],
        ['id', 'origin', 'visibility'],
      ],
    );
    assert.deepEqual(
      first.body.sites.map((site) => site.origin),
      ['https://alpha.dev', 'https://bravo.dev'],
    );
    assert.equal(first.body.next, 'https://bravo.dev');

    const second = await read(world, `${base}?limit=2&after=${encodeURIComponent('https://bravo.dev')}`, alice.token);
    assert.deepEqual(
      second.body.sites.map((site) => site.origin),
      ['https://charlie.dev'],
    );
    assert.equal('next' in second.body, false);

    const searched = await read(world, `${base}?q=rav`, alice.token);
    assert.deepEqual(
      searched.body.sites.map((site) => site.origin),
      ['https://bravo.dev'],
    );
  });

  it('refuses a page it cannot read, and a person of no workspace', async () => {
    const { world, alice, workspace } = await aWorkspace(['https://acme.dev']);
    for (const path of [
      'sites?limit=0',
      'sites?limit=101',
      'sites?limit=2&offset=-1',
      'sites?limit=x',
      'sites/choices?limit=501',
      'sites/choices?after=',
      `sites/choices?q=${'a'.repeat(201)}`,
    ]) {
      assert.equal((await read(world, `/console/workspaces/${workspace}/${path}`, alice.token)).status, 400, path);
    }
    const outsider = await signInTo(world, 'mallory@other.dev');
    for (const path of ['sites/choices', 'sites?limit=12']) {
      assert.equal((await read(world, `/console/workspaces/${workspace}/${path}`, outsider.token)).status, 404, path);
    }
    assert.equal(
      (await callOn(world, 'POST', `/console/workspaces/${workspace}/sites/choices`, { token: alice.token })).status,
      405,
    );
  });
});

describe('the address of a read of the sites (FRU-497)', () => {
  it('asks for no page with no limit and no offset', () => {
    assert.equal(readSitePage(new URLSearchParams('')), undefined);
    assert.deepEqual(readSitePage(new URLSearchParams('offset=12')), { ok: true, query: { offset: 12, limit: 12 } });
    assert.deepEqual(readSitePage(new URLSearchParams('limit=5&q=%20acme%20')), {
      ok: true,
      query: { offset: 0, limit: 5, q: 'acme' },
    });
  });

  it('reads 100 choices by default, and the cursor as it is given', () => {
    assert.deepEqual(readSiteChoices(new URLSearchParams('')), { ok: true, query: { limit: 100 } });
    assert.deepEqual(readSiteChoices(new URLSearchParams('after=https%3A%2F%2Fa.dev&limit=500')), {
      ok: true,
      query: { limit: 500, after: 'https://a.dev' },
    });
  });
});
