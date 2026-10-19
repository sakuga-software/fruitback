import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED_STAGE } from '@fruitback/shared';
import { createLinearStore, linearRoutingFor, reopenStateOf, stageForLinearState } from './linear.ts';
import { installLinearStub } from './linear-stub.ts';

/**
 * These tests moved here from `packages/shared` with the code they cover (FRU-23). The contract
 * package names the stages; this connector is what knows how Linear's own workflow reaches them.
 */

describe('stageForLinearState', () => {
  it('ripens the pin along the Linear workflow', () => {
    assert.equal(stageForLinearState('backlog'), 'seeded');
    assert.equal(stageForLinearState('triage'), 'seeded');
    assert.equal(stageForLinearState('unstarted'), 'green');
    assert.equal(stageForLinearState('started'), 'ripening');
    assert.equal(stageForLinearState('completed'), 'ripe');
    assert.equal(stageForLinearState('canceled'), 'composted');
    // The SKG team has a "Duplicate" state; a duplicated pin must not read as freshly seeded.
    assert.equal(stageForLinearState('duplicate'), 'composted');
  });

  it('draws an unrecognised state instead of hiding it, at the contract’s default', () => {
    // Both inputs happen: Linear can answer with a state type this connector has never seen, and
    // `toSeedIssue` passes '' for an issue that came back with no state at all.
    assert.equal(stageForLinearState('someCustomType'), DEFAULT_SEED_STAGE);
    assert.equal(stageForLinearState(''), DEFAULT_SEED_STAGE);

    // Asserted against the constant, not against `'seeded'`: every connector answers the same way
    // for a state it does not know, so the rule is the contract's and a connector spelling the
    // literal itself is how the next one comes to disagree. Which stage that is stays pinned in
    // `packages/shared/src/linear.test.ts`, where the constant is declared.
  });
});

describe('linearRoutingFor', () => {
  const config = { apiKey: 'lin_api_test', teamId: 'team_worker', projectId: 'project_worker' };

  it('sends a client with no team of its own to the worker’s', () => {
    // This fallback used to live in `resolveClient`, which meant the worker's client resolution knew
    // that a store routes by team (FRU-29). Falling back to *the worker's team* is a rule about
    // teams, so it belongs to the file that knows what a team is.
    assert.deepEqual(linearRoutingFor(config, undefined), { teamId: 'team_worker', projectId: 'project_worker' });
    assert.deepEqual(linearRoutingFor(config, {}), { teamId: 'team_worker', projectId: 'project_worker' });
  });

  it('falls back per field, so a client can have its own team and share the project', () => {
    assert.deepEqual(linearRoutingFor(config, { teamId: 'team_acme' }), {
      teamId: 'team_acme',
      projectId: 'project_worker',
    });
  });

  it('lets a client override both', () => {
    assert.deepEqual(linearRoutingFor(config, { teamId: 'team_acme', projectId: 'project_acme' }), {
      teamId: 'team_acme',
      projectId: 'project_acme',
    });
  });
});

describe('the Linear store', () => {
  it('scopes the read cache by team, which is what separates tenants here', () => {
    // The worker asks the store what distinguishes one tenant's answers from another's, instead of
    // reaching for `teamId` itself. For the in-memory store the answer is a constant.
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_worker', projectId: undefined });

    assert.equal(store.name, 'linear');
    assert.equal(store.scope(undefined), 'team_worker');
    assert.equal(store.scope({ teamId: 'team_acme' }), 'team_acme');
  });
});

describe('« Still wrong » in Linear (FRU-294)', () => {
  afterEach(() => mock.restoreAll());

  const state = (id: string, type: string, position: number) => ({ id, name: id, type, position });
  const CHECKER = { kind: 'member' as const, name: 'Bob', workspace: 'Acme' };

  it('picks triage, else backlog, else unstarted, the first of the board of that type', () => {
    const triage = [state('Done', 'completed', 0), state('Triage', 'triage', 3), state('Backlog', 'backlog', 1)];
    const noTriage = [state('Later', 'backlog', 2), state('Backlog', 'backlog', 1), state('Todo', 'unstarted', 0)];
    const onlyTodo = [state('Todo', 'unstarted', 4), state('Doing', 'started', 1)];

    assert.equal(reopenStateOf(triage)?.id, 'Triage');
    assert.equal(reopenStateOf(noTriage)?.id, 'Backlog');
    assert.equal(reopenStateOf(onlyTodo)?.id, 'Todo');
    assert.equal(reopenStateOf([state('Done', 'completed', 0)]), undefined);
  });

  it('moves the issue of a team with no triage to its backlog, then writes the marked reply', async () => {
    const stub = installLinearStub({
      teamStates: [
        state('st_done', 'completed', 3),
        state('st_todo', 'unstarted', 1),
        state('st_backlog', 'backlog', 0),
      ],
    });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    const answer = await store.check?.(
      { issue: 'issue_1', clientId: 'acme' },
      { verdict: 'wrong', author: CHECKER },
      undefined,
      { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' },
    );

    assert.deepEqual(
      stub.calls.map((call) => call.operation),
      ['FruitbackIssueStates', 'FruitbackReopenIssue', 'FruitbackCreateComment'],
    );
    assert.deepEqual(stub.calls[1]?.variables, { id: 'issue_1', input: { stateId: 'st_backlog' } });
    assert.equal(answer?.stage, 'seeded');
    assert.equal(answer?.comment.body, '**Bob** via Fruitback · member of Acme\nReopened: still wrong');
  });

  it('« Looks fixed » writes the reply and moves nothing', async () => {
    const stub = installLinearStub({ teamStates: [state('st_backlog', 'backlog', 0)] });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    const answer = await store.check?.(
      { issue: 'issue_1', clientId: 'acme' },
      { verdict: 'fixed', author: CHECKER },
      undefined,
      { showComments: true, identitySecret: undefined, read: 'public', locale: 'fr' },
    );

    assert.deepEqual(
      stub.calls.map((call) => call.operation),
      ['FruitbackCreateComment'],
    );
    assert.equal(answer?.stage, 'ripe');
    assert.equal(answer?.comment.body, '**Bob** via Fruitback · membre de Acme\nVérifié : semble corrigé');
  });

  it('writes no reply when the team has no state to reopen the issue in', async () => {
    const stub = installLinearStub({ teamStates: [state('st_done', 'completed', 0)] });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    await assert.rejects(
      store.check?.({ issue: 'issue_1', clientId: 'acme' }, { verdict: 'wrong', author: CHECKER }, undefined, {
        showComments: true,
        identitySecret: undefined,
        read: 'public',
        locale: 'en',
      }) ?? Promise.resolve(),
    );
    assert.equal(
      stub.calls.some((call) => call.operation === 'FruitbackCreateComment'),
      false,
    );
  });
});
