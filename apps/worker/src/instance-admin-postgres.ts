import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import { type SQL, and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { connectorOf, newId, roleOf } from './account-rows.ts';
import { dropWorkspace, holdMembers } from './accounts-postgres.ts';
import { CONNECTOR_TROUBLES, can } from './accounts.ts';
import { invitation, member, organization, session, user } from './auth-schema.ts';
import type {
  AdminAction,
  AdminActionKind,
  AccountDeletion,
  AdminInvitation,
  MemberAddition,
  MemberRoleChange,
  OwnerChange,
  WorkspaceCreation,
  AdminConnector,
  AdminNote,
  AdminUser,
  AdminWorkspace,
  AdminWorkspaceDetail,
  AttentionConnector,
  InstanceAdminReads,
  RoleChange,
  StageCounts,
  SuspensionChange,
  TracedAction,
  WorkspaceActionKind,
  TracedRead,
  WorkspaceDeletion,
  WorkspaceSuspensionChange,
} from './instance-admin.ts';
import { ADMIN_ACTIONS, ADMIN_INVITATION_MS, ADMIN_PAGE, ADMIN_READS, isWorkspaceAction } from './instance-admin.ts';
import { omit } from './omit.ts';
import { suspensionView } from './workspace-suspension.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import type { AuthorKind } from './notes-index.ts';
import { placeIs, wordsOf } from './notes-index-postgres.ts';
import {
  admin_actions,
  admin_reads,
  connectors,
  note_index,
  seeds,
  site_shares,
  sites,
  workspace_suspensions,
} from './postgres-schema.ts';
import { noteOf, rowOfIdentifier, seedIdOf } from './seed-rows.ts';

/**
 * What the administrator of the instance reads, in the database of the worker (FRU-261). See
 * `instance-admin.ts`.
 *
 * WARNING: a statement here selects its columns by name. The digests of `session` and `verification`,
 * and the token columns of `account` are never selected: an answer of the administrator holds none of
 * them. `connectors.sealed` is selected once, by `deleteWorkspace`, for the Linear connectors of the
 * workspace it deletes: the route revokes them after the commit, and answers none of them. Only `notes` selects `note_index.excerpt` and `seeds.seed`,
 * and it answers the text of a row of `seeds` only for the note that the row is (`keptTexts`).
 *
 * A `BIGINT` is read through the schema, as in every store (FRU-180): the raw statements here count,
 * and read an instant of better-auth as milliseconds (`EPOCH_MS`).
 */

type Row = Record<string, unknown>;

/** How many reads of one workspace its owners get, the newest first. */
const READS_SHOWN = 200;

/** How many actions the administrators get, the newest first. */
const ACTIONS_SHOWN = 200;

/**
 * The advisory lock of the role of administrator: the key that the trigger of `0016_first_admin`
 * takes. A change of the role waits for another change, and for the first account.
 */
export const ADMIN_ROLE_LOCK = 1179796036;

/** The administrators of the instance: `role` is `admin`, and the account is not banned. */
const IS_ADMIN = sql`role = 'admin' AND banned IS NOT TRUE`;

/** `detail` of a row, or `undefined` for a value that is not a JSON object. */
function detailOf(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rowsOf(answer: unknown): Row[] {
  return (answer as { rows: Row[] }).rows;
}

const iso = (value: unknown): string => new Date(Number(value)).toISOString();

/** A `timestamptz` of better-auth as milliseconds: a raw statement answers it as text otherwise. */
const EPOCH_MS = (column: SQL) => sql`(extract(epoch FROM ${column}) * 1000)::float8`;
const number = (value: unknown): number => Number(value ?? 0);
const named = (value: unknown): { name?: string } => (typeof value === 'string' && value !== '' ? { name: value } : {});

/** The suspension of a workspace in a raw row (FRU-282): `since` and `reason`, or `NULL` for none. */
const suspensionIn = (row: Row) =>
  suspensionView(
    row.since === null || row.since === undefined
      ? undefined
      : {
          since: number(row.since),
          ...(typeof row.reason === 'string' && row.reason !== '' ? { reason: row.reason } : {}),
        },
  );

/**
 * The workspace of an action whose workspace was deleted (FRU-284): `detail` keeps its id and its
 * name, and `workspace_id` is empty since the deletion.
 */
const deletedIn = (detail: Record<string, unknown> | undefined): { workspace?: { id: string; name: string } } => {
  const kept = detail?.workspace as { id?: unknown; name?: unknown } | undefined;

  return typeof kept?.id === 'string' && typeof kept.name === 'string'
    ? { workspace: { id: kept.id, name: kept.name } }
    : {};
};

/** The role that `detail` of an action holds, for its owners (FRU-283). */
const roleIn = (detail: string | null): { role?: string } => {
  const role = detailOf(detail)?.role;

  return typeof role === 'string' && role !== '' ? { role } : {};
};

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

/**
 * A connector needs attention only for a trouble that this version knows: `connectorOf` drops another
 * value, so the count and the filter must drop it too.
 */
const TROUBLED = sql`c.attention IN (${sql.join(
  CONNECTOR_TROUBLES.map((trouble) => sql`${trouble}`),
  sql`, `,
)})`;

/** The columns of `note_index` that `notes` answers: not `author_account_id`. */
const NOTE_COLUMNS = {
  site_id: note_index.site_id,
  seed_id: note_index.seed_id,
  workspace_id: note_index.workspace_id,
  page_url: note_index.page_url,
  excerpt: note_index.excerpt,
  stage: note_index.stage,
  channel: note_index.channel,
  author_kind: note_index.author_kind,
  place: note_index.place,
  reference: note_index.reference,
  reference_url: note_index.reference_url,
  created_at: note_index.created_at,
  checked_at: note_index.checked_at,
};

type NoteRow = { site_id: string; seed_id: string; reference: string | null };

const keyOf = (row: { site_id: string; seed_id: string }): string => JSON.stringify([row.site_id, row.seed_id]);

/**
 * The text of each note of a page that the worker keeps in `seeds`, by its key. The reference gives
 * the number of a row only: a tracker can name an issue `FB-12` too. The row is the note when its site
 * and the id that the widget gave it are the ones of the index. A row that does not parse is no note.
 */
async function keptTexts(db: Db, rows: readonly NoteRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.flatMap((row) => (row.reference === null ? [] : [rowOfIdentifier(row.reference) ?? []].flat()))),
  ];
  if (ids.length === 0) return new Map();
  const kept = await db
    .select({ id: seeds.id, client_id: seeds.client_id, seed: seeds.seed })
    .from(seeds)
    .where(inArray(seeds.id, ids));
  const byId = new Map(kept.map((row) => [Number(row.id), row]));

  const texts = new Map<string, string>();
  for (const row of rows) {
    const id = row.reference === null ? undefined : rowOfIdentifier(row.reference);
    const seed = id === undefined ? undefined : byId.get(id);
    if (seed === undefined || seed.client_id !== row.site_id) continue;
    const widgetId = seedIdOf(seed.seed);
    if (widgetId === '' || widgetId !== row.seed_id) continue;
    texts.set(keyOf(row), noteOf(seed.seed));
  }

  return texts;
}

