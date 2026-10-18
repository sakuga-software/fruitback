import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import { type SQL, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { connectorOf } from './account-rows.ts';
import { organization, user } from './auth-schema.ts';
import type {
  AdminConnector,
  AdminUser,
  AdminWorkspace,
  AdminWorkspaceDetail,
  AttentionConnector,
  InstanceAdminReads,
  StageCounts,
  TracedRead,
} from './instance-admin.ts';
import { ADMIN_PAGE, ADMIN_READS } from './instance-admin.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { admin_reads, connectors } from './postgres-schema.ts';

/**
 * What the administrator of the instance reads, in the database of the worker (FRU-261). See
 * `instance-admin.ts`.
 *
 * WARNING: a statement here selects its columns by name. `connectors.sealed`, the digests of
 * `session` and `verification`, the token columns of `account`, `note_index.excerpt` and the
 * `seeds` table are never selected: an answer of the administrator holds none of them.
 *
 * A `BIGINT` is read through the schema, as in every store (FRU-180): the raw statements here count,
 * and read an instant of better-auth as milliseconds (`EPOCH_MS`).
 */

type Row = Record<string, unknown>;

/** How many reads of one workspace its owners get, the newest first. */
const READS_SHOWN = 200;

function rowsOf(answer: unknown): Row[] {
  return (answer as { rows: Row[] }).rows;
}

const iso = (value: unknown): string => new Date(Number(value)).toISOString();

/** A `timestamptz` of better-auth as milliseconds: a raw statement answers it as text otherwise. */
const EPOCH_MS = (column: SQL) => sql`(extract(epoch FROM ${column}) * 1000)::float8`;
const number = (value: unknown): number => Number(value ?? 0);
const named = (value: unknown): { name?: string } => (typeof value === 'string' && value !== '' ? { name: value } : {});

function noStages(): StageCounts {
  return Object.fromEntries(SEED_STAGES.map((stage) => [stage, 0])) as StageCounts;
}

/** `text`, for `ILIKE` with no wildcard of its own: `%`, `_` and `\` match themselves. */
function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** `IN (…)` of these values. The caller gives at least one. */
function among(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function connectorFrom(row: Row): AdminConnector | undefined {
  const connector = connectorOf(row);
  if (connector === undefined) return undefined;

  return {
    id: connector.id,
    kind: connector.kind,
    label: connector.label,
    ...(connector.attention === undefined ? {} : { attention: connector.attention }),
  };
}

/** The columns `connectorOf` reads, and not `sealed`. */
const CONNECTOR_COLUMNS = {
  id: connectors.id,
  workspace_id: connectors.workspace_id,
  kind: connectors.kind,
  label: connectors.label,
  created_at: connectors.created_at,
  attention: connectors.attention,
  attention_at: connectors.attention_at,
  settings: connectors.settings,
};

export function createPostgresInstanceAdmin(database: Database): InstanceAdminReads {
  const run = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };
  const query = async (statement: SQL): Promise<Row[]> => rowsOf(await run((db) => db.execute(statement)));

  /** The notes of each workspace (or each site) of `ids`, by stage, from the index (FRU-237). */
  const stagesBy = async (column: 'workspace_id' | 'site_id', ids: readonly string[]) => {
    const counts = new Map<string, StageCounts>();
    if (ids.length === 0) return counts;
    const rows = await query(
      sql`SELECT ${sql.identifier(column)} AS id, stage, count(*)::int AS n FROM note_index
           WHERE ${sql.identifier(column)} IN ${among(ids)} GROUP BY 1, 2`,
    );
    for (const row of rows) {
      const stages = counts.get(String(row.id)) ?? noStages();
      if ((SEED_STAGES as readonly string[]).includes(String(row.stage))) {
        stages[row.stage as SeedStage] += number(row.n);
      }
      counts.set(String(row.id), stages);
    }

    return counts;
  };

  const connectorsOf = async (ids: readonly string[]) => {
    const found = new Map<string, (AdminConnector & { createdAt: string })[]>();
    if (ids.length === 0) return found;
    const rows = await run((db) =>
      db
        .select(CONNECTOR_COLUMNS)
        .from(connectors)
        .where(inArray(connectors.workspace_id, [...ids]))
        .orderBy(asc(connectors.created_at), asc(connectors.id)),
    );
    for (const row of rows) {
      const connector = connectorFrom(row);
      if (connector === undefined) continue;
      const list = found.get(String(row.workspace_id)) ?? [];
      list.push({ ...connector, createdAt: iso(row.created_at) });
      found.set(String(row.workspace_id), list);
    }

    return found;
  };

  return {
    async counts() {
      const [row] = await query(
        sql`SELECT (SELECT count(*)::int FROM organization) AS workspaces,
                   (SELECT count(*)::int FROM "user") AS accounts,
                   (SELECT count(*)::int FROM "user" WHERE role = 'admin' AND banned IS NOT TRUE) AS admins`,
      );

      return { workspaces: number(row?.workspaces), accounts: number(row?.accounts), admins: number(row?.admins) };
    },

    async attention() {
      const rows = await run((db) =>
        db
          .select({ ...CONNECTOR_COLUMNS, workspace_name: organization.name })
          .from(connectors)
          .innerJoin(organization, eq(organization.id, connectors.workspace_id))
          .where(isNotNull(connectors.attention))
          .orderBy(desc(connectors.attention_at), asc(connectors.id))
          .limit(ADMIN_PAGE),
      );

      return rows.flatMap((row): AttentionConnector[] => {
        const connector = connectorFrom(row);
        if (connector?.attention === undefined) return [];

        return [{ ...connector, workspace: { id: String(row.workspace_id), name: String(row.workspace_name) } }];
      });
    },

    async workspaces({ q, show }) {
      const search =
        q === undefined
          ? sql`true`
          : sql`(o.name ILIKE ${containing(q)} OR o.id = ${q} OR EXISTS (
                  SELECT 1 FROM member m JOIN "user" u ON u.id = m."userId"
                   WHERE m."organizationId" = o.id AND m.role = 'owner'
                     AND (u.email ILIKE ${containing(q)} OR u.name ILIKE ${containing(q)})))`;
      const shown = {
        all: sql`true`,
        attention: sql`(EXISTS (SELECT 1 FROM connectors c WHERE c.workspace_id = o.id AND c.attention IS NOT NULL)
                    OR EXISTS (SELECT 1 FROM deliveries d JOIN connectors c ON c.id = d.connector_id
                                WHERE c.workspace_id = o.id))`,
        empty: sql`NOT EXISTS (SELECT 1 FROM sites s WHERE s.workspace_id = o.id)`,
      }[show];
      const rows = await query(
        sql`SELECT o.id, o.name, ${EPOCH_MS(sql`o."createdAt"`)} AS created_at,
                   (SELECT count(*)::int FROM member m WHERE m."organizationId" = o.id) AS members,
                   (SELECT count(*)::int FROM sites s WHERE s.workspace_id = o.id) AS sites,
                   (SELECT count(*)::int FROM deliveries d JOIN connectors c ON c.id = d.connector_id
                     WHERE c.workspace_id = o.id) AS pending,
                   count(*) OVER ()::int AS total
              FROM organization o
             WHERE ${search} AND ${shown}
             ORDER BY o."createdAt" DESC, o.id
             LIMIT ${ADMIN_PAGE}`,
      );
      const ids = rows.map((row) => String(row.id));
      const [owners, destinations, notes] = await Promise.all([
        ids.length === 0
          ? []
          : query(
              sql`SELECT m."organizationId" AS workspace, u.id, u.name, u.email
                    FROM member m JOIN "user" u ON u.id = m."userId"
                   WHERE m.role = 'owner' AND m."organizationId" IN ${among(ids)}
                   ORDER BY m."createdAt", u.id`,
            ),
        connectorsOf(ids),
        stagesBy('workspace_id', ids),
      ]);

      return {
        total: number(rows[0]?.total),
        workspaces: rows.map(
          (row): AdminWorkspace => ({
            id: String(row.id),
            name: String(row.name),
            createdAt: iso(row.created_at),
            owners: owners
              .filter((owner) => owner.workspace === row.id)
              .map((owner) => ({ id: String(owner.id), ...named(owner.name), email: String(owner.email) })),
            members: number(row.members),
            sites: number(row.sites),
            notes: notes.get(String(row.id)) ?? noStages(),
            destinations: (destinations.get(String(row.id)) ?? []).map(({ createdAt: _, ...connector }) => connector),
            pendingDeliveries: number(row.pending),
          }),
        ),
      };
    },

    async workspace(id) {
      const [found] = await query(
        sql`SELECT o.id, o.name, ${EPOCH_MS(sql`o."createdAt"`)} AS created_at,
                   (SELECT count(*)::int FROM deliveries d JOIN connectors c ON c.id = d.connector_id
                     WHERE c.workspace_id = o.id) AS pending,
                   (SELECT count(*)::int FROM invitation i
                     WHERE i."organizationId" = o.id AND i.status = 'pending' AND i."expiresAt" > now()) AS invited
              FROM organization o WHERE o.id = ${id}`,
      );
      if (found === undefined) return undefined;

      const [members, sites, places, destinations] = await Promise.all([
        query(
          sql`SELECT u.id, u.name, u.email, m.role, s.day
                FROM member m JOIN "user" u ON u.id = m."userId"
                LEFT JOIN last_seen s ON s.member_id = m.id
               WHERE m."organizationId" = ${id}
               ORDER BY m."createdAt", u.id`,
        ),
        query(sql`SELECT id, origin, visibility FROM sites WHERE workspace_id = ${id} ORDER BY created_at, id`),
        query(
          sql`SELECT d.site_id, d.connector_id, d.label
                FROM site_destinations d JOIN sites s ON s.id = d.site_id
               WHERE s.workspace_id = ${id}
               ORDER BY d.site_id, d.position`,
        ),
        connectorsOf([id]),
      ]);
      const siteNotes = await stagesBy(
        'site_id',
        sites.map((site) => String(site.id)),
      );

      const detail: AdminWorkspaceDetail = {
        id: String(found.id),
        name: String(found.name),
        createdAt: iso(found.created_at),
        members: members.map((row) => ({
          id: String(row.id),
          ...named(row.name),
          email: String(row.email),
          role: String(row.role),
          ...(typeof row.day === 'string' ? { lastSeen: row.day } : {}),
        })),
        sites: sites.map((site) => ({
          id: String(site.id),
          origin: String(site.origin),
          visibility: String(site.visibility),
          destinations: places
            .filter((place) => place.site_id === site.id)
            .map((place) => ({
              connector: String(place.connector_id),
              ...(typeof place.label === 'string' ? { label: place.label } : {}),
            })),
          notes: siteNotes.get(String(site.id)) ?? noStages(),
        })),
        destinations: destinations.get(id) ?? [],
        pendingDeliveries: number(found.pending),
        pendingInvitations: number(found.invited),
      };

      return detail;
    },

    async users({ q, show }) {
      const search =
        q === undefined
          ? sql`true`
          : sql`(u.email ILIKE ${containing(q)} OR u.name ILIKE ${containing(q)} OR u.id = ${q})`;
      const shown = {
        all: sql`true`,
        admins: sql`(u.role = 'admin' AND u.banned IS NOT TRUE)`,
        alone: sql`NOT EXISTS (SELECT 1 FROM member m WHERE m."userId" = u.id)`,
      }[show];
      const rows = await query(
        sql`SELECT u.id, u.name, u.email, ${EPOCH_MS(sql`u."createdAt"`)} AS created_at,
                   (u.role = 'admin' AND u.banned IS NOT TRUE) AS admin,
                   (SELECT max(s.day) FROM last_seen s JOIN member m ON m.id = s.member_id
                     WHERE m."userId" = u.id) AS seen,
                   count(*) OVER ()::int AS total
              FROM "user" u
             WHERE ${search} AND ${shown}
             ORDER BY u."createdAt" DESC, u.id
             LIMIT ${ADMIN_PAGE}`,
      );
      const ids = rows.map((row) => String(row.id));
      const [memberships, providers, invitations] =
        ids.length === 0
          ? [[], [], []]
          : await Promise.all([
              query(
                sql`SELECT m."userId" AS person, o.id, o.name, m.role
                      FROM member m JOIN organization o ON o.id = m."organizationId"
                     WHERE m."userId" IN ${among(ids)}
                     ORDER BY m."createdAt", o.id`,
              ),
              query(
                sql`SELECT DISTINCT a."userId" AS person, a."providerId" AS provider
                      FROM account a WHERE a."userId" IN ${among(ids)} ORDER BY 2`,
              ),
              query(
                sql`SELECT u.id AS person, o.id, o.name, i.role
                      FROM invitation i
                      JOIN organization o ON o.id = i."organizationId"
                      JOIN "user" u ON lower(u.email) = lower(i.email)
                     WHERE u.id IN ${among(ids)} AND i.status = 'pending' AND i."expiresAt" > now()
                     ORDER BY i."createdAt", o.id`,
              ),
            ]);
      const of = (list: Row[], person: unknown) => list.filter((row) => row.person === person);

      return {
        total: number(rows[0]?.total),
        users: rows.map(
          (row): AdminUser => ({
            id: String(row.id),
            ...named(row.name),
            email: String(row.email),
            createdAt: iso(row.created_at),
            instanceAdmin: row.admin === true,
            workspaces: of(memberships, row.id).map((each) => ({
              id: String(each.id),
              name: String(each.name),
              role: String(each.role),
            })),
            providers: of(providers, row.id).map((each) => String(each.provider)),
            ...(typeof row.seen === 'string' ? { lastSeen: row.seen } : {}),
            pendingInvitations: of(invitations, row.id).map((each) => ({
              workspace: { id: String(each.id), name: String(each.name) },
              ...(typeof each.role === 'string' ? { role: each.role } : {}),
            })),
          }),
        ),
      };
    },

    async trace(admin, workspaces, what, now) {
      const ids = [...new Set(workspaces)];
      if (ids.length === 0) return;
      // One statement: the rows of every workspace are written, or none is, and the read fails.
      await query(
        sql`INSERT INTO admin_reads (id, workspace_id, admin_account_id, admin_email, what, at)
            SELECT 'adr_' || substr(md5(random()::text || clock_timestamp()::text || o.id), 1, 20),
                   o.id, ${admin.id}, ${admin.email}, ${what}, ${now}
              FROM organization o
             WHERE o.id IN ${among(ids)}
               AND NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id AND m."userId" = ${admin.id})`,
      );
    },

    async reads(workspace) {
      const rows = await run((db) =>
        db
          .select({
            admin_email: admin_reads.admin_email,
            what: admin_reads.what,
            at: admin_reads.at,
            email: user.email,
            name: user.name,
          })
          .from(admin_reads)
          .leftJoin(user, eq(user.id, admin_reads.admin_account_id))
          .where(eq(admin_reads.workspace_id, workspace))
          .orderBy(desc(admin_reads.at), asc(admin_reads.id))
          .limit(READS_SHOWN),
      );

      return rows.flatMap((row): TracedRead[] => {
        if (!(ADMIN_READS as readonly unknown[]).includes(row.what)) return [];

        return [
          {
            admin: { email: row.email ?? row.admin_email, ...named(row.name) },
            what: row.what as TracedRead['what'],
            at: iso(row.at),
          },
        ];
      });
    },
  };
}
