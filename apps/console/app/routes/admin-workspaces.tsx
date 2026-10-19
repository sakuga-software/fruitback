import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AdminConnector,
  type AdminWorkspace,
  type AdminWorkspaceDetail,
  STAGES,
  type StageCounts,
  adminWorkspace,
  adminWorkspaces,
  deleteWorkspaceAsAdmin,
} from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, DataTable, Field, LinkButton, PageHead, Problem, StatusBar } from '../ui';
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
 * The workspaces of the instance, as screen 18 of the mockup of 2026-10-13 draws them (FRU-263):
 * who owns each one, its notes, and where they go. « Delete the workspace » in the foot of a panel
 * deletes it after its name is typed (FRU-284). The other actions of the mockup come with FRU-274.
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
  // The name of the workspace that was just deleted: the page says it, where its row was.
  const [deleted, setDeleted] = useState<string | undefined>();
  const said = useRef<HTMLParagraphElement>(null);
  // Focus goes to the sentence: the panel and the button that had it are gone.
  useEffect(() => {
    if (deleted !== undefined) said.current?.focus();
  }, [deleted]);

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
        onDeleted={(name) => {
          known.current.delete(chosen.id);
          setDeleted(name);
          change({ open: '' }, true);
          again();
        }}
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
      {deleted === undefined ? null : (
        <p role="status" tabIndex={-1} ref={said} className="mb-[16px] text-small font-semibold">
          {t('{workspace} was deleted. Every instance admin reads it on the page Instance.', { workspace: deleted })}
        </p>
      )}
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
  onDeleted,
}: {
  workspace: AdminWorkspace;
  detail: AdminWorkspaceDetail | 'loading' | 'failed';
  onRetry: () => void;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  useLocale();
  const owners = ownersOf(workspace);

  return (
    <AdminPanel
      wide={wide}
      takesFocus={takesFocus}
      onClose={onClose}
      foot={<Deletion workspace={workspace} onDeleted={onDeleted} />}
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

/** What the worker refuses when a workspace is deleted (FRU-284). */
const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  'name-mismatch': msg('This is not the name of the workspace. Type it as it is written, capitals included.'),
  'not-found': msg('This workspace no longer exists. Another admin or its owner may have deleted it.'),
};
const NOT_DELETED = msg('The workspace was not deleted. Try again.');

/**
 * « Delete the workspace » (FRU-284), in the foot of the panel. It cannot be undone, so it asks for
 * the name of the workspace, as the worker does: the button that deletes stays held until the name
 * is typed as it is written. The confirmation says what goes and what stays in the tracker. « Keep
 * it » and Escape put the first button back, with focus on it, and send nothing.
 */
function Deletion({ workspace, onDeleted }: { workspace: AdminWorkspace; onDeleted: (name: string) => void }) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // A second press of the button that deletes comes before React draws the first one as busy.
  const sending = useRef(false);
  const back = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const name = workspace.name;
  const matches = typed.trim() === name;

  // The confirmation is in the foot of the panel, and can appear under the screen on a phone.
  useEffect(() => {
    if (asking || problem !== undefined) box.current?.scrollIntoView({ block: 'nearest' });
  }, [asking, problem]);

  useEffect(() => {
    if (!back.current || asking) return;
    back.current = false;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [asking]);

  const keep = () => {
    back.current = true;
    setTyped('');
    setProblem(undefined);
    setAsking(false);
  };

  async function send() {
    if (sending.current || !matches) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    const answer = await deleteWorkspaceAsAdmin(workspace.id, typed.trim());
    sending.current = false;
    setBusy(false);
    // The typed name stays after a refusal: the person corrects it, and does not type it again.
    if (answer.ok) onDeleted(answer.data.workspace.name);
    else setProblem(problemOf(answer, DELETION_PROBLEMS, NOT_DELETED));
  }

  return (
    <div ref={box} className="flex w-full flex-col gap-[10px] text-small">
      {asking ? (
        <div
          role="group"
          aria-label={t('Delete {workspace}', { workspace: name })}
          className="flex flex-col gap-[10px]"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // The panel closes on Escape too: this one only steps back from the deletion.
            event.preventDefault();
            event.stopPropagation();
            keep();
          }}
        >
          <p>
            {t(
              '{workspace} is deleted at once, and nothing brings it back. Its sites, its members, its invitations, its connectors and the notes that Fruitback keeps for it go. The issues already sent to its sources stay there, and its people keep their accounts. Every instance admin reads that you did it.',
              { workspace: name },
            )}
          </p>
          <Field
            label={t('Type {workspace} to confirm', { workspace: name })}
            value={typed}
            compact
            autoFocus
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
              setProblem(undefined);
            }}
          />
          <span className="flex flex-wrap gap-[8px]">
            <Button tone="quiet" onClick={keep}>
              {t('Keep it')}
            </Button>
            <Button tone="danger" disabled={busy || !matches} onClick={() => void send()}>
              {t('Delete {workspace}', { workspace: name })}
            </Button>
          </span>
        </div>
      ) : (
        <div>
          <Button tone="outline" onClick={() => setAsking(true)}>
            {t('Delete the workspace')}
          </Button>
        </div>
      )}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </div>
  );
}
