import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { accountCases } from './account-conformance.fixture.ts';
import type { AccountStore, Site } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import type { ClientMap } from './clients.ts';
import {
  type Subject,
  type Violation,
  describeConformance,
  describeControls,
  factoriesOf,
  mutatedModule,
  turn,
} from './conformance.fixture.ts';
import type { Database } from './postgres.ts';
import { NO_REAL_POSTGRES, createMigratedPgliteDatabase, createRealDatabase, onDatabase } from './postgres.fixture.ts';

/**
 * Each `AccountStore` against the conformance suite (FRU-140). A new implementation adds a subject
 * here: the last test of this file fails until it does.
 */

const PGLITE = onDatabase(
  'the PostgreSQL account store, on PGlite',
  'createPostgresAccountStore',
  createMigratedPgliteDatabase,
  createPostgresAccountStore,
);

const SUBJECTS: Subject<AccountStore>[] = [
  PGLITE,
  // The same store on a server, where the calls of a case run on several connections.
  onDatabase(
    'the PostgreSQL account store, on a real server',
    'createPostgresAccountStore',
    createRealDatabase,
    createPostgresAccountStore,
    NO_REAL_POSTGRES,
  ),
];

for (const subject of SUBJECTS) describeConformance('AccountStore', accountCases, subject);

