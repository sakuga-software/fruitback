import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountStore } from './accounts.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { dayOf, forgetSeen } from './last-seen.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * « Last seen » of a member (FRU-249, Q7 of Mathieu): the day of their last call to the console in a
 * workspace, or of the last refresh of their extension for it, read by an owner or an admin only.
 * And the short label of the browser of a session of the console, read from its user agent once.
 */

const world = worlds();

/** Alice owns Acme, with one person of each other role in it; Mallory owns another workspace. */
async function acme(env: World) {
  const alice = await signInTo(env, 'alice@acme.dev');
  const id = await workspaceIn(env, alice.token, 'Acme');
  const people: Record<string, { id: string; token: string }> = { owner: alice };
  for (const role of ['admin', 'member', 'guest']) {
    const person = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, id, person.id, role);
    people[role] = person;
  }
  const mallory = await signInTo(env, 'mallory@evil.dev');
  const other = await workspaceIn(env, mallory.token, 'Evil');
  const seenBy = (token: string | undefined, workspace = id, method = 'GET') =>
    callOn(env, method, `/console/workspaces/${workspace}/members/seen`, token === undefined ? {} : { token });

  return { id, other, people, mallory, seenBy };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

describe('« Last seen » of the members of a workspace (FRU-249)', () => {
  it('answers the day of each member to an owner and to an admin', async () => {
    const env = await world();
    const { id, people, seenBy } = await acme(env);
    // The member calls the console in Acme: seen today.
    assert.equal(
      (await callOn(env, 'GET', `/console/workspaces/${id}/sites`, { token: people.member?.token })).status,
      200,
    );

    for (const role of ['owner', 'admin']) {
      const answer = await seenBy(people[role]?.token);
      assert.equal(answer.status, 200, role);
      const { seen } = (await answer.json()) as { seen: Record<string, string> };
      assert.equal(seen[people.member?.id ?? ''], dayOf(Date.now()), role);
      // A day, and no hour.
      for (const day of Object.values(seen)) assert.match(day, DAY, role);
    }
  });

  it('answers nothing of it to a member, a guest, another workspace, nobody, or an extension', async () => {
    const env = await world();
    const { id, people, mallory, other, seenBy } = await acme(env);

    for (const role of ['member', 'guest']) {
      const refused = await seenBy(people[role]?.token);
      assert.equal(refused.status, 403, role);
      assert.deepEqual(await refused.json(), { error: 'forbidden', role }, role);
    }
    // Mallory owns another workspace: Acme is a workspace that does not exist for her.
    assert.equal((await seenBy(mallory.token)).status, 404);
    // Alice is not of Mallory's workspace either.
    assert.equal((await seenBy(people.owner?.token, other)).status, 404);
    assert.equal((await seenBy(undefined)).status, 401);
    assert.equal((await seenBy(people.owner?.token, id, 'POST')).status, 405);

    // The token of an extension of the owner opens no route of the console.
    const { accessToken } = await extensionOf(env, id, people.owner?.token ?? '');
    assert.equal((await seenBy(accessToken)).status, 401);
  });

  it('sees a member in the workspace they called, and in no other one', async () => {
    const env = await world();
    const { people, seenBy } = await acme(env);
    // The member has a workspace of their own, and the owner of Acme is an admin there: the days of
    // that workspace are not the days of Acme.
    const theirs = await workspaceIn(env, people.member?.token ?? '', 'Elsewhere');
    await memberOf(env, theirs, people.owner?.id ?? '', 'admin');
    const zoe = await signInTo(env, 'zoe@client.fr');
    await memberOf(env, theirs, zoe.id, 'member');
    forgetSeen();

    for (const who of [people.member, zoe]) {
      const call = await callOn(env, 'GET', `/console/workspaces/${theirs}/sites`, { token: who?.token });
      assert.equal(call.status, 200);
    }
    const { seen } = (await (await seenBy(people.owner?.token)).json()) as { seen: Record<string, string> };
    assert.equal(seen[people.member?.id ?? ''], undefined);
    assert.equal(seen[zoe.id], undefined);
    // The control: in the member's workspace, both are seen.
    const there = (await (await seenBy(people.owner?.token, theirs)).json()) as { seen: Record<string, string> };
    assert.deepEqual(Object.keys(there.seen).sort(), [people.member?.id, people.owner?.id, zoe.id].sort());
  });

  it('sees the person of an extension that refreshes for the workspace', async () => {
    const env = await world();
    const { id, people, seenBy } = await acme(env);
    const tokens = await extensionOf(env, id, people.owner?.token ?? '');
    // What the console call that paired it wrote goes, so only the refresh can write it.
    await rowsOf(env.database, 'DELETE FROM last_seen');
    forgetSeen();

    const refreshed = await callOn(env, 'POST', '/session/refresh', {
      body: { refreshToken: tokens.refreshToken },
      origin: null,
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const days = await rowsOf(env.database, 'SELECT day FROM last_seen');
    assert.deepEqual(days, [{ day: dayOf(Date.now()) }]);
    const { seen } = (await (await seenBy(people.admin?.token)).json()) as { seen: Record<string, string> };
    assert.equal(seen[people.owner?.id ?? ''], dayOf(Date.now()));
  });

  it('writes the day again at the next call when a write failed, and fails no call for it', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    forgetSeen();
    const failing: AccountStore = {
      ...(env.context.accounts as AccountStore),
      markSeen: async () => {
        throw new Error('the database did not answer');
      },
    };

    // The write fails: the call of the member is answered all the same, and nothing is kept.
    const call = await callOn(
      env,
      'GET',
      `/console/workspaces/${id}/sites`,
      { token: people.member?.token },
      {
        accounts: failing,
      },
    );
    assert.equal(call.status, 200);
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), []);
    // The next call of the same day writes it: the failure was not remembered as a day written.
    await callOn(env, 'GET', `/console/workspaces/${id}/sites`, { token: people.member?.token });
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), [{ day: dayOf(Date.now()) }]);
  });

  it('writes once a day for a person in a workspace, and forgets the day when they leave', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    forgetSeen();
    const call = () => callOn(env, 'GET', `/console/workspaces/${id}/sites`, { token: people.member?.token });
    await call();
    await rowsOf(env.database, `UPDATE last_seen SET day = '2026-01-01'`);

    // The same day, in the same process: nothing is written again.
    await call();
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), [{ day: '2026-01-01' }]);
    // The control: a process that does not remember writes today.
    forgetSeen();
    await call();
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), [{ day: dayOf(Date.now()) }]);

    // The owner removes the member, through the plugin, and the member comes back the same day: seen
    // again at once, and not only from tomorrow.
    const removed = await callOn(env, 'POST', '/console/auth/organization/remove-member', {
      token: people.owner?.token,
      body: { organizationId: id, memberIdOrEmail: 'member@acme.dev' },
    });
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), []);
    await memberOf(env, id, people.member?.id ?? '', 'member');
    await call();
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), [{ day: dayOf(Date.now()) }]);

    // The member leaves: their day goes with the membership.
    await rowsOf(env.database, `DELETE FROM member WHERE "userId" = '${people.member?.id}'`);
    assert.deepEqual(await rowsOf(env.database, 'SELECT day FROM last_seen'), []);
  });
});

