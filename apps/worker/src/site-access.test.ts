import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The tab « Access » of a site (FRU-703), as the worker answers it. The console only shows and sends
 * what is stored: `POST …/sites` changes it, for a role that already changes a site (`manage-sites`,
 * an owner or an admin), and `GET …/sites/<id>` reads it. Each case goes through `handleRequest`.
 */

const open = worlds();
const SITE = 'https://staging.acme.test';

async function aSite() {
  const world = await open();
  const ana = await signInTo(world, 'ana@acme.dev');
  const workspace = await workspaceIn(world, ana.token);
  const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
    token: ana.token,
    body: { url: SITE, visibility: 'everyone', writers: 'anyone' },
  });
  assert.equal(made.status, 201, await made.clone().text());
  const site = ((await made.json()) as { id: string }).id;
  const stored = async () =>
    (
      await rowsOf(
        world.database,
        `SELECT visibility, writers, visitor_edit, visitor_delete FROM sites WHERE id = '${site}'`,
      )
    ).map((row) => [row.visibility, row.writers, row.visitor_edit, row.visitor_delete])[0];

  return { world, ana, workspace, site, stored };
}

describe('what a visitor may do on a site, set in the console (FRU-703)', () => {
  it('gives a new site the level « Contribute » of the mockup, and reads it on the page of the site', async () => {
    const { world, ana, workspace, site, stored } = await aSite();

    assert.deepEqual(await stored(), ['everyone', 'anyone', 'while-open', 'while-open']);
    const read = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites/${site}`, { token: ana.token });
    assert.equal(read.status, 200);
    const view = (await read.json()) as Record<string, unknown>;
    assert.deepEqual([view.visitorEdit, view.visitorDelete], ['while-open', 'while-open']);
  });

  it('changes each right and the level for an owner, and keeps what a caller does not name', async () => {
    const { world, ana, workspace, stored } = await aSite();
    const post = (body: Record<string, unknown>) =>
      callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: ana.token,
        body: { url: SITE, ...body },
      });

    const set = await post({
      visibility: 'everyone',
      writers: 'members',
      visitorEdit: 'never',
      visitorDelete: 'while-open',
    });
    assert.equal(set.status, 201, await set.clone().text());
    const answered = (await set.json()) as Record<string, unknown>;
    assert.deepEqual(
      [answered.writers, answered.visitorEdit, answered.visitorDelete],
      ['members', 'never', 'while-open'],
    );
    assert.deepEqual(await stored(), ['everyone', 'members', 'never', 'while-open']);

    // The extension changes the visibility only: it names neither right, and changes neither.
    assert.equal((await post({ visibility: 'members' })).status, 201);
    assert.deepEqual(await stored(), ['members', 'members', 'never', 'while-open']);
  });

  it('refuses a value that is not a right, and changes nothing', async () => {
    const { world, ana, workspace, stored } = await aSite();

    for (const [field, value, error] of [
      ['visitorEdit', 'sometimes', 'invalid-visitor-edit'],
      ['visitorDelete', true, 'invalid-visitor-delete'],
      ['visitorEdit', null, 'invalid-visitor-edit'],
      // A visitor never acts on a note that is done or closed: « at any time » is no right.
      ['visitorDelete', 'always', 'invalid-visitor-delete'],
    ] as const) {
      const answer = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: ana.token,
        body: { url: SITE, visibility: 'members', writers: 'members', [field]: value },
      });
      assert.equal(answer.status, 400, `${field}: ${String(value)}`);
      assert.deepEqual(await answer.json(), { error });
    }
    assert.deepEqual(await stored(), ['everyone', 'anyone', 'while-open', 'while-open']);
  });

  it('refuses a member and a guest, who do not change a site, and changes nothing', async () => {
    const { world, workspace, stored } = await aSite();

    for (const role of ['member', 'guest'] as const) {
      const person = await signInTo(world, `${role}@acme.dev`);
      await memberOf(world, workspace, person.id, role);
      const answer = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: person.token,
        body: { url: SITE, visibility: 'members', writers: 'members', visitorEdit: 'never', visitorDelete: 'never' },
      });
      assert.equal(answer.status, 403, role);
    }
    assert.deepEqual(await stored(), ['everyone', 'anyone', 'while-open', 'while-open']);
  });
});

describe('the notes of a visitor in an hour, set in the console (FRU-704)', () => {
  const limitOf = async (world: Awaited<ReturnType<typeof aSite>>['world'], site: string) =>
    (await rowsOf(world.database, `SELECT visitor_notes_per_hour FROM sites WHERE id = '${site}'`))[0]
      ?.visitor_notes_per_hour;

  it('gives a new site 10 an hour, changes it for an owner, and keeps it when a caller does not name it', async () => {
    const { world, ana, workspace, site } = await aSite();
    assert.equal(await limitOf(world, site), 10);
    const read = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites/${site}`, { token: ana.token });
    assert.equal(((await read.json()) as Record<string, unknown>).visitorNotesPerHour, 10);

    for (const value of [0, 50, 5]) {
      const set = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: ana.token,
        body: { url: SITE, visibility: 'everyone', writers: 'anyone', visitorNotesPerHour: value },
      });
      assert.equal(set.status, 201, await set.clone().text());
      assert.equal(((await set.json()) as Record<string, unknown>).visitorNotesPerHour, value);
      assert.equal(await limitOf(world, site), value);
    }
    // The extension changes the visibility only, and keeps the limit.
    await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: ana.token,
      body: { url: SITE, visibility: 'members' },
    });
    assert.equal(await limitOf(world, site), 5);
  });

  it('refuses a value that is not one of the list, and changes nothing', async () => {
    const { world, ana, workspace, site } = await aSite();

    for (const value of [7, -1, '10', null, 10.5, 1000]) {
      const answer = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: ana.token,
        body: { url: SITE, visibility: 'everyone', writers: 'anyone', visitorNotesPerHour: value },
      });
      assert.equal(answer.status, 400, String(value));
      assert.deepEqual(await answer.json(), { error: 'invalid-visitor-notes-per-hour' });
    }
    assert.equal(await limitOf(world, site), 10);
  });

  it('refuses a member and a guest, and changes nothing', async () => {
    const { world, workspace, site } = await aSite();

    for (const role of ['member', 'guest'] as const) {
      const person = await signInTo(world, `${role}-limit@acme.dev`);
      await memberOf(world, workspace, person.id, role);
      const answer = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: person.token,
        body: { url: SITE, visibility: 'everyone', writers: 'anyone', visitorNotesPerHour: 0 },
      });
      assert.equal(answer.status, 403, role);
    }
    assert.equal(await limitOf(world, site), 10);
  });
});
