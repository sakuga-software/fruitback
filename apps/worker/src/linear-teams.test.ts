import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { listLinearStates, listLinearTeams, readLinearPlaces, readLinearTeams, readLinearViewer } from './linear.ts';

/**
 * The teams and the projects a key reaches, as the console offers them for a destination (FRU-458):
 * every page of each, and where each project stands.
 */

type Asked = { operation: string; variables: Record<string, unknown>; query: string; timed: boolean };

/** Linear, answering each operation with what `answer` gives, and keeping what was asked. */
function linear(answer: (asked: Asked) => unknown): Asked[] {
  const asked: Asked[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const one = {
      operation: /Fruitback\w+/.exec(query)?.[0] ?? '',
      variables,
      query,
      timed: init?.signal instanceof AbortSignal,
    };
    asked.push(one);

    return Response.json({ data: answer(one) });
  });

  return asked;
}

const project = (id: string, status?: { name: string; type: string } | null) => ({ id, name: `Project ${id}`, status });
const page = (next?: string) => ({ hasNextPage: next !== undefined, endCursor: next ?? null });

describe('listLinearTeams (FRU-458, FRU-459)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads every page of teams and of projects, with the status of each project and whether a team is private', async () => {
    const asked = linear(({ operation, variables }) => {
      if (operation === 'FruitbackTeams' && variables.after === undefined) {
        return {
          teams: {
            nodes: [
              {
                id: 'team_a',
                name: 'Design',
                key: 'DES',
                private: true,
                color: '#5E6AD2',
                projects: {
                  nodes: [{ ...project('p1', { name: 'In Progress', type: 'started' }), color: '#BEC2C8' }],
                  pageInfo: page('c-p1'),
                },
              },
            ],
            pageInfo: page('c-team'),
          },
        };
      }
      if (operation === 'FruitbackTeams' && variables.after === 'c-team') {
        return {
          teams: {
            nodes: [
              // A colour that is not `#rrggbb` would reach a style: it is dropped (FRU-459).
              {
                id: 'team_b',
                name: 'Web',
                key: 'WEB',
                private: false,
                color: 'red; background: url(x)',
                projects: { nodes: [], pageInfo: page() },
              },
            ],
            pageInfo: page(),
          },
        };
      }
      if (operation === 'FruitbackTeamProjects' && variables.after === 'c-p1') {
        return { team: { projects: { nodes: [project('p2', null)], pageInfo: page('c-p2') } } };
      }
      if (operation === 'FruitbackTeamProjects' && variables.after === 'c-p2') {
        return {
          team: { projects: { nodes: [project('p3', { name: 'Done', type: 'completed' })], pageInfo: page() } },
        };
      }

      return undefined;
    });

    const read = await listLinearTeams('lin_api_key');

    assert.deepEqual(read.teams, [
      {
        id: 'team_a',
        name: 'Design',
        key: 'DES',
        private: true,
        color: '#5e6ad2',
        projects: [
          { id: 'p1', name: 'Project p1', status: { name: 'In Progress', type: 'started' }, color: '#bec2c8' },
          // Linear said no status: the project is offered all the same.
          { id: 'p2', name: 'Project p2' },
          { id: 'p3', name: 'Project p3', status: { name: 'Done', type: 'completed' } },
        ],
      },
      { id: 'team_b', name: 'Web', key: 'WEB', private: false, projects: [] },
    ]);
    // The projects that are left are asked of their own team.
    assert.deepEqual(
      asked.filter((one) => one.operation === 'FruitbackTeamProjects').map((one) => one.variables.team),
      ['team_a', 'team_a'],
    );
  });

  it('reads one page when Linear says nothing of the next one, as an answer of before did', async () => {
    const asked = linear(() => ({
      teams: {
        nodes: [{ id: 'team_a', name: 'Design', key: 'DES', projects: { nodes: [{ id: 'p1', name: 'Site' }] } }],
      },
    }));

    const read = await listLinearTeams('lin_api_key');

    assert.deepEqual(read.teams, [
      { id: 'team_a', name: 'Design', key: 'DES', projects: [{ id: 'p1', name: 'Site' }] },
    ]);
    assert.equal(asked.length, 1);
  });

  it('stops after 20 pages of a list that says it never ends', async () => {
    let call = 0;
    const asked = linear(() => {
      call += 1;

      return { teams: { nodes: [], pageInfo: page(`c${call}`) } };
    });

    await listLinearTeams('lin_api_key');

    assert.equal(asked.length, 20);
  });
});