/** One change to `accounts-postgres.ts`, or one store around it, for each case: the case must fail. */
const VIOLATIONS: Violation<AccountStore>[] = [
  {
    breaks: 'makes one account of two providers that prove the same address',
    by: 'makes an account for each provider',
    wrap: (real) => ({
      ...real,
      signIn: (login) => real.signIn({ ...login, email: `${login.provider}.${login.email}` }),
    }),
  },
  {
    breaks: 'makes one account of two providers that prove the same address',
    by: 'does not keep a name that the first sign-in did not have',
    replace: { from: "if (given !== '') {", to: 'if (false) {' },
  },
  {
    breaks: 'keeps two addresses apart',
    by: 'gives every sign-in the same address',
    wrap: (real) => ({ ...real, signIn: (login) => real.signIn({ ...login, email: 'one@acme.dev' }) }),
  },
  {
    breaks: 'makes one account of two sign-ins of one address at the same moment',
    by: 'looks for the address, waits, then makes an account that another call made in that time',
    wrap: (real) => {
      const inFlight = new Set<string>();

      return {
        ...real,
        async signIn(login) {
          // What a read followed by a write does on a store that waits: the second call read
          // before the first one wrote, so it makes its own account.
          const raced = inFlight.has(login.email);
          inFlight.add(login.email);
          try {
            await turn();

            return await real.signIn(raced ? { ...login, email: `raced.${login.email}` } : login);
          } finally {
            inFlight.delete(login.email);
          }
        },
      };
    },
  },
  {
    breaks: 'refuses a sign-in whose address is not an address',
    by: 'takes any text as an address',
    replace: {
      after: 'async signIn(',
      from: "const address = normalizeEmail(email);\n      if (address === undefined) throw new StoreError('A sign-in needs a valid address');",
      to: 'const address = normalizeEmail(email) ?? email;',
    },
  },
  {
    breaks: 'answers the account of an id, and nothing for an id nobody has',
    by: 'answers the first account for every id',
    replace: { after: 'async account(id)', from: 'eq(user.id, id)', to: 'sql`true`' },
  },
  {
    breaks: 'keeps the language of the first sign-in until the person chooses another',
    by: 'takes the language of every sign-in',
    replace: {
      from: ".where(and(eq(user.id, id), or(isNull(user.locale), eq(user.locale, ''))));",
      to: '.where(eq(user.id, id));',
    },
  },
  {
    breaks: 'keeps the name a person chose, and a later sign-in does not write over it (FRU-249)',
    by: 'takes the name of every sign-in',
    replace: { from: ".where(and(eq(user.id, id), eq(user.name, '')));", to: '.where(eq(user.id, id));' },
  },
  {
    breaks: 'keeps the day a member was last seen in a workspace, the later one, and for a member only (FRU-249)',
    by: 'writes an earlier day over a later one',
    replace: { from: 'setWhere: lt(last_seen.day, day),', to: '' },
  },
  {
    breaks: 'keeps the day a member was last seen in a workspace, the later one, and for a member only (FRU-249)',
    by: 'answers the days of every workspace',
    replace: { after: 'async lastSeen(', from: '.where(eq(member.organizationId, workspace))', to: '' },
  },
  {
    breaks: 'gives each thing an id whose prefix says what it names',
    by: 'names a site with another prefix',
    replace: { from: "newId('site')", to: "newId('s')" },
  },
  {
    breaks: 'makes the creator the owner, and gives nobody else a role',
    by: 'makes the creator an admin',
    replace: { from: "role: 'owner', createdAt: now", to: "role: 'admin', createdAt: now" },
  },
  {
    breaks:
      'names the owners of the instance by their address, each once, and nobody before the first workspace (FRU-221)',
    by: 'names an owner once for each workspace they own',
    replace: { from: '.selectDistinct({ email: user.email })', to: '.select({ email: user.email })' },
  },
  {
    breaks: 'lists the workspaces of an account oldest first',
    by: 'lists them newest first',
    replace: {
      from: '.orderBy(member.createdAt, organization.id)',
      to: '.orderBy(desc(member.createdAt), organization.id)',
    },
  },
  {
    breaks:
      'removes the members, the sites, the connectors and the deliveries of a workspace it deletes, and only those',
    by: 'removes the row of the workspace alone',
    replace: {
      from: 'await db.delete(organization).where(eq(organization.id, workspace));',
      to: 'await db.execute(sql`SET LOCAL session_replication_role = replica`); await db.delete(organization).where(eq(organization.id, workspace));',
    },
  },
  {
    breaks: 'adds a site once, whatever was pasted twice, and serves it as a client of its workspace',
    by: 'keeps the visibility of the first time',
    replace: { from: 'visibility: sql`excluded.visibility`,', to: 'visibility: sites.visibility,' },
  },
  {
    breaks: 'makes a new site « Members only » when nobody chose, and keeps who writes on a site added again (FRU-330)',
    by: 'opens a new site to anyone',
    replace: { from: 'writers: writers ?? DEFAULT_WRITERS,', to: "writers: writers ?? 'anyone'," },
  },
  {
    breaks: 'makes a new site « Members only » when nobody chose, and keeps who writes on a site added again (FRU-330)',
    by: 'closes a site again when a caller names no `writers`',
    replace: {
      from: '...(writers === undefined ? {} : { writers }),',
      to: 'writers: writers ?? DEFAULT_WRITERS,',
    },
  },
  {
    breaks: 'makes a new site « Members only » when nobody chose, and keeps who writes on a site added again (FRU-330)',
    by: 'never changes who writes on a site that exists',
    replace: {
      from: '...(writers === undefined ? {} : { writers }),',
      to: '',
    },
  },
  {
    breaks: 'keeps one address apart in two workspaces',
    by: 'finds the site of another workspace by its address',
    wrap: (real) => {
      const byOrigin = new Map<string, Site>();

      return {
        ...real,
        async addSite(workspace, wanted) {
          const known = byOrigin.get(wanted.origin);
          if (known !== undefined) return { ...known, visibility: wanted.visibility };
          const site = await real.addSite(workspace, wanted);
          byOrigin.set(wanted.origin, site);

          return site;
        },
      };
    },
  },
  {
    breaks: 'lists the sites and the connectors of a workspace oldest first',
    by: 'lists the sites newest first',
    replace: {
      from: '.orderBy(sites.created_at, sites.id, site_destinations.position)',
      to: '.orderBy(desc(sites.created_at), sites.id, site_destinations.position)',
    },
  },
  {
    breaks: 'removes a site only from its own workspace',
    by: 'removes a site for any workspace',
    replace: {
      after: 'async removeSite(',
      from: '.where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))',
      to: '.where(eq(sites.id, site))',
    },
  },
  {
    breaks: 'answers an empty client map before a site exists, never no map',
    by: 'answers no map when it has no site',
    wrap: (real) => ({
      ...real,
      async clientMap() {
        const map = await real.clientMap();

        return Object.keys(map).length === 0 ? (undefined as unknown as ClientMap) : map;
      },
    }),
  },
  {
    breaks: 'keeps what a connector seals for the worker, and never lists it',
    by: 'keeps the first key when a new one is sealed',
    replace: {
      from: '.set({ sealed }).where(eq(connectors.id, connector))',
      to: ".set({ sealed }).where(eq(connectors.id, ''))",
    },
  },
  {
    breaks: 'keeps what a connector seals for the worker, and never lists it',
    by: 'lists what a connector seals',
    wrap: (real) => ({
      ...real,
      async connectors(workspace) {
        const listed = await real.connectors(workspace);

        return Promise.all(
          listed.map(async (connector) => ({ ...connector, sealed: (await real.sealedKey(connector.id))?.sealed })),
        );
      },
    }),
  },
  {
    breaks: 'keeps the settings of a connector, set from its own workspace only',
    by: 'sets the settings of a connector for any workspace',
    replace: {
      after: 'async setConnectorSettings(',
      from: 'eq(connectors.workspace_id, workspace), eq(connectors.id, connector)',
      to: 'sql`true`, eq(connectors.id, connector)',
    },
  },
  {
    breaks: 'keeps the settings of a connector, set from its own workspace only',
    by: 'keeps the switch and loses the exceptions',
    replace: {
      from: '.set({ settings: JSON.stringify(settings) })',
      to: '.set({ settings: JSON.stringify({ ...settings, stages: {} }) })',
    },
  },
  {
    breaks: 'removes a connector only from its own workspace, and its sites keep their notes in the worker again',
    by: 'removes a connector for any workspace',
    replace: {
      after: 'async removeConnector(',
      from: 'eq(connectors.workspace_id, workspace), eq(connectors.id, connector)',
      to: 'sql`true`, eq(connectors.id, connector)',
    },
  },
  {
    breaks: 'never lets a site write through the connector of another workspace',
    by: 'takes a connector of any workspace',
    replace: {
      after: 'async setDestinations(',
      from: '.where(and(eq(connectors.id, connector), eq(connectors.workspace_id, workspace)))',
      to: '.where(eq(connectors.id, connector))',
    },
  },
  {
    breaks: 'never lets a site write through the connector of another workspace',
    by: 'clears the destination of a site for any workspace',
    replace: {
      from: 'if (owned.length !== 1) return false;',
      to: 'if (destinations.length > 0 && owned.length !== 1) return false;',
    },
  },
  {
    breaks: 'keeps a destination with no team, for an address that only receives',
    by: 'gives a team to a destination that has none',
    replace: { from: 'team_id: destination.teamId ?? null,', to: "team_id: destination.teamId ?? 'team_default'," },
  },
  {
    breaks: 'keeps the destinations of a site in the order they were given, and the client map carries them',
    by: 'gives the places of a site last first',
    replace: {
      from: '.orderBy(sites.created_at, sites.id, site_destinations.position)',
      to: '.orderBy(sites.created_at, sites.id, desc(site_destinations.position))',
    },
  },
  {
    breaks: 'keeps the destinations of a site in the order they were given, and the client map carries them',
    by: 'forgets how a place is named',
    replace: { from: 'label: destination.label ?? null,', to: 'label: null,' },
  },
  {
    breaks: 'keeps the destinations of a site in the order they were given, and the client map carries them',
    by: 'answers a site that is added again with no place',
    replace: {
      from: 'const site = sitesFrom(rows)[0];',
      to: 'const site = sitesFrom(rows.map((row) => ({ ...row, connector_id: null })))[0];',
    },
  },
  {
    breaks: 'refuses a list of destinations in which one connector is of another workspace, and writes none of it',
    by: 'reads whose connector the first place has, and no other',
    replace: {
      from: 'new Set(destinations.map((destination) => destination.connector))',
      to: 'new Set(destinations.slice(0, 1).map((destination) => destination.connector))',
    },
  },
  {
    breaks: 'refuses a list of destinations in which one connector is of another workspace, and writes none of it',
    by: 'removes the places a site had when it refuses a list',
    replace: {
      from: 'if (ours.length !== 1) return false;',
      to: 'if (ours.length !== 1) { await tx.delete(site_destinations).where(eq(site_destinations.site_id, site)); return false; }',
    },
  },
  {
    breaks: 'clears the destinations of a site with an empty list, and a connector that is removed takes only its own',
    by: 'keeps the places of a site when the list is empty',
    replace: {
      from: 'await tx.delete(site_destinations).where(eq(site_destinations.site_id, site));',
      to: 'if (destinations.length > 0) await tx.delete(site_destinations).where(eq(site_destinations.site_id, site));',
    },
  },
  {
    breaks: 'clears the destinations of a site with an empty list, and a connector that is removed takes only its own',
    by: 'removes every place of a site with one of its connectors',
    wrap: (real) => ({
      ...real,
      async removeConnector(workspace, connector) {
        for (const site of await real.sites(workspace)) {
          if (site.destinations.some((destination) => destination.connector === connector)) {
            await real.setDestinations(workspace, site.id, []);
          }
        }

        return real.removeConnector(workspace, connector);
      },
    }),
  },
  {
    breaks: 'removes the destinations of a site with the site, and with its workspace, and only those',
    by: 'removes the places of every site of a workspace with one site',
    wrap: (real) => ({
      ...real,
      async removeSite(workspace, site) {
        for (const other of await real.sites(workspace)) await real.setDestinations(workspace, other.id, []);

        return real.removeSite(workspace, site);
      },
    }),
  },
  {
    breaks: 'removes the destinations of a site with the site, and with its workspace, and only those',
    by: 'removes the places of every site with a workspace',
    wrap: (real) => ({
      ...real,
      async deleteWorkspace(workspace) {
        for (const [site, client] of Object.entries(await real.clientMap())) {
          await real.setDestinations(client.workspace as string, site, []);
        }

        return real.deleteWorkspace(workspace);
      },
    }),
  },
  {
    breaks: 'keeps one whole list when two calls set the destinations of one site at the same moment',
    by: 'removes the places of a site, then adds the new ones one at a time, with a wait before each',
    // No transaction around the list: each place is added to what the site holds at that moment.
    wrap: (real) => ({
      ...real,
      async setDestinations(workspace, site, destinations) {
        if (!(await real.setDestinations(workspace, site, []))) return false;
        for (const destination of destinations) {
          await turn();
          const held = (await real.sites(workspace)).find(({ id }) => id === site)?.destinations ?? [];
          if (!(await real.setDestinations(workspace, site, [...held, destination]))) return false;
        }

        return true;
      },
    }),
  },
  {
    breaks: 'keeps the first moment of a refusal, and forgets it at the first call that works',
    by: 'writes the moment of every refusal',
    replace: { from: 'sql`${connectors.attention} IS DISTINCT FROM ${trouble ?? null}`', to: 'sql`true`' },
  },
  {
    breaks: 'gives the deliveries that are due, oldest first, up to the limit',
    by: 'gives the newest first',
    replace: {
      from: '.orderBy(deliveries.next_at, deliveries.created_at)',
      to: '.orderBy(desc(deliveries.next_at), deliveries.created_at)',
    },
  },
  {
    breaks: 'gives the deliveries that are due, oldest first, up to the limit',
    by: 'gives a delivery before it is due',
    replace: { from: 'lte(deliveries.next_at, now)', to: 'sql`true`' },
  },
  {
    breaks: 'removes a delivery that arrived, and no other',
    by: 'keeps a delivery that arrived',
    replace: {
      from: 'db.delete(deliveries).where(eq(deliveries.id, id))',
      to: "db.delete(deliveries).where(eq(deliveries.id, ''))",
    },
  },
  {
    breaks: 'writes what a failed attempt answered, and gives up when no other attempt is set',
    by: 'never gives up',
    replace: { from: 'next_at: outcome.nextAt ?? null,', to: 'next_at: outcome.nextAt ?? outcome.at,' },
  },
  {
    breaks: 'never writes a failure over a new attempt that somebody asked for',
    by: 'writes a failure whatever the count is',
    replace: { from: 'eq(deliveries.attempts, outcome.attempts)', to: 'sql`true`' },
  },
  {
    breaks: 'counts one failure when two attempts of one delivery answer at the same moment',
    by: 'writes a failure whatever the count is',
    replace: { from: 'eq(deliveries.attempts, outcome.attempts)', to: 'sql`true`' },
  },
  {
    breaks: 'starts the attempts again only for a delivery of this workspace and of this connector',
    by: 'starts them again for any workspace',
    replace: { after: 'async retryDelivery(', from: 'eq(connectors.workspace_id, workspace)', to: 'sql`true`' },
  },
  {
    breaks: 'starts the attempts again only for a delivery of this workspace and of this connector',
    by: 'keeps the count of the attempts before',
    replace: { from: '.set({ next_at: now, attempts: 0 })', to: '.set({ next_at: now })' },
  },
  {
    breaks: 'lists the deliveries of a connector newest first, without their body, to its workspace only',
    by: 'lists them oldest first',
    replace: {
      from: '.orderBy(desc(deliveries.created_at), deliveries.id)',
      to: '.orderBy(deliveries.created_at, deliveries.id)',
    },
  },
  {
    breaks: 'lists the deliveries of a connector newest first, without their body, to its workspace only',
    by: 'lists them to any workspace',
    replace: {
      after: 'async deliveries(workspace, connector)',
      from: 'eq(connectors.workspace_id, workspace), eq(connectors.id, connector)',
      to: 'sql`true`, eq(connectors.id, connector)',
    },
  },
  {
    breaks: 'drops the deliveries that were given up before a moment, and keeps the ones still to send',
    by: 'drops the deliveries still to send too',
    replace: { from: 'and(isNull(deliveries.next_at), sql`COALESCE', to: 'and(sql`true`, sql`COALESCE' },
  },
  {
    breaks: 'keeps a domain once for a workspace, apart from the same domain of another one',
    by: 'keeps the same domain twice',
    wrap: (real) => {
      // What a table with no unique key on the workspace and the domain answers: a new row each time.
      const seen = new Set<string>();

      return {
        ...real,
        async addDomain(workspace, domain, now) {
          const row = await real.addDomain(workspace, domain, now);
          const key = `${workspace}\n${domain}`;
          if (!seen.has(key)) {
            seen.add(key);

            return row;
          }

          return { ...row, id: `${row.id}_again`, createdAt: now };
        },
      };
    },
  },
  {
    breaks: 'removes a domain only from its own workspace',
    by: 'removes a domain whatever its workspace',
    replace: {
      after: 'async removeDomain(',
      from: 'eq(domains.workspace_id, workspace), eq(domains.id, domain)',
      to: 'sql`true`, eq(domains.id, domain)',
    },
  },
  {
    breaks: 'writes what the DNS said of a domain, and keeps the first moment of a loss',
    by: 'writes each loss over the one before',
    replace: { from: 'IS NOT NULL AND ${domains.lost_at} IS NULL THEN', to: 'IS NOT NULL THEN' },
  },
  {
    breaks: 'gives the proven domains to ask again, longest ago first, up to the limit',
    by: 'asks again the domains that were never proven',
    replace: { from: 'isNotNull(domains.verified_at), or(', to: 'sql`true`, or(' },
  },
  {
    breaks: 'names the previews of a domain on a site of its own workspace only, and forgets them with the site',
    by: 'names a site of any workspace',
    replace: {
      after: 'async setPreviews(',
      from: '.where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))',
      to: '.where(eq(sites.id, site))',
    },
  },
  {
    breaks: 'removes the domains of a workspace it deletes, and only those',
    by: 'leaves the domains of a workspace it deletes',
    wrap: (real) => {
      // What a table with no cascade on the workspace would leave.
      const left = new Map<string, Awaited<ReturnType<AccountStore['domains']>>>();

      return {
        ...real,
        async deleteWorkspace(workspace) {
          left.set(workspace, await real.domains(workspace));
          await real.deleteWorkspace(workspace);
        },
        domains: async (workspace) => left.get(workspace) ?? real.domains(workspace),
      };
    },
  },
];

describeControls('AccountStore', accountCases, VIOLATIONS, PGLITE, async (change) => {
  const mutant = await mutatedModule('accounts-postgres.ts', change);
  let database: Database | undefined;

  return {
    factory: 'createPostgresAccountStore',
    label: 'a changed PostgreSQL account store',
    async open() {
      database = await createMigratedPgliteDatabase();
      const create = mutant.module.createPostgresAccountStore as (database: Database) => AccountStore;

      return create(database);
    },
    async close() {
      await database?.close();
      database = undefined;
      mutant.remove();
    },
  };
});

describe('the AccountStore conformance suite', () => {
  it('runs for every implementation the worker exports', () => {
    assert.deepEqual([...new Set(SUBJECTS.map((subject) => subject.factory))].sort(), factoriesOf('AccountStore'));
  });
});
