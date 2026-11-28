import { isOneOf } from './one-of.ts';
import {
  type Account,
  type AgentTrigger,
  CONNECTOR_KINDS,
  CONNECTOR_TROUBLES,
  type Connector,
  type ConnectorSettings,
  type ConnectorTrouble,
  DELIVERY_EVENTS,
  DESTINATION_TROUBLES,
  type Destination,
  type DestinationTrouble,
  type Domain,
  type DueDelivery,
  type PendingDelivery,
  ROLES,
  type SavedView,
  type Role,
  type Site,
  VISIBILITIES,
  VISITOR_RIGHTS,
  type VisitorRight,
  DEFAULT_DELETED_NOTE_KEEP,
  DEFAULT_VISITOR_NOTES_PER_HOUR,
  DELETED_NOTE_KEEPS,
  type DeletedNoteKeep,
  VISITOR_NOTE_LIMITS,
  type VisitorNoteLimit,
  type Visibility,
  WRITERS,
  type Workspace,
  type Writers,
  DEFAULT_CONNECTOR_SETTINGS,
  readConnectorSettings,
} from './accounts.ts';

/**
 * A row of the accounts as the worker reads it, whatever database answered it (FRU-141).
 *
 * The columns have the names of the SQLite file of before. An instant is a number of milliseconds: the
 * PostgreSQL adapter answers a `BIGINT` as a number.
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
    ...(row.banned === true ? { suspended: true as const } : {}),
  };
}

export function workspaceOf(row: Record<string, unknown>): Workspace | undefined {
  return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.slug === 'string'
    ? { id: row.id, name: row.name, slug: row.slug }
    : undefined;
}

export function roleOf(value: unknown): Role | undefined {
  return isOneOf(value, ROLES) ? value : undefined;
}

export function siteOf(row: Record<string, unknown>, destinations: Destination[]): Site | undefined {
  const visibility = isOneOf(row.visibility, VISIBILITIES) ? (row.visibility as Visibility) : undefined;
  if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.origin !== 'string') {
    return undefined;
  }
  if (visibility === undefined) return undefined;
  // A value that is not one of the two is no site, as for the visibility: it opens nothing (FRU-330).
  if (!isOneOf(row.writers, WRITERS)) return undefined;
  const writers = row.writers as Writers;

  // FRU-604: anything but `true` is off, the default: a site offers no e-mail it did not say it offers.
  const notifyDone = row.notify_done === true;
  // FRU-703: a value that is not one of the three gives nothing to a visitor, as for `writers`.
  const visitorEdit: VisitorRight = isOneOf(row.visitor_edit, VISITOR_RIGHTS) ? row.visitor_edit : 'never';
  const visitorDelete: VisitorRight = isOneOf(row.visitor_delete, VISITOR_RIGHTS) ? row.visitor_delete : 'never';
  // FRU-704: a value that is not one of the list is the default, never « No limit ».
  const visitorNotesPerHour: VisitorNoteLimit = isOneOf(row.visitor_notes_per_hour, VISITOR_NOTE_LIMITS)
    ? row.visitor_notes_per_hour
    : DEFAULT_VISITOR_NOTES_PER_HOUR;
  // FRU-704: anything but `true` is off, the default, as `notify_done`.
  const holdVisitorNotes = row.hold_visitor_notes === true;
  // FRU-704: anything but `false` is on, the default of the column, as the mockup draws it.
  const keepNoteVersions = row.keep_note_versions !== false;
  // FRU-704: a value that is not one of the list is the default, never a shorter one.
  const deletedNotesKeepDays: DeletedNoteKeep = isOneOf(row.deleted_notes_keep_days, DELETED_NOTE_KEEPS)
    ? row.deleted_notes_keep_days
    : DEFAULT_DELETED_NOTE_KEEP;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    origin: row.origin,
    visibility,
    writers,
    notifyDone,
    visitorEdit,
    visitorDelete,
    visitorNotesPerHour,
    holdVisitorNotes,
    keepNoteVersions,
    deletedNotesKeepDays,
    destinations,
  };
}

/**
 * A view of a person (FRU-723). A row is parsed, never trusted: filters that are not an object of
 * texts are no view, and the console never shows it.
 */
export function savedViewOf(row: Record<string, unknown> | undefined): SavedView | undefined {
  if (row === undefined || typeof row.id !== 'string' || typeof row.name !== 'string') return undefined;
  if (typeof row.filters !== 'string') return undefined;
  let filters: unknown;
  try {
    filters = JSON.parse(row.filters);
  } catch {
    return undefined;
  }
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) return undefined;
  if (!Object.values(filters).every((value) => typeof value === 'string')) return undefined;

  return {
    id: row.id,
    name: row.name,
    filters: filters as Record<string, string>,
    createdAt: typeof row.created_at === 'number' ? row.created_at : 0,
  };
}

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
    ...(typeof row.private === 'boolean' ? { private: row.private } : {}),
    // FRU-574: only an address of Linear is read back, whatever an operator wrote in the column.
    ...(typeof row.url === 'string' && row.url.startsWith('https://linear.app/') ? { url: row.url } : {}),
    // A word this build does not know is no trouble it can explain: the destination reads as working.
    ...(isOneOf(row.attention, DESTINATION_TROUBLES)
      ? {
          attention: {
            reason: row.attention as DestinationTrouble,
            since: new Date(typeof row.attention_at === 'number' ? row.attention_at : 0).toISOString(),
          },
        }
      : {}),
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
  const kind = isOneOf(row?.kind, CONNECTOR_KINDS) ? row?.kind : undefined;
  if (row === undefined || kind === undefined) return undefined;
  if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.label !== 'string') {
    return undefined;
  }
  // A word this build does not know is no trouble it can explain: the connector reads as working.
  const reason = isOneOf(row.attention, CONNECTOR_TROUBLES) ? (row.attention as ConnectorTrouble) : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind,
    label: row.label,
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    createdAt: new Date(typeof row.created_at === 'number' ? row.created_at : 0).toISOString(),
    settings: connectorSettingsOf(row.settings),
    // FRU-714: read by `connectors` only. A read that does not select it says no delivery.
    ...(typeof row.delivered_at === 'number' ? { deliveredAt: new Date(row.delivered_at).toISOString() } : {}),
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
    // FRU-605, FRU-660: another event than a note; `note.created` stays absent, as from a worker of before.
    ...(isOneOf(row.event, DELIVERY_EVENTS) && row.event !== 'note.created' ? { event: row.event } : {}),
    createdAt: new Date(typeof row.created_at === 'number' ? row.created_at : 0).toISOString(),
    attempts: typeof row.attempts === 'number' ? row.attempts : 0,
    ...(typeof row.next_at === 'number' ? { nextAt: new Date(row.next_at).toISOString() } : {}),
    ...(typeof row.last_status === 'number' ? { lastStatus: row.last_status } : {}),
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
  };
}

/** A row of `site_agent_triggers` (FRU-468). A moment the worker does not know reads as the default. */
export function agentTriggerOf(row: {
  connector_id: string;
  moment: string;
  enabled: boolean;
}): Omit<AgentTrigger, 'waiting'> {
  return {
    connector: row.connector_id,
    moment: row.moment === 'moved-to-todo' ? 'moved-to-todo' : 'verified-note',
    enabled: row.enabled,
  };
}
