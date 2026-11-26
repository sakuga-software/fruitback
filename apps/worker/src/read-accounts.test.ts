import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DEV_PLAYGROUND, DEV_SITE, devEnvironment, seedDevWorkspace } from './dev-worker.fixture.ts';
import { databaseOn, newPglite } from './pglite.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { closeDatabases, provideDevDatabase } from './postgres.ts';
import { createFruitbackServer } from './server.ts';

/**
 * The read of a page through the server of production (FRU-730): `createFruitbackServer`, as `server.ts`
 * serves it, which hands `handleRequest` no store of the accounts. `app.ts` resolves them apart, and
 * the read must get them: the statuses a team added to its site (FRU-366) come from there.
 *
 * Every other suite of the read hands `accounts` to the context by hand (`console-world.fixture.ts`),
 * which is how the read lost them in production with every suite green.
 */

const PAGE = `${DEV_PLAYGROUND}/pricing`;
const servers: { close(): void }[] = [];

afterAll(async () => {
  for (const server of servers) server.close();
  await closeDatabases();
});

describe('the read of a page, through the server of production (FRU-730)', () => {
  it('gives the statuses the team added to the site, which the store of the accounts keeps', async () => {
    const database = await databaseOn(newPglite());
    await migrate(database);
    provideDevDatabase(database);
    const { workspace } = await seedDevWorkspace(database, { origin: DEV_PLAYGROUND, visibility: 'everyone' });
    await createPostgresAccountStore(database).putSiteStatus(workspace, DEV_SITE, {
      source: 'own',
      key: 'waiting',
      stage: 'todo' as never,
      name: 'Waiting',
      color: '#2563eb',
      textColor: null,
      position: 0,
      origin: 'team',
      hidden: false,
    });
    const server = createFruitbackServer(devEnvironment({ FRUITBACK_STORE: 'postgres' }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const read = await fetch(`http://127.0.0.1:${port}/feedback?url=${encodeURIComponent(PAGE)}&client=${DEV_SITE}`, {
      headers: { Origin: DEV_PLAYGROUND },
    });

    assert.equal(read.status, 200, await read.clone().text());
    const { statuses } = (await read.json()) as { statuses: { key: string; name: string; color?: string }[] };
    assert.deepEqual(
      statuses.find((status) => status.key === 'own:waiting'),
      { key: 'own:waiting', name: 'Waiting', stage: 'todo', color: '#2563eb', textColor: '#ffffff' },
      JSON.stringify(statuses),
    );
  });
});
