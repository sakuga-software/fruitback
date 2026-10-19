import { Fragment, useCallback, useRef } from 'react';
import {
  type AdminConnector,
  type AdminWorkspace,
  type AdminWorkspaceDetail,
  STAGES,
  type StageCounts,
  adminWorkspace,
  adminWorkspaces,
} from '../api';
import { msg, t } from '../i18n';
import { Button, DataTable, LinkButton, PageHead, Problem, StatusBar } from '../ui';
import { useLocale } from '../use-locale';
import { useWide } from '../wide';
import { dayOf } from './admin-instance';
import {
  AdminPanel,
  Cut,
  ListBar,
  NoRows,
  PanelRows,
  PanelSection,
  RowLink,
  UnderRow,
  rowId,
  useListAddress,
  useRead,
} from './admin-list';
import { KINDS } from './connector-parts';

/**
 * The workspaces of the instance, as screen 18 of the mockup of 2026-10-13 draws them (FRU-263),
 * read-only: who owns each one, its notes, and where they go. The actions of the mockup on a
 * workspace come with FRU-274, so the screen has no button that changes a workspace.
 *
 * WARNING: each read writes a trace in each workspace of the answer that the administrator is not a
 * member of (FRU-261). The panel reads its workspace again, and leaves one more trace there.
 */

/** The filters of the worker (`WORKSPACE_FILTERS`). The mockup's « Suspended » comes with FRU-274. */
const SHOW = [
  { value: 'all', label: msg('All workspaces') },
  { value: 'attention', label: msg('Needs a look') },
  { value: 'empty', label: msg('No site yet') },
] as const;

const ROLES: Readonly<Record<string, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

type Listed = { workspaces: AdminWorkspace[]; total: number };

/** The read of one workspace, with the id it answers, so that a panel never shows another one. */
type Read = { id: string; detail: AdminWorkspaceDetail | 'failed' } | 'none';