describe('the reads of Linear for one choice (FRU-501)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a page of the teams whose name holds a search, with the cursor of the next page', async () => {
    const asked = linear(() => ({
      teams: {
        nodes: [{ id: 'team_p', name: 'Payments', key: 'PAY', projects: { nodes: [], pageInfo: page() } }],
        pageInfo: page('c-next'),
      },
    }));

    const found = await readLinearTeams('lin_api_key', { search: 'pay', after: 'c-before' });
    const first = await readLinearTeams('lin_api_key');

    assert.deepEqual(found, { teams: [{ id: 'team_p', name: 'Payments', key: 'PAY', projects: [] }], next: 'c-next' });
    assert.deepEqual(asked[0]?.variables, { after: 'c-before', filter: { name: { containsIgnoreCase: 'pay' } } });
    // With no search, no filter: Linear answers every team.
    assert.deepEqual(asked[1]?.variables, {});
    assert.equal(first.next, 'c-next');
    assert.equal(asked.length, 2);
  });

  it('names the places of a site in one call, by their ids, and none that the key does not reach', async () => {
    const asked = linear(() => ({
      teams: {
        nodes: [
          { id: 'team_a', name: 'Design', projects: { nodes: [{ id: 'p1', name: 'Site' }] } },
          { id: 'team_b', name: 'Web', projects: { nodes: [] } },
        ],
      },
    }));

    const named = await readLinearPlaces('lin_api_key', [
      { teamId: 'team_a', projectId: 'p1' },
      { teamId: 'team_b' },
      { teamId: 'team_b', projectId: 'p1' },
      { teamId: 'team_gone' },
    ]);

    assert.deepEqual(named, [{ team: 'Design', project: 'Site' }, { team: 'Web' }, undefined, undefined]);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.operation, 'FruitbackPlaces');
    assert.deepEqual(asked[0]?.variables, { teams: ['team_a', 'team_b', 'team_gone'], projects: ['p1'] });
    assert.ok(!asked[0]?.query.includes('teams(first: 50, after'), 'never the list of the teams');
  });

  it('asks for no project of places that name none', async () => {
    const asked = linear(() => ({ teams: { nodes: [{ id: 'team_a', name: 'Design' }] } }));

    assert.deepEqual(await readLinearPlaces('lin_api_key', [{ teamId: 'team_a' }]), [{ team: 'Design' }]);
    assert.deepEqual(asked[0]?.variables, { teams: ['team_a'] });
    assert.ok(!asked[0]?.query.includes('projects'));
  });

  it('reads who a key belongs to, and nothing of its teams', async () => {
    const asked = linear(() => ({ viewer: { name: 'Camille' }, organization: { name: 'Acme' } }));

    assert.deepEqual(await readLinearViewer('lin_api_key'), { viewer: 'Camille', organization: 'Acme' });
    assert.equal(asked[0]?.operation, 'FruitbackViewer');
    assert.ok(!asked[0]?.query.includes('teams'));
  });

  it('reads every page of the states past 250, in the order of each board', async () => {
    const state = (team: string, position: number) => ({
      id: `${team}_${position}`,
      name: `S${position}`,
      type: 'started',
      position,
      team: { id: team, name: team },
    });
    const asked = linear(({ variables }) =>
      variables.after === undefined
        ? { workflowStates: { nodes: [state('t1', 1), state('t2', 0)], pageInfo: page('c-s') } }
        : { workflowStates: { nodes: [state('t1', 0)], pageInfo: page() } },
    );

    const states = await listLinearStates('lin_api_key', ['t1', 't2']);

    assert.deepEqual(
      states.map((each) => each.id),
      ['t1_0', 't1_1', 't2_0'],
    );
    assert.deepEqual(
      asked.map((one) => one.variables.after),
      [undefined, 'c-s'],
    );
  });

  it('gives up on each read of the console that Linear does not answer in time', async () => {
    const asked = linear(() => ({ viewer: { name: 'Camille' }, organization: { name: 'Acme' }, teams: { nodes: [] } }));

    await readLinearViewer('lin_api_key');
    await readLinearTeams('lin_api_key');
    await readLinearPlaces('lin_api_key', [{ teamId: 'team_a' }]);
    await listLinearStates('lin_api_key', ['team_a']);

    assert.deepEqual(
      asked.map((one) => one.timed),
      [true, true, true, true],
    );
  });
});