/** The columns of an action of `actor`, at `now`, in `workspace`. */
function actionOf(actor: { id: string; email: string }, now: number, action: AdminActionKind, workspace: string) {
  return {
    id: newId('ada'),
    at: now,
    actor_account_id: actor.id,
    actor_email: actor.email,
    action,
    workspace_id: workspace,
  };
}

/**
 * What follows a change of a role, as after `update-member-role` of `auth-organization.ts`, in the
 * transaction of the change: a role that no longer invites cancels the invitations of that person in
 * the workspace (FRU-209), and a guest who becomes another role keeps no site of a guest (FRU-250).
 */
async function afterRoleChange(
  db: Db,
  workspace: string,
  account: string,
  before: string,
  after: string,
): Promise<void> {
  const role = roleOf(after);
  if (role === undefined || !can(role, 'manage-members')) {
    await db
      .update(invitation)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(invitation.organizationId, workspace),
          eq(invitation.inviterId, account),
          eq(invitation.status, 'pending'),
        ),
      );
  }
  if (before === 'guest' && after !== 'guest') {
    await db
      .delete(site_shares)
      .where(and(eq(site_shares.workspace_id, workspace), eq(site_shares.account_id, account)));
  }
}

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

  /**
   * One write of an administrator in a workspace (FRU-283), in one transaction: the lock of the role
   * first, as every write of the administrator; its members, then the workspace `FOR UPDATE`, so a
   * member added by the plugin waits (members first: see `holdMembers`, FRU-324); the caller is still
   * an administrator; the workspace is not suspended (FRU-282).
   */
  const inWorkspace = async <T>(
    actor: { id: string },
    workspace: string,
    work: (db: Db, rowsIn: (statement: SQL) => Promise<Row[]>, found: { id: string; name: string }) => Promise<T>,
  ): Promise<T | { ok: false; refused: 'unknown-workspace' | 'not-admin' | 'workspace-suspended' }> => {
    await migrated(database);

    return database.transaction(async (db) => {
      const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
      await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);
      await holdMembers(db, workspace);
      const [found] = await db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(eq(organization.id, workspace))
        .for('update');
      if (found === undefined) return { ok: false as const, refused: 'unknown-workspace' as const };
      const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
      if (asking === undefined) return { ok: false as const, refused: 'not-admin' as const };
      const [suspended] = await rowsIn(
        sql`SELECT 1 AS one FROM workspace_suspensions WHERE workspace_id = ${workspace}`,
      );
      if (suspended !== undefined) return { ok: false as const, refused: 'workspace-suspended' as const };

      return work(db, rowsIn, found);
    });
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
          .select({
            ...CONNECTOR_COLUMNS,
            workspace_name: organization.name,
            total: sql<number>`count(*) OVER ()::int`,
          })
          .from(connectors)
          .innerJoin(organization, eq(organization.id, connectors.workspace_id))
          .where(inArray(connectors.attention, [...CONNECTOR_TROUBLES]))
          .orderBy(desc(connectors.attention_at), asc(connectors.id))
          .limit(ADMIN_PAGE),
      );

      // The page holds at most `ADMIN_PAGE` rows: the count of all of them comes with each row.
      return {
        total: number(rows[0]?.total),
        connectors: rows.flatMap((row): AttentionConnector[] => {
          const connector = connectorFrom(row);
          if (connector?.attention === undefined) return [];

          return [{ ...connector, workspace: { id: String(row.workspace_id), name: String(row.workspace_name) } }];
        }),
      };
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
        attention: sql`(EXISTS (SELECT 1 FROM connectors c WHERE c.workspace_id = o.id AND ${TROUBLED})
                    OR EXISTS (SELECT 1 FROM deliveries d JOIN connectors c ON c.id = d.connector_id
                                WHERE c.workspace_id = o.id))`,
        empty: sql`NOT EXISTS (SELECT 1 FROM sites s WHERE s.workspace_id = o.id)`,
        suspended: sql`w.workspace_id IS NOT NULL`,
      }[show];
      const rows = await query(
        sql`SELECT o.id, o.name, ${EPOCH_MS(sql`o."createdAt"`)} AS created_at,
                   (SELECT count(*)::int FROM member m WHERE m."organizationId" = o.id) AS members,
                   (SELECT count(*)::int FROM sites s WHERE s.workspace_id = o.id) AS sites,
                   (SELECT count(*)::int FROM deliveries d JOIN connectors c ON c.id = d.connector_id
                     WHERE c.workspace_id = o.id) AS pending,
                   w.since, w.reason,
                   count(*) OVER ()::int AS total
              FROM organization o
              LEFT JOIN workspace_suspensions w ON w.workspace_id = o.id
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
            ...suspensionIn(row),
            createdAt: iso(row.created_at),
            owners: owners
              .filter((owner) => owner.workspace === row.id)
              .map((owner) => ({ id: String(owner.id), ...named(owner.name), email: String(owner.email) })),
            members: number(row.members),
            sites: number(row.sites),
            notes: notes.get(String(row.id)) ?? noStages(),
            destinations: (destinations.get(String(row.id)) ?? []).map((connector) => omit(connector, 'createdAt')),
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
                     WHERE i."organizationId" = o.id AND i.status = 'pending' AND i."expiresAt" > now()) AS invited,
                   w.since, w.reason
              FROM organization o
              LEFT JOIN workspace_suspensions w ON w.workspace_id = o.id
             WHERE o.id = ${id}`,
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
        ...suspensionIn(found),
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
                   (u.banned IS TRUE) AS suspended,
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
                sql`SELECT m."userId" AS person, o.id, o.name, m.role,
                           (m.role = 'owner' AND NOT EXISTS (
                             SELECT 1 FROM member other
                              WHERE other."organizationId" = m."organizationId" AND other.role = 'owner'
                                AND other."userId" <> m."userId")) AS sole
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
            suspended: row.suspended === true,
            workspaces: of(memberships, row.id).map((each) => ({
              id: String(each.id),
              name: String(each.name),
              role: String(each.role),
              // The account owns this workspace alone (FRU-285): it cannot be deleted before another owner.
              ...(each.sole === true ? { soleOwner: true as const } : {}),
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

    async notes(query) {
      return run(async (db) => {
        const words = wordsOf(query.q).map((word) => {
          const like = containing(word);

          return or(
            ilike(note_index.excerpt, like),
            ilike(note_index.page_url, like),
            ilike(sites.origin, like),
            ilike(organization.name, like),
            ilike(note_index.workspace_id, like),
            ilike(note_index.stage, like),
            ilike(note_index.reference, like),
          );
        });
        const filtered = and(
          query.workspace === undefined ? undefined : eq(note_index.workspace_id, query.workspace),
          query.site === undefined ? undefined : eq(note_index.site_id, query.site),
          query.stage === undefined ? undefined : eq(note_index.stage, query.stage),
          query.place === undefined ? undefined : placeIs(query.place),
          ...words,
        );
        const after =
          query.after === undefined
            ? filtered
            : and(
                filtered,
                sql`(${note_index.created_at}, ${note_index.site_id} COLLATE "C", ${note_index.seed_id} COLLATE "C") < (${query.after.at}, ${query.after.site} COLLATE "C", ${query.after.seed} COLLATE "C")`,
              );

        const [page, [counted]] = await Promise.all([
          db
            .select({
              row: NOTE_COLUMNS,
              origin: sites.origin,
              workspaceName: organization.name,
              connector: { id: connectors.id, kind: connectors.kind, label: connectors.label },
            })
            .from(note_index)
            .innerJoin(sites, eq(sites.id, note_index.site_id))
            .innerJoin(organization, eq(organization.id, note_index.workspace_id))
            .leftJoin(connectors, eq(connectors.id, note_index.connector_id))
            .where(after)
            .orderBy(
              sql`${note_index.created_at} DESC NULLS LAST`,
              sql`${note_index.site_id} COLLATE "C" DESC`,
              sql`${note_index.seed_id} COLLATE "C" DESC`,
            )
            .limit(query.limit + 1),
          db
            .select({ notes: count() })
            .from(note_index)
            .innerJoin(sites, eq(sites.id, note_index.site_id))
            .innerJoin(organization, eq(organization.id, note_index.workspace_id))
            .where(filtered),
        ]);
        const shown = page.slice(0, query.limit);
        const texts = await keptTexts(
          db,
          shown.map(({ row }) => row),
        );
        const last = shown.at(-1);

        return {
          notes: shown.map(({ row, origin, workspaceName, connector }): AdminNote => {
            const text = texts.get(keyOf(row));

            return {
              workspace: { id: row.workspace_id, name: workspaceName },
              site: { id: row.site_id, origin },
              seed: row.seed_id,
              pageUrl: row.page_url,
              excerpt: row.excerpt,
              ...(text === undefined ? {} : { text }),
              stage: row.stage,
              channel: row.channel === 'script' || row.channel === 'extension' ? row.channel : null,
              author: row.author_kind as AuthorKind,
              place:
                row.place === 'fruitback'
                  ? { kind: 'fruitback' }
                  : { kind: 'connector', ...(connector === null ? {} : { connector }) },
              ...(row.reference === null ? {} : { reference: row.reference }),
              ...(row.reference_url === null ? {} : { referenceUrl: row.reference_url }),
              createdAt: Number(row.created_at),
              checkedAt: Number(row.checked_at),
            };
          }),
          total: number(counted?.notes),
          ...(page.length > query.limit && last !== undefined
            ? { next: { at: Number(last.row.created_at), site: last.row.site_id, seed: last.row.seed_id } }
            : {}),
        };
      });
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

    async setInstanceAdmin(actor, target, admin, now) {
      await migrated(database);

      return database.transaction(async (db): Promise<RoleChange> => {
        const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
        // WARNING: the lock comes before every read. In READ COMMITTED, each statement after it reads
        // what the transaction that held the lock committed, so two removals count one another.
        await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);

        const [row] = await rowsIn(sql`SELECT email, role, (${IS_ADMIN}) AS admin FROM "user" WHERE id = ${target}`);
        if (row === undefined) return { ok: false, refused: 'unknown-account' };
        if (!admin && target === actor.id) return { ok: false, refused: 'self-removal' };
        if ((row.role === 'admin') === admin) return { ok: true, changed: false, instanceAdmin: row.admin === true };
        if (row.admin === true) {
          const [counted] = await rowsIn(sql`SELECT count(*)::int AS n FROM "user" WHERE ${IS_ADMIN}`);
          if (number(counted?.n) <= 1) return { ok: false, refused: 'last-admin' };
        }
        // After the rule of the last administrator: of two that remove each other, the second learns why.
        const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
        if (asking === undefined) return { ok: false, refused: 'not-admin' };

        await db
          .update(user)
          .set({ role: admin ? 'admin' : null, updatedAt: new Date(now) })
          .where(eq(user.id, target));
        const action: AdminActionKind = admin ? 'admin-named' : 'admin-removed';
        await db.insert(admin_actions).values({
          id: newId('ada'),
          at: now,
          actor_account_id: actor.id,
          actor_email: actor.email,
          action,
          target_account_id: target,
          target_email: String(row.email),
        });
        const [after] = await rowsIn(sql`SELECT (${IS_ADMIN}) AS admin FROM "user" WHERE id = ${target}`);

        return { ok: true, changed: true, instanceAdmin: after?.admin === true };
      });
    },

    async isSuspended(account) {
      const [row] = await query(sql`SELECT (banned IS TRUE) AS suspended FROM "user" WHERE id = ${account}`);

      return row?.suspended === true;
    },

    async setSuspended(actor, target, suspended, now) {
      await migrated(database);

      return database.transaction(async (db): Promise<SuspensionChange> => {
        const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
        // WARNING: the lock comes before every read, as in `setInstanceAdmin`: a suspension changes
        // who counts as an administrator, so it waits for a change of the role, and the other way.
        await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);

        const [row] = await rowsIn(
          sql`SELECT email, (banned IS TRUE) AS suspended, (${IS_ADMIN}) AS admin FROM "user" WHERE id = ${target}`,
        );
        if (row === undefined) return { ok: false, refused: 'unknown-account' };
        if (suspended && target === actor.id) return { ok: false, refused: 'self-suspension' };
        if ((row.suspended === true) === suspended) return { ok: true, changed: false, suspended };
        if (suspended && row.admin === true) {
          const [counted] = await rowsIn(sql`SELECT count(*)::int AS n FROM "user" WHERE ${IS_ADMIN}`);
          if (number(counted?.n) <= 1) return { ok: false, refused: 'last-admin' };
        }
        const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
        if (asking === undefined) return { ok: false, refused: 'not-admin' };

        // `banReason` and `banExpires` stay empty: a suspension has no reason in the console, and
        // ends when an administrator restores the account.
        await db
          .update(user)
          .set({ banned: suspended, banReason: null, banExpires: null, updatedAt: new Date(now) })
          .where(eq(user.id, target));
        // Both ways. A suspended account has no session that it may keep: one that a sign-in opened
        // while this transaction ran is not given back with the account.
        await db.delete(session).where(eq(session.userId, target));
        // The owners of each workspace of the account read the action: one row for each workspace
        // that the account is a member of now, and one row with no workspace for an account in none.
        const workspaces = await rowsIn(sql`SELECT "organizationId" AS id FROM member WHERE "userId" = ${target}`);
        const action: AdminActionKind = suspended ? 'account-suspended' : 'account-restored';
        const each = (workspace: string | null) => ({
          id: newId('ada'),
          at: now,
          actor_account_id: actor.id,
          actor_email: actor.email,
          action,
          target_account_id: target,
          target_email: String(row.email),
          workspace_id: workspace,
        });
        await db
          .insert(admin_actions)
          .values(workspaces.length === 0 ? [each(null)] : workspaces.map((workspace) => each(String(workspace.id))));

        return { ok: true, changed: true, suspended };
      });
    },

    async setWorkspaceSuspended(actor, workspace, suspended, reason, now) {
      await migrated(database);

      return database.transaction(async (db): Promise<WorkspaceSuspensionChange> => {
        // WARNING: the lock comes before every read, as in `setInstanceAdmin`: the check of the role
        // below waits for a change of the role, so an administrator removed at this moment is refused.
        await db.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);
        const [found] = await db
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, workspace))
          // A deletion of the workspace waits for this transaction, and the rows below find it.
          .for('key share');
        if (found === undefined) return { ok: false, refused: 'unknown-workspace' };
        const [asking] = rowsOf(
          await db.execute(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`),
        );
        if (asking === undefined) return { ok: false, refused: 'not-admin' };

        // WARNING: the write says whether it changed something, in one statement. Of two calls at the
        // same moment, one writes the row, and the other finds it and writes no action.
        const written = suspended
          ? await db
              .insert(workspace_suspensions)
              .values({ workspace_id: workspace, since: now, reason: reason ?? null })
              .onConflictDoNothing()
              .returning({ since: workspace_suspensions.since })
          : await db
              .delete(workspace_suspensions)
              .where(eq(workspace_suspensions.workspace_id, workspace))
              .returning({ since: workspace_suspensions.since });
        const [held] = await db
          .select({ since: workspace_suspensions.since, reason: workspace_suspensions.reason })
          .from(workspace_suspensions)
          .where(eq(workspace_suspensions.workspace_id, workspace));
        const suspension =
          held === undefined
            ? undefined
            : { since: held.since, ...(held.reason === null ? {} : { reason: held.reason }) };
        if (written.length === 0)
          return { ok: true, changed: false, ...(suspension === undefined ? {} : { suspension }) };

        await db.insert(admin_actions).values({
          id: newId('ada'),
          at: now,
          actor_account_id: actor.id,
          actor_email: actor.email,
          action: suspended ? 'workspace-suspended' : 'workspace-restored',
          workspace_id: workspace,
          detail: reason === undefined ? null : JSON.stringify({ reason }),
        });

        return { ok: true, changed: true, ...(suspension === undefined ? {} : { suspension }) };
      });
    },

    async deleteWorkspace(actor, workspace, name, now) {
      await migrated(database);

      return database.transaction(async (db): Promise<WorkspaceDeletion> => {
        const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
        // WARNING: the lock comes before every read, as in `setWorkspaceSuspended`: the check of the
        // role below waits for a change of the role, so an administrator removed at this moment is refused.
        await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);
        // `FOR UPDATE`: a write that names the workspace (a site, a member, a connector) waits for the
        // deletion, and then finds no workspace. The counts below are then the ones that go. Its
        // members first, which go with it: see `holdMembers` (FRU-324).
        await holdMembers(db, workspace);
        const [found] = await db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(eq(organization.id, workspace))
          .for('update');
        if (found === undefined) return { ok: false, refused: 'unknown-workspace' };
        const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
        if (asking === undefined) return { ok: false, refused: 'not-admin' };
        if (found.name !== name) return { ok: false, refused: 'name-mismatch' };

        const [counted] = await rowsIn(
          sql`SELECT (SELECT count(*)::int FROM sites WHERE workspace_id = ${workspace}) AS sites,
                     (SELECT count(*)::int FROM member WHERE "organizationId" = ${workspace}) AS members,
                     (SELECT count(*)::int FROM invitation WHERE "organizationId" = ${workspace} AND status = 'pending' AND "expiresAt" > now()) AS invitations,
                     (SELECT count(*)::int FROM connectors WHERE workspace_id = ${workspace}) AS connectors,
                     (SELECT count(*)::int FROM seeds
                       WHERE client_id IN (SELECT id FROM sites WHERE workspace_id = ${workspace})) AS kept_notes`,
        );
        const gone = {
          sites: number(counted?.sites),
          members: number(counted?.members),
          invitations: number(counted?.invitations),
          connectors: number(counted?.connectors),
          keptNotes: number(counted?.kept_notes),
        };
        const linear = await db
          .select({ sealed: connectors.sealed })
          .from(connectors)
          .where(and(eq(connectors.workspace_id, workspace), eq(connectors.kind, 'linear')));

        // The action names no workspace in `workspace_id`, which the deletion would empty: its
        // `detail` keeps the id and the name, so the administrators still read which one went.
        await db.insert(admin_actions).values({
          id: newId('ada'),
          at: now,
          actor_account_id: actor.id,
          actor_email: actor.email,
          action: 'workspace-deleted',
          workspace_id: null,
          detail: JSON.stringify({ workspace: { id: found.id, name: found.name }, gone }),
        });
        await dropWorkspace(db, workspace);

        return {
          ok: true,
          workspace: { id: found.id, name: found.name },
          gone,
          revoke: linear.map((row) => row.sealed),
        };
      });
    },

    async setMemberRole(actor, workspace, account, role, now) {
      return inWorkspace<MemberRoleChange>(actor, workspace, async (db, rowsIn) => {
        const [held] = await rowsIn(
          sql`SELECT m.role, u.email FROM member m JOIN "user" u ON u.id = m."userId"
               WHERE m."organizationId" = ${workspace} AND m."userId" = ${account} FOR UPDATE OF m`,
        );
        if (held === undefined) return { ok: false, refused: 'not-a-member' };
        const before = String(held.role);
        if (before === role) return { ok: true, changed: false, role };
        // The rule of `update-member-role`: a workspace keeps an owner. The other owners are counted
        // under the lock of the workspace, so two changes at once cannot both take the last one.
        if (before === 'owner') {
          const [owners] = await rowsIn(
            sql`SELECT count(*)::int AS n FROM member WHERE "organizationId" = ${workspace} AND role = 'owner'`,
          );
          if (number(owners?.n) <= 1) return { ok: false, refused: 'last-owner' };
        }
        await db
          .update(member)
          .set({ role })
          .where(and(eq(member.organizationId, workspace), eq(member.userId, account)));
        await afterRoleChange(db, workspace, account, before, role);
        await db.insert(admin_actions).values({
          ...actionOf(actor, now, 'member-role-changed', workspace),
          target_account_id: account,
          target_email: String(held.email),
          detail: JSON.stringify({ from: before, role }),
        });

        return { ok: true, changed: true, role };
      });
    },

    async addMember(actor, workspace, email, role, now) {
      return inWorkspace<MemberAddition>(actor, workspace, async (db, rowsIn) => {
        const [person] = await rowsIn(sql`SELECT id, email FROM "user" WHERE email = ${email}`);
        if (person === undefined) return { ok: false, refused: 'unknown-account' };
        const id = String(person.id);
        const [already] = await rowsIn(
          sql`SELECT 1 AS one FROM member WHERE "organizationId" = ${workspace} AND "userId" = ${id}`,
        );
        if (already !== undefined) return { ok: false, refused: 'already-member' };
        await db
          .insert(member)
          .values({ id: newId('mem'), organizationId: workspace, userId: id, role, createdAt: new Date(now) });
        await db.insert(admin_actions).values({
          ...actionOf(actor, now, 'member-added', workspace),
          target_account_id: id,
          target_email: String(person.email),
          detail: JSON.stringify({ role }),
        });

        return { ok: true, member: { id, email: String(person.email), role } };
      });
    },

    async setOwner(actor, workspace, email, now) {
      return inWorkspace<OwnerChange>(actor, workspace, async (db, rowsIn) => {
        const [person] = await rowsIn(
          sql`SELECT id, email, (banned IS TRUE) AS suspended FROM "user" WHERE email = ${email}`,
        );
        if (person === undefined) return { ok: false, refused: 'unknown-account' };
        if (person.suspended === true) return { ok: false, refused: 'suspended-account' };
        const id = String(person.id);
        const owner = { id, email: String(person.email) };
        const owners = await rowsIn(
          sql`SELECT m."userId" AS id, u.email FROM member m JOIN "user" u ON u.id = m."userId"
               WHERE m."organizationId" = ${workspace} AND m.role = 'owner' FOR UPDATE OF m`,
        );
        const others = owners.filter((row) => row.id !== id);
        if (others.length === 0 && owners.length === 1) return { ok: true, changed: false, owner, previous: [] };

        const [held] = await rowsIn(
          sql`SELECT role FROM member WHERE "organizationId" = ${workspace} AND "userId" = ${id} FOR UPDATE`,
        );
        if (held === undefined) {
          await db.insert(member).values({
            id: newId('mem'),
            organizationId: workspace,
            userId: id,
            role: 'owner',
            createdAt: new Date(now),
          });
        } else if (held.role !== 'owner') {
          await db
            .update(member)
            .set({ role: 'owner' })
            .where(and(eq(member.organizationId, workspace), eq(member.userId, id)));
          await afterRoleChange(db, workspace, id, String(held.role), 'owner');
        }
        // Each other owner becomes an admin: they keep the workspace and its members, and lose the
        // role of owner only. Nobody is removed, so the change is undone by the same route.
        for (const other of others) {
          await db
            .update(member)
            .set({ role: 'admin' })
            .where(and(eq(member.organizationId, workspace), eq(member.userId, String(other.id))));
        }
        const previous = others.map((other) => String(other.email));
        await db.insert(admin_actions).values({
          ...actionOf(actor, now, 'owner-changed', workspace),
          target_account_id: id,
          target_email: owner.email,
          detail: JSON.stringify({ role: 'owner', previous }),
        });

        return { ok: true, changed: true, owner, previous };
      });
    },

    async invite(actor, workspace, email, role, now) {
      return inWorkspace<AdminInvitation>(actor, workspace, async (db, rowsIn, found) => {
        const [person] = await rowsIn(sql`SELECT id FROM "user" WHERE email = ${email}`);
        if (person !== undefined) {
          const [already] = await rowsIn(
            sql`SELECT 1 AS one FROM member WHERE "organizationId" = ${workspace} AND "userId" = ${String(person.id)}`,
          );

          return { ok: false, refused: already === undefined ? 'has-account' : 'already-member' };
        }
        const [waits] = await rowsIn(
          sql`SELECT 1 AS one FROM invitation
               WHERE "organizationId" = ${workspace} AND email = ${email} AND status = 'pending' AND "expiresAt" > now()`,
        );
        if (waits !== undefined) return { ok: false, refused: 'already-invited' };
        // The row that the plugin writes for an invitation of a member, with the administrator as
        // its inviter: `inviterStillInvites` of `auth-organization.ts` takes it while they are one.
        const kept = { id: newId('inv'), email, role, expiresAt: now + ADMIN_INVITATION_MS };
        await db.insert(invitation).values({
          id: kept.id,
          organizationId: workspace,
          email,
          role,
          status: 'pending',
          expiresAt: new Date(kept.expiresAt),
          createdAt: new Date(now),
          inviterId: actor.id,
        });
        await db.insert(admin_actions).values({
          ...actionOf(actor, now, 'member-invited', workspace),
          target_email: email,
          detail: JSON.stringify({ role }),
        });

        return { ok: true, invitation: kept, workspace: found };
      });
    },

    async noteMailed(id, mailed) {
      // A message that left stays left, as `noteMailed` of `auth-organization.ts` keeps it.
      await run((db) =>
        db
          .update(invitation)
          .set({ mailed })
          .where(and(eq(invitation.id, id), mailed ? sql`TRUE` : sql`${invitation.mailed} IS NOT TRUE`)),
      );
    },

    async createWorkspace(actor, name, email, now) {
      await migrated(database);

      return database.transaction(async (db): Promise<WorkspaceCreation> => {
        const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
        await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);
        const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
        if (asking === undefined) return { ok: false, refused: 'not-admin' };
        const [person] = await rowsIn(
          sql`SELECT id, email, (banned IS TRUE) AS suspended FROM "user" WHERE email = ${email}`,
        );
        if (person === undefined) return { ok: false, refused: 'unknown-account' };
        if (person.suspended === true) return { ok: false, refused: 'suspended-account' };
        const owner = { id: String(person.id), email: String(person.email) };
        // The rows of `createWorkspace` of `accounts-postgres.ts`: a slug that is the id, one owner.
        const workspace = { id: newId('ws'), name };
        const at = new Date(now);
        await db.insert(organization).values({ id: workspace.id, name, slug: workspace.id, createdAt: at });
        await db
          .insert(member)
          .values({ id: newId('mem'), organizationId: workspace.id, userId: owner.id, role: 'owner', createdAt: at });
        await db.insert(admin_actions).values({
          ...actionOf(actor, now, 'workspace-created', workspace.id),
          target_account_id: owner.id,
          target_email: owner.email,
          detail: JSON.stringify({ role: 'owner' }),
        });

        return { ok: true, workspace, owner };
      });
    },

    async deleteAccount(actor, target, email, now, options = {}) {
      await migrated(database);

      return database.transaction(async (db): Promise<AccountDeletion> => {
        const rowsIn = async (statement: SQL): Promise<Row[]> => rowsOf(await db.execute(statement));
        // WARNING: the lock comes before every read, as in `setInstanceAdmin`: a deletion changes who
        // counts as an administrator, so it waits for a change of the role, and the other way.
        await rowsIn(sql`SELECT pg_advisory_xact_lock(${ADMIN_ROLE_LOCK})`);
        const [row] = await rowsIn(
          sql`SELECT email, (${IS_ADMIN}) AS admin FROM "user" WHERE id = ${target} FOR UPDATE`,
        );
        if (row === undefined) return { ok: false, refused: 'unknown-account' };
        if (target === actor.id) return { ok: false, refused: 'self-deletion' };
        if (row.admin === true) {
          const [counted] = await rowsIn(sql`SELECT count(*)::int AS n FROM "user" WHERE ${IS_ADMIN}`);
          if (number(counted?.n) <= 1) return { ok: false, refused: 'last-admin' };
        }
        // After the rule of the last administrator, as in `setInstanceAdmin`: of two administrators
        // who delete each other, the second learns why.
        const [asking] = await rowsIn(sql`SELECT 1 AS one FROM "user" WHERE id = ${actor.id} AND ${IS_ADMIN}`);
        if (asking === undefined) return { ok: false, refused: 'not-admin' };
        if (String(row.email) !== email) return { ok: false, refused: 'email-mismatch' };
        // The memberships of the account are held, then its workspaces, as a write of an administrator
        // holds one (FRU-283): a change of their owners waits, and the count below is the one that
        // holds at the deletion. A route of better-auth that takes the other owner away waits for the
        // commit in the trigger of `0020_workspace_keeps_owner`, and is refused there (FRU-324). The
        // memberships come first, the order of `holdMembers`: a route that removes this account holds
        // its membership, then waits for the workspace in the trigger.
        await rowsIn(sql`SELECT id FROM member WHERE "userId" = ${target} ORDER BY id FOR UPDATE`);
        const workspaces = await rowsIn(
          sql`SELECT o.id, o.name FROM organization o
               WHERE o.id IN (SELECT "organizationId" FROM member WHERE "userId" = ${target})
               ORDER BY o.id FOR UPDATE`,
        );
        const sole = await rowsIn(
          sql`SELECT o.id, o.name FROM member m JOIN organization o ON o.id = m."organizationId"
               WHERE m."userId" = ${target} AND m.role = 'owner'
                 AND NOT EXISTS (SELECT 1 FROM member other
                                  WHERE other."organizationId" = m."organizationId" AND other.role = 'owner'
                                    AND other."userId" <> m."userId")
               ORDER BY o.name, o.id`,
        );
        if (sole.length > 0) {
          return {
            ok: false,
            refused: 'sole-owner',
            workspaces: sole.map((each) => ({ id: String(each.id), name: String(each.name) })),
          };
        }

        // A check alone stops here, and the transaction writes nothing.
        if (options.check === true) {
          return {
            ok: true,
            account: { id: target, email: String(row.email) },
            workspaces: workspaces.map((workspace) => ({ id: String(workspace.id), name: String(workspace.name) })),
          };
        }
        // The owners of each workspace of the account read the action, written before the row goes:
        // `target_account_id` empties with the account, and `target_email` keeps who it was.
        const each = (workspace: string | null) => ({
          id: newId('ada'),
          at: now,
          actor_account_id: actor.id,
          actor_email: actor.email,
          action: 'account-deleted' as const,
          target_account_id: target,
          target_email: String(row.email),
          workspace_id: workspace,
        });
        await db
          .insert(admin_actions)
          .values(workspaces.length === 0 ? [each(null)] : workspaces.map((workspace) => each(String(workspace.id))));
        // The foreign keys take its sessions of the console, its ways to sign in, its memberships, the
        // invitations it made and the sites shared with it. A note keeps its text and the name in it,
        // and its row in the index forgets the account (`ON DELETE SET NULL`).
        await db.delete(user).where(eq(user.id, target));

        return {
          ok: true,
          account: { id: target, email: String(row.email) },
          workspaces: workspaces.map((workspace) => ({ id: String(workspace.id), name: String(workspace.name) })),
        };
      });
    },

    async actionsIn(workspace) {
      const actor = alias(user, 'actor');
      const target = alias(user, 'target');
      const rows = await run((db) =>
        db
          .select({
            action: admin_actions.action,
            at: admin_actions.at,
            actor_email: admin_actions.actor_email,
            actor_now: actor.email,
            actor_name: actor.name,
            target_email: admin_actions.target_email,
            target_now: target.email,
            target_name: target.name,
            detail: admin_actions.detail,
          })
          .from(admin_actions)
          .leftJoin(actor, eq(actor.id, admin_actions.actor_account_id))
          .leftJoin(target, eq(target.id, admin_actions.target_account_id))
          .where(eq(admin_actions.workspace_id, workspace))
          .orderBy(desc(admin_actions.at), asc(admin_actions.id))
          .limit(ACTIONS_SHOWN),
      );

      return rows.flatMap((row): TracedAction[] => {
        if (!(ADMIN_ACTIONS as readonly string[]).includes(row.action)) return [];
        const admin = { email: row.actor_now ?? row.actor_email, ...named(row.actor_name) };
        // An action on the workspace (FRU-282) has no member as its target. Its owners read who and
        // when, and not the reason (FRU-328): a note of the administrator, which `actions` answers.
        if (isWorkspaceAction(row.action)) return [{ action: row.action, at: iso(row.at), admin }];
        const targetEmail = row.target_now ?? row.target_email;
        if (targetEmail === null) return [];

        return [
          {
            action: row.action as Exclude<AdminActionKind, WorkspaceActionKind>,
            at: iso(row.at),
            admin,
            target: { email: targetEmail, ...named(row.target_name) },
            ...roleIn(row.detail),
          },
        ];
      });
    },

    async actions(kind) {
      const actor = alias(user, 'actor');
      const target = alias(user, 'target');
      const rows = await run((db) =>
        db
          .select({
            action: admin_actions.action,
            at: admin_actions.at,
            actor_id: admin_actions.actor_account_id,
            actor_email: admin_actions.actor_email,
            actor_now: actor.email,
            actor_name: actor.name,
            target_id: admin_actions.target_account_id,
            target_email: admin_actions.target_email,
            target_now: target.email,
            target_name: target.name,
            workspace_id: admin_actions.workspace_id,
            workspace_name: organization.name,
            detail: admin_actions.detail,
          })
          .from(admin_actions)
          .leftJoin(actor, eq(actor.id, admin_actions.actor_account_id))
          .leftJoin(target, eq(target.id, admin_actions.target_account_id))
          .leftJoin(organization, eq(organization.id, admin_actions.workspace_id))
          .where(kind === undefined ? undefined : eq(admin_actions.action, kind))
          .orderBy(desc(admin_actions.at), asc(admin_actions.id))
          .limit(ACTIONS_SHOWN),
      );

      return rows.flatMap((row): AdminAction[] => {
        if (!(ADMIN_ACTIONS as readonly string[]).includes(row.action)) return [];
        const targetEmail = row.target_now ?? row.target_email;
        const detail = detailOf(row.detail);

        return [
          {
            action: row.action as AdminActionKind,
            at: iso(row.at),
            actor: {
              ...(row.actor_id === null ? {} : { id: row.actor_id }),
              email: row.actor_now ?? row.actor_email,
              ...named(row.actor_name),
            },
            ...(targetEmail === null
              ? {}
              : {
                  target: {
                    ...(row.target_id === null ? {} : { id: row.target_id }),
                    email: targetEmail,
                    ...named(row.target_name),
                  },
                }),
            ...(row.workspace_id === null || row.workspace_name === null
              ? deletedIn(row.action === 'workspace-deleted' ? detail : undefined)
              : { workspace: { id: row.workspace_id, name: row.workspace_name } }),
            ...(detail === undefined ? {} : { detail }),
          },
        ];
      });
    },
  };
}