export default function AdminWorkspaces() {
  useLocale();
  const { q, show, open, typed, setTyped, change, openTo } = useListAddress();
  const wide = useWide();
  // Whether the panel that is about to appear was opened by a press of its row (FRU-197).
  const opening = useRef(false);

  const ask = useCallback(async (): Promise<Listed | 'failed'> => {
    const answer = await adminWorkspaces({ q, show });

    return answer.ok && Array.isArray(answer.data?.workspaces) ? answer.data : 'failed';
  }, [q, show]);
  const { shown, again } = useRead(ask);

  const rows = typeof shown === 'object' ? shown.workspaces : [];
  const chosen = rows.find((workspace) => workspace.id === open);
  // The page reads the chosen workspace, not its panel, and reads each one once: the panel moves
  // between two places at 1280 px, and each read leaves a trace with the owners.
  const chosenId = chosen?.id ?? '';
  const known = useRef(new Map<string, AdminWorkspaceDetail>());
  const askDetail = useCallback(async (): Promise<Read> => {
    if (chosenId === '') return 'none';
    const kept = known.current.get(chosenId);
    if (kept !== undefined) return { id: chosenId, detail: kept };
    const answer = await adminWorkspace(chosenId);
    if (!answer.ok || !Array.isArray(answer.data?.members)) return { id: chosenId, detail: 'failed' };
    known.current.set(chosenId, answer.data);

    return { id: chosenId, detail: answer.data };
  }, [chosenId]);
  const { shown: read, again: readAgain } = useRead(askDetail);
  const detail = typeof read === 'object' && read.id === chosenId ? read.detail : 'loading';
  const close = () => {
    change({ open: '' }, true);
    if (chosen !== undefined) document.getElementById(rowId(chosen.id))?.focus();
  };
  const panel =
    chosen === undefined ? null : (
      <Panel
        key={chosen.id}
        workspace={chosen}
        detail={detail}
        onRetry={readAgain}
        wide={wide}
        takesFocus={opening}
        onClose={close}
      />
    );

  return (
    <>
      <PageHead
        title={t('Workspaces')}
        lead={t('Every workspace on this instance, who owns it and where its notes go.')}
        className="mb-[8px]"
      />
      <p className="mb-[24px] max-w-[64ch] text-small text-muted">
        {t('The owners of each workspace see that you read its list, with your address and the day.')}
      </p>
      <ListBar
        label={t('Search workspaces')}
        placeholder={t('Search by name or owner')}
        typed={typed}
        onType={setTyped}
        show={show}
        onShow={(chosenShow) => change({ show: chosenShow })}
        options={SHOW.map((option) => ({ value: option.value, label: t(option.label) }))}
      />

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {shown === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('The workspaces could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={again}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof shown === 'object' && rows.length === 0 ? (
        <NoRows
          filtered={q !== '' || show !== 'all'}
          empty={t('No workspace on this instance yet.')}
          noMatch={t('No workspace matches this search.')}
          onClear={() => {
            setTyped('');
            change({ q: '', show: 'all', open: '' });
          }}
        />
      ) : null}

      {typeof shown === 'object' && rows.length > 0 ? (
        <div className="flex flex-wrap items-start gap-[28px]">
          <div className="min-w-0 flex-[999_1_560px]">
            <DataTable label={t('Workspaces of the instance')} minWidth={680} hover>
              <thead>
                <tr>
                  <th scope="col">{t('Workspace')}</th>
                  <th scope="col">{t('Owner')}</th>
                  <th scope="col">{t('Notes')}</th>
                  <th scope="col">{t('Notes go to')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((workspace) => {
                  const isChosen = workspace.id === chosen?.id;

                  return (
                    <Fragment key={workspace.id}>
                      <tr data-chosen={isChosen}>
                        <td>
                          <RowLink
                            id={workspace.id}
                            to={openTo(workspace.id)}
                            chosen={isChosen}
                            onOpen={() => (opening.current = true)}
                          >
                            {workspace.name}
                          </RowLink>
                          <span className="block text-hint text-muted tabular-nums">{sizeOf(workspace)}</span>
                        </td>
                        <td className="[overflow-wrap:anywhere]">{ownersOf(workspace)}</td>
                        <td>
                          <Notes notes={workspace.notes} />
                        </td>
                        <td>
                          <span className="block">{goesTo(workspace.destinations)}</span>
                          <Alert workspace={workspace} chosen={isChosen} />
                        </td>
                      </tr>
                      {!wide && isChosen ? <UnderRow columns={4}>{panel}</UnderRow> : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </DataTable>
            <Cut
              shown={rows.length}
              total={shown.total}
              sentence={t('The first {count} of {total} workspaces.', { count: rows.length, total: shown.total })}
            />
          </div>
          {wide ? panel : null}
        </div>
      ) : null}
    </>
  );
}

/** « 6 people · 3 sites ». */
function sizeOf(workspace: AdminWorkspace): string {
  const people = workspace.members === 1 ? t('1 person') : t('{count} people', { count: workspace.members });
  const sites = workspace.sites === 1 ? t('1 site') : t('{count} sites', { count: workspace.sites });

  return `${people} · ${sites}`;
}

function ownersOf(workspace: { owners: readonly { email: string }[] }): string {
  return workspace.owners.map((owner) => owner.email).join(', ');
}

/** The name of a kind of connector: « Linear », « REST API ». */
function kindOf(connector: AdminConnector): string {
  const kind = KINDS[connector.kind as keyof typeof KINDS];

  return kind === undefined ? connector.label : t(kind.name);
}

/** Where the notes of a workspace go: its connectors, or Fruitback itself. */
function goesTo(destinations: readonly AdminConnector[]): string {
  if (destinations.length === 0) return t('Kept in Fruitback');

  return [...new Set(destinations.map(kindOf))].join(', ');
}

function totalOf(notes: StageCounts): number {
  return STAGES.reduce((sum, stage) => sum + (notes[stage] ?? 0), 0);
}

/** How many notes a workspace has, and a bar of their statuses that the words say again. */
function Notes({ notes }: { notes: StageCounts }) {
  useLocale();
  const count = (stage: (typeof STAGES)[number]) => notes[stage] ?? 0;
  const values = {
    count: totalOf(notes),
    new: count('seeded'),
    todo: count('green'),
    progress: count('ripening'),
    done: count('ripe'),
    closed: count('composted'),
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
function Alert({ workspace, chosen }: { workspace: AdminWorkspace; chosen: boolean }) {
  useLocale();
  const words = troubleOf(workspace);
  if (words === undefined) return null;

  return (
    <span className={`block text-hint font-semibold ${chosen ? 'text-accent-strong' : 'text-accent'}`}>{words}</span>
  );
}

/**
 * The panel of a workspace: where its notes go, its people and its sites. Its head is the row, so it
 * shows at once; the rest is the read of the workspace, which the page does.
 */
function Panel({
  workspace,
  detail,
  onRetry,
  wide,
  takesFocus,
  onClose,
}: {
  workspace: AdminWorkspace;
  detail: AdminWorkspaceDetail | 'loading' | 'failed';
  onRetry: () => void;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
}) {
  useLocale();
  const owners = ownersOf(workspace);

  return (
    <AdminPanel
      wide={wide}
      takesFocus={takesFocus}
      onClose={onClose}
      title={workspace.name}
      detail={
        owners === ''
          ? t('Created {day}', { day: dayOf(workspace.createdAt) })
          : t('Owned by {owner} · created {day}', { owner: owners, day: dayOf(workspace.createdAt) })
      }
    >
      {detail === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {detail === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('This workspace could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={onRetry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof detail === 'object' ? <Detail workspace={detail} /> : null}
    </AdminPanel>
  );
}

function Detail({ workspace }: { workspace: AdminWorkspaceDetail }) {
  useLocale();
  const owners = workspace.members.filter((member) => member.role === 'owner');
  const manage = owners[0] === undefined ? '/admin/users' : `/admin/users?q=${encodeURIComponent(owners[0].email)}`;

  return (
    <>
      <PanelSection title={t('Where notes go')}>
        <div className="flex flex-col gap-[8px] text-small">
          {workspace.destinations.length === 0 ? <p>{t('Kept in Fruitback')}</p> : null}
          {workspace.destinations.map((connector) => (
            <p key={connector.id} className="[overflow-wrap:anywhere]">
              <span className="font-semibold">{kindOf(connector)}</span>{' '}
              <span className="text-muted">{connector.label}</span>
              {connector.attention === undefined ? null : (
                <span className="block text-hint font-semibold text-accent-strong">{t('Needs attention')}</span>
              )}
            </p>
          ))}
          {workspace.pendingDeliveries > 0 ? (
            <p className="text-hint font-semibold text-accent-strong">
              {workspace.pendingDeliveries === 1
                ? t('1 note not delivered.')
                : t('{count} notes not delivered.', { count: workspace.pendingDeliveries })}
            </p>
          ) : null}
          <div>
            <LinkButton to={`/admin/notes?workspace=${encodeURIComponent(workspace.id)}`}>
              {t('See the notes')}
            </LinkButton>
          </div>
        </div>
      </PanelSection>

      <PanelSection title={t('People · {count}', { count: workspace.members.length })}>
        <PanelRows
          rows={workspace.members.map((member) => ({
            key: member.id,
            name: member.name ?? member.email,
            value: ROLES[member.role] === undefined ? member.role : t(ROLES[member.role] as string),
          }))}
        />
        <div className="mt-[2px]">
          <LinkButton to={manage}>{t('Manage in Users')}</LinkButton>
        </div>
      </PanelSection>

      <PanelSection title={t('Sites · {count}', { count: workspace.sites.length })}>
        <PanelRows
          rows={workspace.sites.map((site) => ({
            key: site.id,
            name: <span className="font-semibold">{site.origin.replace(/^https?:\/\//, '')}</span>,
            value:
              site.visibility === 'everyone'
                ? t('Everyone who visits')
                : t('Members of {workspace}', { workspace: workspace.name }),
          }))}
        />
      </PanelSection>

      <PanelSection title={t('Owner')}>
        {owners.length === 0 ? <p className="text-small text-muted">{t('No owner')}</p> : null}
        {owners.map((owner) => (
          <p key={owner.id} className="text-small [overflow-wrap:anywhere]">
            {owner.name === undefined ? owner.email : `${owner.name}, ${owner.email}`}
          </p>
        ))}
      </PanelSection>
    </>
  );
}
