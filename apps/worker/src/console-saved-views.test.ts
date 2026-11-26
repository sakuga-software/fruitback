import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { MAX_SAVED_VIEWS } from './accounts.ts';
import { callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { VIEW_NAME_MAX } from './console-saved-views.ts';
import { rowsOf } from './postgres.fixture.ts';

const open = worlds();

type View = { id: string; name: string; filters: Record<string, string>; createdAt: number };

/**
 * A workspace of Alice with two sites. Bob is a member, Gina a guest of the first site. Zed has a
 * workspace of his own.
 */
async function aWorkspace() {
  const world = await open();
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');
  const first = await world.accounts.addSite(workspace, { origin: 'https://acme.dev', visibility: 'everyone' });
  const second = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'everyone' });
  await shareWith(world, workspace, gina.id, [first.id]);
  const zed = await signInTo(world, 'zed@other.dev');
  const other = await workspaceIn(world, zed.token, 'Other');

  return { world, alice, bob, gina, zed, workspace, other, first, second };
}

type World = Awaited<ReturnType<typeof aWorkspace>>['world'];

async function views(world: World, workspace: string, token: string) {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/views`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return ((await answer.json()) as { views: View[] }).views;
}

async function save(world: World, workspace: string, token: string, body: unknown) {
  const answer = await callOn(world, 'POST', `/console/workspaces/${workspace}/views`, { token, body });

  return { status: answer.status, body: (await answer.json()) as { view?: View; error?: string; field?: string } };
}

describe('the views of a person (FRU-723)', () => {
  it('keeps a view, lists it, renames it and deletes it', async () => {
    const { world, alice, workspace } = await aWorkspace();
    assert.deepEqual(await views(world, workspace, alice.token), []);

    const saved = await save(world, workspace, alice.token, {
      name: '  Urgent bugs  ',
      filters: { priority: 'urgent', stage: 'new' },
    });
    assert.equal(saved.status, 201);
    const view = saved.body.view as View;
    assert.match(view.id, /^view_/);
    assert.equal(view.name, 'Urgent bugs');
    assert.deepEqual(view.filters, { priority: 'urgent', stage: 'new' });
    assert.deepEqual(await views(world, workspace, alice.token), [view]);

    const renamed = await callOn(world, 'POST', `/console/workspaces/${workspace}/views/${view.id}`, {
      token: alice.token,
      body: { name: 'Fires' },
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(((await renamed.json()) as { view: View }).view, { ...view, name: 'Fires' });
    assert.deepEqual(await views(world, workspace, alice.token), [{ ...view, name: 'Fires' }]);

    const deleted = await callOn(world, 'DELETE', `/console/workspaces/${workspace}/views/${view.id}`, {
      token: alice.token,
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await views(world, workspace, alice.token), []);
    // Deleted once: a second time is a view that does not exist.
    const again = await callOn(world, 'DELETE', `/console/workspaces/${workspace}/views/${view.id}`, {
      token: alice.token,
    });
    assert.equal(again.status, 404);
  });

  it('lists the views oldest first', async () => {
    const { world, alice, workspace } = await aWorkspace();
    const names = ['First', 'Second', 'Third'];
    for (const [i, name] of names.entries()) {
      await save(world, workspace, alice.token, { name, filters: { q: `word${i}` } });
    }

    assert.deepEqual(
      (await views(world, workspace, alice.token)).map((view) => view.name),
      names,
    );
  });

  it('keeps the views of one person from every other, in the workspace and out of it', async () => {
    const { world, alice, bob, zed, workspace, other } = await aWorkspace();
    const view = (await save(world, workspace, alice.token, { name: 'Mine', filters: { mine: '1' } })).body
      .view as View;

    // Bob, of the same workspace, reads none of it, and changes none of it.
    assert.deepEqual(await views(world, workspace, bob.token), []);
    const path = `/console/workspaces/${workspace}/views/${view.id}`;
    const renamed = await callOn(world, 'POST', path, { token: bob.token, body: { name: 'Taken' } });
    assert.equal(renamed.status, 404);
    assert.equal((await callOn(world, 'DELETE', path, { token: bob.token })).status, 404);
    // Alice, in a workspace of hers, reaches it; by another workspace, she does not.
    const otherPath = `/console/workspaces/${other}/views/${view.id}`;
    assert.equal((await callOn(world, 'DELETE', otherPath, { token: zed.token })).status, 404);
    // Zed is not a member of the workspace of Alice: as a workspace that does not exist.
    assert.equal(
      (await callOn(world, 'GET', `/console/workspaces/${workspace}/views`, { token: zed.token })).status,
      404,
    );
    // The control: the view is there, with its name.
    assert.deepEqual(await views(world, workspace, alice.token), [view]);
    // Somebody who is not signed in reads nothing.
    assert.equal((await callOn(world, 'GET', `/console/workspaces/${workspace}/views`)).status, 401);
  });

  it('refuses a name that is empty, too long or not of one line', async () => {
    const { world, alice, workspace } = await aWorkspace();
    for (const name of [undefined, 7, '', '   ', 'x'.repeat(VIEW_NAME_MAX + 1), 'two\nlines']) {
      const { status, body } = await save(world, workspace, alice.token, { name, filters: { mine: '1' } });
      assert.equal(status, 400, String(name));
      assert.equal(body.error, 'invalid-name');
    }
    // The control: the longest name is kept.
    assert.equal(
      (await save(world, workspace, alice.token, { name: 'é'.repeat(VIEW_NAME_MAX), filters: { mine: '1' } })).status,
      201,
    );
  });

  it('refuses filters that the list does not read', async () => {
    const { world, alice, workspace } = await aWorkspace();
    const refused: [unknown, string | undefined][] = [
      [undefined, undefined],
      [{}, undefined],
      [['mine'], undefined],
      [{ page: '2' }, undefined],
      [{ mine: '' }, undefined],
      [{ mine: 1 }, undefined],
      [{ stage: 'later' }, 'invalid-stage'],
      [{ due: 'tomorrow' }, 'invalid-due'],
      [{ created: 'month' }, 'invalid-created'],
      [{ site: 'a b' }, 'invalid-site'],
      [{ q: 'x'.repeat(500) }, 'invalid-q'],
    ];
    for (const [filters, field] of refused) {
      const { status, body } = await save(world, workspace, alice.token, { name: 'View', filters });
      assert.equal(status, 400, JSON.stringify(filters));
      assert.equal(body.error, 'invalid-filters');
      assert.equal(body.field, field, JSON.stringify(filters));
    }
    assert.deepEqual(await views(world, workspace, alice.token), []);
    // The control: each filter of the Notes screen, with a value the list reads. `unresolved` says no
    // stage, as on the list: the stage is in a view of its own.
    assert.equal((await save(world, workspace, alice.token, { name: 'New', filters: { stage: 'new' } })).status, 201);
    const every = {
      place: 'con_x',
      site: 'site_x',
      mine: '1',
      archived: '1',
      unresolved: '1',
      assignee: 'me',
      priority: 'none',
      label: 'lbl_x',
      due: 'week',
      created: 'week',
      undelivered: '1',
      q: 'button',
    };
    const kept = await save(world, workspace, alice.token, { name: 'Every filter', filters: every });
    assert.equal(kept.status, 201, JSON.stringify(kept.body));
    assert.deepEqual(kept.body.view?.filters, every);
  });

  it('keeps for a guest only filters a guest reads', async () => {
    const { world, gina, workspace, first, second } = await aWorkspace();
    for (const filters of [{ place: 'con_x' }, { undelivered: '1' }, { site: second.id }]) {
      const { status, body } = await save(world, workspace, gina.token, { name: 'View', filters });
      assert.equal(status, 403, JSON.stringify(filters));
      assert.equal(body.error, 'forbidden');
    }
    // The control: the site shared with her, and filters that she reads.
    const kept = await save(world, workspace, gina.token, {
      name: 'My site',
      filters: { site: first.id, stage: 'new' },
    });
    assert.equal(kept.status, 201);
    assert.equal((await save(world, workspace, gina.token, { name: 'Mine', filters: { mine: '1' } })).status, 201);
    assert.equal((await views(world, workspace, gina.token)).length, 2);

    // The site is no longer shared with her: its view is no longer answered; the other one is.
    await rowsOf(world.database, `DELETE FROM site_shares WHERE site_id = '${first.id}'`);
    assert.deepEqual(
      (await views(world, workspace, gina.token)).map((view) => view.name),
      ['Mine'],
    );
  });

  it('answers no view of the tracker to a member who became a guest', async () => {
    const { world, bob, workspace } = await aWorkspace();
    await save(world, workspace, bob.token, { name: 'Not delivered', filters: { undelivered: '1' } });
    await save(world, workspace, bob.token, { name: 'New', filters: { stage: 'new' } });
    assert.equal((await views(world, workspace, bob.token)).length, 2);

    await rowsOf(world.database, `UPDATE member SET role = 'guest' WHERE "userId" = '${bob.id}'`);
    assert.deepEqual(
      (await views(world, workspace, bob.token)).map((view) => view.name),
      ['New'],
    );
  });

  it(`keeps ${MAX_SAVED_VIEWS} views a person at most`, async () => {
    const { world, alice, bob, workspace } = await aWorkspace();
    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1) {
      assert.equal(
        (await save(world, workspace, alice.token, { name: `View ${i}`, filters: { q: `w${i}` } })).status,
        201,
      );
    }
    const over = await save(world, workspace, alice.token, { name: 'One more', filters: { mine: '1' } });
    assert.equal(over.status, 409);
    assert.equal(over.body.error, 'too-many-views');
    assert.equal((await views(world, workspace, alice.token)).length, MAX_SAVED_VIEWS);
    // The limit is of each person: Bob keeps his.
    assert.equal((await save(world, workspace, bob.token, { name: 'His', filters: { mine: '1' } })).status, 201);
  });

  it('counts two views saved at once against the limit', async () => {
    const { world, alice, workspace } = await aWorkspace();
    for (let i = 0; i < MAX_SAVED_VIEWS - 1; i += 1) {
      await save(world, workspace, alice.token, { name: `View ${i}`, filters: { q: `w${i}` } });
    }
    const both = await Promise.all([
      save(world, workspace, alice.token, { name: 'A', filters: { mine: '1' } }),
      save(world, workspace, alice.token, { name: 'B', filters: { mine: '1' } }),
    ]);

    assert.deepEqual(both.map((each) => each.status).toSorted(), [201, 409]);
    assert.equal((await views(world, workspace, alice.token)).length, MAX_SAVED_VIEWS);
  });

  it('takes the views of a person away with their membership', async () => {
    const { world, bob, workspace } = await aWorkspace();
    await save(world, workspace, bob.token, { name: 'Mine', filters: { mine: '1' } });
    const count = async () => (await rowsOf(world.database, 'SELECT id FROM saved_views')).length;
    assert.equal(await count(), 1);

    await rowsOf(world.database, `DELETE FROM member WHERE "userId" = '${bob.id}'`);
    assert.equal(await count(), 0);
    // He comes back: he starts with none.
    await memberOf(world, workspace, bob.id, 'member');
    assert.deepEqual(await views(world, workspace, bob.token), []);
  });

  it('refuses a rename with no name, and answers the methods it does not take', async () => {
    const { world, alice, workspace } = await aWorkspace();
    const view = (await save(world, workspace, alice.token, { name: 'Mine', filters: { mine: '1' } })).body
      .view as View;
    const path = `/console/workspaces/${workspace}/views/${view.id}`;
    const nameless = await callOn(world, 'POST', path, { token: alice.token, body: { name: ' ' } });
    assert.equal(nameless.status, 400);
    assert.deepEqual(await nameless.json(), { error: 'invalid-name' });
    assert.equal((await callOn(world, 'GET', path, { token: alice.token })).status, 405);
    assert.equal(
      (await callOn(world, 'DELETE', `/console/workspaces/${workspace}/views`, { token: alice.token })).status,
      405,
    );
    // The control: the view kept its name.
    assert.deepEqual(await views(world, workspace, alice.token), [view]);
  });
});
