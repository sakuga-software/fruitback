import { STAGES } from '../stages';
import { type AdminConnector, type AdminWorkspace, type StageCounts, type WorkspaceSuspension } from '../api';
import { msg, t } from '../i18n';
import { StatusBar } from '../ui';
import { useLocale } from '../use-locale';
import { kindName } from './connector-parts';

// What a row and the panel of « Workspaces » of the administrator say of a workspace (FRU-263, FRU-614).

export const ROLES: Readonly<Record<string, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

/** « 6 people · 3 sites ». */
export function sizeOf(workspace: AdminWorkspace): string {
  const people = workspace.members === 1 ? t('1 person') : t('{count} people', { count: workspace.members });
  const sites = workspace.sites === 1 ? t('1 site') : t('{count} sites', { count: workspace.sites });

  return `${people} · ${sites}`;
}

export function ownersOf(workspace: { owners: readonly { email: string }[] }): string {
  return workspace.owners.map((owner) => owner.email).join(', ');
}

/** The name of a kind of connector: « Linear », « REST API ». */
export function kindOf(connector: AdminConnector): string {
  const kind = kindName(connector.kind);

  return kind === undefined ? connector.label : t(kind);
}

/** Where the notes of a workspace go: its connectors, or Fruitback itself. */
export function goesTo(destinations: readonly AdminConnector[]): string {
  if (destinations.length === 0) return t('Kept in Fruitback');

  return [...new Set(destinations.map(kindOf))].join(', ');
}

function totalOf(notes: StageCounts): number {
  return STAGES.reduce((sum, stage) => sum + (notes[stage] ?? 0), 0);
}

/** How many notes a workspace has, and a bar of their statuses that the words say again. */
export function Notes({ notes }: { notes: StageCounts }) {
  useLocale();
  const count = (stage: (typeof STAGES)[number]) => notes[stage] ?? 0;
  const values = {
    count: totalOf(notes),
    new: count('new'),
    todo: count('todo'),
    progress: count('progress'),
    done: count('done'),
    closed: count('closed'),
  };
  const label =
    values.count === 1
      ? t('1 note: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values)
      : t('{count} notes: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values);

  return (
    <span className="flex items-center gap-[10px]">
      <span aria-hidden="true" className="w-[28px] flex-none text-right font-semibold tabular-nums">
        {values.count}
      </span>
      <StatusBar
        width="short"
        label={label}
        counts={{
          new: values.new,
          todo: values.todo,
          progress: values.progress,
          done: values.done,
          closed: values.closed,
        }}
      />
    </span>
  );
}

/** The notes that did not leave, or a connector that needs somebody. */
function undelivered(count: number): string {
  return count === 1 ? t('1 note not delivered') : t('{count} notes not delivered', { count });
}

function troubleOf(workspace: AdminWorkspace): string | undefined {
  if (workspace.pendingDeliveries > 0) return undelivered(workspace.pendingDeliveries);
  if (workspace.destinations.some((connector) => connector.attention !== undefined)) return t('Needs attention');

  return undefined;
}

/**
 * The trouble of a row. On the chosen row the red is the strong accent: the accent is 4.28:1 on
 * the tint of the row.
 */
export function Alert({ workspace, chosen }: { workspace: AdminWorkspace; chosen: boolean }) {
  useLocale();
  const words = troubleOf(workspace);
  if (words === undefined) return null;

  return (
    <span className={`block text-hint font-semibold ${chosen ? 'text-accent-strong' : 'text-accent'}`}>{words}</span>
  );
}

/** The three fields of a suspension taken out, so that the state of an answer replaces them all. */
export function withoutSuspension<T extends WorkspaceSuspension>(each: T): T {
  const { suspended: _suspended, suspendedAt: _at, reason: _reason, ...rest } = each;

  return rest as T;
}
