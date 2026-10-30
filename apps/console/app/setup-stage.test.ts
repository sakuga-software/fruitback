import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Answer, Workspace } from './api.ts';
import { type SetupCalls, firstWorkspace, leaveFor, noted, resolveStage, siteNow, siteStage } from './setup-stage.ts';

/**
 * Where the setup takes a person (FRU-239), with a worker of fakes: each case says what the worker
 * answers, and the test reads the stage and what was asked of it.
 */
const account = { id: 'a1', email: 'ana@acme.dev' };
const owner: Workspace = { id: 'w1', name: 'Acme', role: 'owner' };
const member: Workspace = { id: 'w1', name: 'Acme', role: 'member' };
const site = { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' as const };

const yes = <T>(data: T): Answer<T> => ({ ok: true, data });
const no = (status: number, error = 'unavailable'): Answer<never> => ({ ok: false, status, error });

type Worker = {
  signedIn?: boolean;
  workspaces?: Workspace[];
  invitations?: Answer<never> | number;
  sites?: Answer<never> | number;
  creates?: Answer<never>;
};

/** A worker of fakes, and the list of what the setup asked of it. */
function fake(worker: Worker): { calls: SetupCalls; asked: string[] } {
  const asked: string[] = [];
  let workspaces = worker.workspaces ?? [];
  const calls: SetupCalls = {
    me: async () => {
      asked.push('me');

      return worker.signedIn === false ? no(401, 'identity-required') : yes({ account, workspaces });
    },
    invitations: async () => {
      asked.push('invitations');
      const answer = worker.invitations ?? 0;

      return typeof answer === 'number' ? yes(Array.from({ length: answer }, () => ({}) as never)) : answer;
    },
    sites: async () => {
      asked.push('sites');
      const answer = worker.sites ?? 0;

      return typeof answer === 'number' ? yes({ sites: answer === 0 ? [] : [site] }) : answer;
    },
    site: async () => {
      asked.push('site');
      const answer = worker.sites ?? 0;
      if (typeof answer !== 'number') return answer;

      return answer === 0 ? no(404, 'not-found') : yes(site);
    },
    createWorkspace: async (name) => {
      asked.push(`create ${name}`);
      if (worker.creates !== undefined) return worker.creates;
      const made = { ...owner, name };
      workspaces = [made];

      return yes(made);
    },
    alone: (task) => {
      asked.push('lock');

      return task();
    },
  };

  return { calls, asked };
}

describe('where the setup takes a person (FRU-239)', () => {
  it('asks for an address when nobody is signed in, and asks nothing else', async () => {
    const { calls, asked } = fake({ signedIn: false });

    assert.deepEqual(await resolveStage(calls), { kind: 'email' });
    assert.deepEqual(asked, ['me']);
  });

  it('makes the first workspace under the lock, named after the domain, then asks for a site', async () => {
    const { calls, asked } = fake({});

    const stage = await resolveStage(calls);
    assert.equal(stage.kind, 'site');
    assert.deepEqual(asked, ['me', 'invitations', 'lock', 'me', 'create Acme', 'sites']);
  });

  it('makes no workspace for somebody an invitation waits for', async () => {
    const { calls, asked } = fake({ invitations: 1 });

    assert.deepEqual(await resolveStage(calls), { kind: 'invited' });
    assert.ok(!asked.some((each) => each.startsWith('create')));
  });

  it('makes no workspace while the invitations cannot be read', async () => {
    const { calls, asked } = fake({ invitations: no(503) });

    assert.deepEqual(await resolveStage(calls), { kind: 'unchecked', account });
    assert.ok(!asked.some((each) => each.startsWith('create')));
  });

  it('goes on when the worker has no invitations at all (404)', async () => {
    const { calls, asked } = fake({ invitations: no(404, 'not-found') });

    assert.equal((await resolveStage(calls)).kind, 'site');
    assert.ok(asked.includes('create Acme'));
  });

  it('says what the worker answered when it did not make the workspace', async () => {
    const refused = await resolveStage(fake({ creates: no(400, 'invalid-name') }).calls);
    assert.deepEqual(refused, {
      kind: 'unnamed',
      account,
      problem: 'A workspace needs a name of one line, up to 80 characters.',
    });
    const silent = await resolveStage(fake({ creates: no(503) }).calls);
    assert.equal(silent.kind === 'unnamed' && silent.problem, 'Fruitback hit an error. Try again in a moment.');
  });

  it('finds the workspace a tab before it made, under the lock, and makes none', async () => {
    const { calls, asked } = fake({});
    // The other tab made it between the first reading and the lock: the reading under the lock finds it.
    const original = calls.me;
    calls.me = async () => {
      const answer = await original();

      return answer.ok && asked.includes('lock') ? yes({ ...answer.data, workspaces: [owner] }) : answer;
    };

    assert.deepEqual(await resolveStage(calls), { kind: 'site', account, workspace: owner });
    assert.ok(!asked.some((each) => each.startsWith('create')));
    // The control: with no other tab, the same calls make it.
    const alone = fake({});
    await firstWorkspace(alone.calls, account);
    assert.ok(alone.asked.includes('create Acme'));
  });

  it('takes the name the person typed, when they type one', async () => {
    const { calls, asked } = fake({});

    await firstWorkspace(calls, account, 'Acme Studio');
    assert.ok(asked.includes('create Acme Studio'));
  });

  it('resumes at the last step when the workspace has a site', async () => {
    const stage = await resolveStage(fake({ workspaces: [owner], sites: 1 }).calls);

    assert.deepEqual(stage, { kind: 'install', account, workspace: owner, site });
  });

  it('says « unread » when the sites cannot be read, and never « no site »', async () => {
    const stage = await siteStage(fake({ sites: no(503) }).calls, account, owner);

    assert.deepEqual(stage, { kind: 'unread', account, workspace: owner });
  });

  it('sends a member of a workspace with no site to its Sites screen, and an invited person to theirs', async () => {
    const stage = await siteStage(fake({}).calls, account, member);

    assert.deepEqual(stage, { kind: 'waiting', workspace: member });
    assert.equal(leaveFor(stage), '/w/w1/sites');
    assert.equal(leaveFor({ kind: 'invited' }), '/invitations');
    // The control: the owner of the same workspace stays, at the form.
    assert.equal(leaveFor(await siteStage(fake({}).calls, account, owner)), undefined);
  });

  it('sees a first note by a count of the index, or by the day of a last note, and not on a worker of before', () => {
    const none = { new: 0, todo: 0, progress: 0, done: 0, closed: 0 };
    assert.equal(noted(site), false);
    assert.equal(noted({ ...site, notes: none }), false);
    assert.equal(noted({ ...site, notes: { ...none, done: 1 } }), true);
    assert.equal(noted({ ...site, lastNoteAt: '2026-10-14T08:00:00.000Z' }), true);
  });

  it('reads the same site again by its id, and nothing when it was not read or is gone', async () => {
    assert.deepEqual(await siteNow(fake({ sites: 1 }).calls, owner, site), site);
    assert.equal(await siteNow(fake({ sites: 0 }).calls, owner, site), undefined);
    assert.equal(await siteNow(fake({ sites: no(503) }).calls, owner, site), undefined);
  });
});
