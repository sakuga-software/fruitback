import {
  type Account,
  CONNECTOR_KINDS,
  CONNECTOR_TROUBLES,
  type Connector,
  type ConnectorKind,
  type ConnectorSettings,
  type ConnectorTrouble,
  type Destination,
  type Domain,
  type DueDelivery,
  type PendingDelivery,
  ROLES,
  type Role,
  type Site,
  VISIBILITIES,
  type Visibility,
  type Workspace,
  DEFAULT_CONNECTOR_SETTINGS,
  readConnectorSettings,
} from './accounts.ts';

/**
 * A row of the accounts as the worker reads it, whatever database answered it (FRU-141).
 *
 * `accounts-sqlite.ts` and `accounts-postgres.ts` name their columns alike, so one parser reads
 * both. An instant is a number of milliseconds in both: the PostgreSQL adapter answers a `BIGINT` as
 * a number.
 */

/** An opaque id with a prefix that says what it names, so a log line can be read. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** A row is parsed, never trusted: an operator can edit it, and a restore can be older than the code. */
export function accountOf(row: Record<string, unknown> | undefined): Account | undefined {
  if (row === undefined || typeof row.id !== 'string' || typeof row.email !== 'string') return undefined;

  return {
    id: row.id,
    email: row.email,
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    ...(typeof row.locale === 'string' && row.locale !== '' ? { locale: row.locale } : {}),
  };
}

export function workspaceOf(row: Record<string, unknown>): Workspace | undefined {
  return typeof row.id === 'string' && typeof row.name === 'string' ? { id: row.id, name: row.name } : undefined;
}

export function roleOf(value: unknown): Role | undefined {
  return (ROLES as readonly unknown[]).includes(value) ? (value as Role) : undefined;
}

export function siteOf(row: Record<string, unknown>, destinations: Destination[]): Site | undefined {
  const visibility = (VISIBILITIES as readonly unknown[]).includes(row.visibility)
    ? (row.visibility as Visibility)
    : undefined;
  if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.origin !== 'string') {
    return undefined;
  }
  if (visibility === undefined) return undefined;

  return { id: row.id, workspaceId: row.workspace_id, origin: row.origin, visibility, destinations };
}

export const SITE_COLUMNS = 'id, workspace_id, origin, visibility';

export const DOMAIN_COLUMNS =
  'id, workspace_id, domain, created_at, verified_at, lost_at, checked_at, previews_site_id';

/** A row is parsed, never trusted. An instant that is not a number is an instant that is not there. */
export function domainOf(row: Record<string, unknown> | undefined): Domain | undefined {
  if (row === undefined) return undefined;
  if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.domain !== 'string') {
    return undefined;
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    createdAt: typeof row.created_at === 'number' ? row.created_at : 0,
    ...(typeof row.verified_at === 'number' ? { verifiedAt: row.verified_at } : {}),
    ...(typeof row.lost_at === 'number' ? { lostAt: row.lost_at } : {}),
    ...(typeof row.checked_at === 'number' ? { checkedAt: row.checked_at } : {}),
    ...(typeof row.previews_site_id === 'string' && row.previews_site_id !== ''
      ? { previewsSite: row.previews_site_id }
      : {}),
  };
}

/** A row is parsed, never trusted. A row with no connector is no destination. */
export function destinationOf(row: Record<string, unknown>): Destination | undefined {
  if (typeof row.connector_id !== 'string') return undefined;

  return {
    connector: row.connector_id,
    ...(typeof row.team_id === 'string' && row.team_id !== '' ? { teamId: row.team_id } : {}),
    ...(typeof row.project_id === 'string' && row.project_id !== '' ? { projectId: row.project_id } : {}),
    ...(typeof row.label === 'string' && row.label !== '' ? { label: row.label } : {}),
  };
}

/**
 * The settings a row holds. A row that is not settings reads as the defaults, field by field: an
 * operator who edits the column by hand loses the entry they broke, not the switch beside it.
 */
export function connectorSettingsOf(value: unknown): ConnectorSettings {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONNECTOR_SETTINGS;
  const { showComments, stages } = parsed as Record<string, unknown>;
  // Entry by entry: one entry that is not an exception does not take the others with it.
  const entries = typeof stages === 'object' && stages !== null ? Object.entries(stages) : [];
  const kept = Object.fromEntries(
    entries.filter(([state, stage]) => readConnectorSettings({ stages: { [state]: stage } }) !== undefined),
  ) as ConnectorSettings['stages'];

  return { showComments: typeof showComments === 'boolean' ? showComments : true, stages: kept };
}

export function connectorOf(row: Record<string, unknown> | undefined): Connector | undefined {
  const kind = (CONNECTOR_KINDS as readonly unknown[]).includes(row?.kind) ? (row?.kind as ConnectorKind) : undefined;
  if (row === undefined || kind === undefined) return undefined;
  if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.label !== 'string') {
    return undefined;
  }
  // A word this build does not know is no trouble it can explain: the connector reads as working.
  const reason = (CONNECTOR_TROUBLES as readonly unknown[]).includes(row.attention)
    ? (row.attention as ConnectorTrouble)
    : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind,
    label: row.label,
    createdAt: new Date(typeof row.created_at === 'number' ? row.created_at : 0).toISOString(),
    settings: connectorSettingsOf(row.settings),
    ...(reason === undefined
      ? {}
      : {
          attention: {
            reason,
            since: new Date(typeof row.attention_at === 'number' ? row.attention_at : 0).toISOString(),
          },
        }),
  };
}

export function dueDeliveryOf(row: Record<string, unknown>): DueDelivery | undefined {
  if (typeof row.id !== 'string' || typeof row.connector_id !== 'string' || typeof row.body !== 'string') {
    return undefined;
  }

  return {
    id: row.id,
    connectorId: row.connector_id,
    body: row.body,
    attempts: typeof row.attempts === 'number' ? row.attempts : 0,
  };
}

export function pendingDeliveryOf(row: Record<string, unknown>): PendingDelivery | undefined {
  if (typeof row.id !== 'string') return undefined;

  return {
    id: row.id,
    createdAt: new Date(typeof row.created_at === 'number' ? row.created_at : 0).toISOString(),
    attempts: typeof row.attempts === 'number' ? row.attempts : 0,
    ...(typeof row.next_at === 'number' ? { nextAt: new Date(row.next_at).toISOString() } : {}),
    ...(typeof row.last_status === 'number' ? { lastStatus: row.last_status } : {}),
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
  };
}
