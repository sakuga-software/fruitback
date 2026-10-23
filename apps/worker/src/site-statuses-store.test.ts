import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { MAX_STATUSES, SEED_STAGES } from '@fruitback/shared';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import type { SiteStatus } from './site-statuses.ts';

/**
 * The statuses of a site in the store of the accounts (FRU-366), on PGlite and on a real server: the
 * bound, the order that rolls back, the notes that move, and a site of another workspace.
 */

const { opening } = databasesOfACase();
const [NEW, , , DONE, CLOSED] = SEED_STAGES as unknown as SiteStatus['stage'][];

const status = (key: string, more: Partial<SiteStatus> = {}): SiteStatus => ({
  source: 'own',
  key,
  name: null,
  stage: NEW as SiteStatus['stage'],
  color: null,
  textColor: null,
  position: 0,
  origin: 'team',
  hidden: false,
  ...more,
});

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the statuses of a site, in the store, on ${label} (FRU-366)`, { skip: skip !== false }, () => {
    async function acme() {
      const database = await opening(open);
      const store = createPostgresAccountStore(database);
      const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
      const workspace = (await store.createWorkspace('Acme', alice.id)).id;
      const other = (await store.createWorkspace('Globex', alice.id)).id;
      const site = (await store.addSite(workspace, { origin: 'https://acme.test', visibility: 'members' })).id;

      return { database, store, workspace, other, site };
    }

    it('keeps a status once, changes it in place, and keeps the origin it was added with', async () => {
      const { store, workspace, site } = await acme();

      assert.deepEqual(await store.siteStatuses(workspace, site), []);
      assert.deepEqual(await store.putSiteStatus(workspace, site, status('waiting', { name: 'Waiting' })), {
        saved: true,
        pages: [],
      });
      assert.deepEqual(
        await store.putSiteStatus(
          workspace,
          site,
          status('waiting', { name: 'Waiting for Acme', origin: 'tracker', hidden: true }),
        ),
        { saved: true, pages: [] },
      );

      assert.deepEqual(await store.siteStatuses(workspace, site), [
        status('waiting', { name: 'Waiting for Acme', hidden: true }),
      ]);
    });

    it('answers a site of another workspace as none, and writes nothing there', async () => {
      const { database, store, workspace, other, site } = await acme();

      assert.equal(await store.siteStatuses(other, site), undefined);
      assert.equal(await store.siteStatusNotes(other, site), undefined);
      assert.deepEqual(await store.siteStatusNotes(workspace, site), {}, 'the control: its own workspace reads it');
      assert.deepEqual(await store.putSiteStatus(other, site, status('waiting')), {
        saved: false,
        reason: 'not-found',
      });
      assert.equal(await store.orderSiteStatuses(other, site, []), 'not-found');
      assert.deepEqual(await store.removeSiteStatus(other, site, { source: 'own', key: 'waiting' }, undefined), {
        removed: false,
        reason: 'not-found',
      });
      assert.deepEqual(await rowsOf(database, 'SELECT * FROM statuses'), []);
    });

    it(`keeps ${MAX_STATUSES} statuses for a site, and changes one of them past that`, async () => {
      const { database, store, workspace, site } = await acme();
      const values = Array.from({ length: MAX_STATUSES }, (_, index) => `('${site}', 'own', 'k${index}', '${NEW}')`);
      await rowsOf(database, `INSERT INTO statuses (site_id, source, key, stage) VALUES ${values.join(', ')}`);

      assert.deepEqual(await store.putSiteStatus(workspace, site, status('one-more')), {
        saved: false,
        reason: 'too-many',
      });
      assert.deepEqual(await store.putSiteStatus(workspace, site, status('k0', { name: 'Renamed' })), {
        saved: true,
        pages: [],
      });
    });

    it('orders the statuses it names, and changes nothing when one is unknown', async () => {
      const { store, workspace, site } = await acme();
      await store.putSiteStatus(workspace, site, status('a', { position: 7 }));
      await store.putSiteStatus(workspace, site, status('b', { position: 8 }));

      assert.equal(
        await store.orderSiteStatuses(workspace, site, [
          { source: 'own', key: 'b' },
          { source: 'own', key: 'gone' },
        ]),
        'unknown-status',
      );
      assert.deepEqual(
        (await store.siteStatuses(workspace, site))?.map((one) => [one.key, one.position]),
        [
          ['a', 7],
          ['b', 8],
        ],
      );

      assert.equal(
        await store.orderSiteStatuses(workspace, site, [
          { source: 'own', key: 'b' },
          { source: 'own', key: 'a' },
        ]),
        'saved',
      );
      assert.deepEqual(
        (await store.siteStatuses(workspace, site))?.map((one) => [one.key, one.position]),
        [
          ['b', 0],
          ['a', 1],
        ],
      );
    });

    it('moves the notes of a status before it goes, and only those of its site', async () => {
      const { database, store, workspace, site } = await acme();
      const elsewhere = (await store.addSite(workspace, { origin: 'https://two.test', visibility: 'members' })).id;
      await store.putSiteStatus(workspace, site, status('waiting'));
      await store.putSiteStatus(workspace, site, status('parked', { stage: CLOSED as SiteStatus['stage'] }));
      await rowsOf(
        database,
        `INSERT INTO seeds (client_id, page_url, stage, status_key, seed, created_at, updated_at) VALUES
           ('${site}', 'https://acme.test/', '${NEW}', 'waiting', '{}', 1, 1),
           ('${elsewhere}', 'https://two.test/', '${NEW}', 'waiting', '{}', 1, 1)`,
      );

      assert.deepEqual(await store.removeSiteStatus(workspace, site, { source: 'own', key: 'waiting' }, undefined), {
        removed: false,
        reason: 'in-use',
        notes: 1,
      });
      assert.deepEqual(await store.removeSiteStatus(workspace, site, { source: 'own', key: 'waiting' }, 'waiting'), {
        removed: false,
        reason: 'invalid-target',
      });
      // The page of the note it moved, whose cached reads are now wrong.
      assert.deepEqual(await store.removeSiteStatus(workspace, site, { source: 'own', key: 'waiting' }, 'parked'), {
        removed: true,
        moved: 1,
        pages: ['https://acme.test/'],
      });

      assert.deepEqual(await rowsOf(database, 'SELECT client_id, stage, status_key FROM seeds ORDER BY id'), [
        { client_id: site, stage: CLOSED, status_key: 'parked' },
        // A note of another site keeps its status, whatever its key.
        { client_id: elsewhere, stage: NEW, status_key: 'waiting' },
      ]);
    });

    it('removes the row of a state of a tracker or of a built-in status, which holds no note of its own', async () => {
      const { store, workspace, site } = await acme();
      await store.putSiteStatus(
        workspace,
        site,
        status(DONE as string, { stage: DONE, name: 'Shipped', origin: 'tracker' }),
      );
      await store.putSiteStatus(workspace, site, status('st_1', { source: 'con_linear', origin: 'tracker' }));

      assert.deepEqual(
        await store.removeSiteStatus(workspace, site, { source: 'own', key: DONE as string }, undefined),
        {
          removed: true,
          moved: 0,
          pages: [],
        },
      );
      // Where its notes go means nothing for a state of a tracker: the request is refused.
      assert.deepEqual(
        await store.removeSiteStatus(workspace, site, { source: 'con_linear', key: 'st_1' }, 'waiting'),
        {
          removed: false,
          reason: 'invalid-target',
        },
      );
      assert.deepEqual(
        await store.removeSiteStatus(workspace, site, { source: 'con_linear', key: 'st_1' }, undefined),
        {
          removed: true,
          moved: 0,
          pages: [],
        },
      );
      assert.deepEqual(await store.siteStatuses(workspace, site), []);
    });
  });
}
