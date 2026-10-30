import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { listLinearTeams } from './linear.ts';

/**
 * The teams and the projects a key reaches, as the console offers them for a destination (FRU-458):
 * every page of each, and where each project stands.
 */

type Asked = { operation: string; variables: Record<string, unknown> };

/** Linear, answering each operation with what `answer` gives, and keeping what was asked. */
function linear(answer: (asked: Asked) => unknown): Asked[] {
  const asked: Asked[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const one = { operation: /Fruitback\w+/.exec(query)?.[0] ?? '', variables };
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
          viewer: { name: 'Camille' },
          organization: { name: 'Acme' },
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

    assert.equal(read.viewer, 'Camille');
    assert.equal(read.organization, 'Acme');
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
      viewer: { name: 'Camille' },
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

  it('asks Linear for at most 50 teams with 20 projects each, under the limit of complexity of Linear', async () => {
    let query = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      query = (JSON.parse(String(init?.body)) as { query: string }).query;

      return Response.json({ data: { teams: { nodes: [], pageInfo: page() } } });
    });
    await listLinearTeams('lin_api_x');
    assert.match(query, /teams\(first: 50\b/);
    assert.match(query, /projects\(first: 20\)/);
  });
});