const { opening } = databasesOfACase();

const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

for (const { label, open, skip } of DATABASES) {
  describe(`the short label of the browser of a session of the console, on ${label} (FRU-249)`, { skip }, () => {
    /** A link asked for and spent by a browser that says who it is. */
    async function signInWith(worker: Awaited<ReturnType<typeof workerOf>>, userAgent: string): Promise<string> {
      const headers = { 'User-Agent': userAgent };
      assert.equal(
        (await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' }, headers })).status,
        202,
      );
      const answer = await worker.call('/console/auth/email/redeem', { body: { token: worker.lastToken() }, headers });
      assert.equal(answer.status, 200);

      return answer.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');
    }

    it('keeps « Firefox on Linux », and not the user agent, and lists it with the session', async () => {
      const worker = await workerOf(await opening(open));
      const cookie = await signInWith(worker, FIREFOX_ON_LINUX);

      assert.deepEqual(await rowsOf(worker.database, 'SELECT browser, "userAgent", "ipAddress" FROM "session"'), [
        { browser: 'Firefox on Linux', userAgent: null, ipAddress: null },
      ]);
      const listed = await worker.call('/console/sessions', { headers: { Cookie: cookie } });
      const { sessions } = (await listed.json()) as { sessions: Record<string, unknown>[] };
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.browser, 'Firefox on Linux');
      assert.equal('userAgent' in (sessions[0] ?? {}), false);
    });

    it('keeps the label beside the user agent when the operator keeps addresses', async () => {
      const worker = await workerOf(await opening(open), { trackIp: true });
      await signInWith(worker, FIREFOX_ON_LINUX);

      assert.deepEqual(await rowsOf(worker.database, 'SELECT browser, "userAgent" FROM "session"'), [
        { browser: 'Firefox on Linux', userAgent: FIREFOX_ON_LINUX },
      ]);
    });

    it('says « A browser » for a session opened before the label, or by a client it does not know', async () => {
      const worker = await workerOf(await opening(open));
      const cookie = await signInWith(worker, 'curl/8.7.1');
      assert.deepEqual(await rowsOf(worker.database, 'SELECT browser FROM "session"'), [{ browser: 'A browser' }]);

      await rowsOf(worker.database, 'UPDATE "session" SET browser = NULL');
      const { sessions } = (await (await worker.call('/console/sessions', { headers: { Cookie: cookie } })).json()) as {
        sessions: { browser?: string }[];
      };
      assert.equal(sessions[0]?.browser, 'A browser');
    });
  });
}

/** An extension that the person of `token` paired for `workspace`, through the console: its tokens. */
async function extensionOf(env: World, workspace: string, token: string) {
  const minted = await callOn(env, 'POST', `/console/workspaces/${workspace}/connect`, { token, body: {} });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const paired = await callOn(env, 'POST', '/session/pair', { body: { code }, origin: null });
  assert.equal(paired.status, 200, await paired.clone().text());

  return (await paired.json()) as { refreshToken: string; accessToken: string };
}
