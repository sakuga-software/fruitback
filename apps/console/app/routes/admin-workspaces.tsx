import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AdminConnector,
  type AdminWorkspace,
  type AdminWorkspaceDetail,
  STAGES,
  SUSPENSION_REASON_LENGTH,
  type StageCounts,
  type WorkspaceSuspension,
  addMemberAsAdmin,
  adminWorkspace,
  adminWorkspaces,
  createWorkspaceAsAdmin,
  deleteWorkspaceAsAdmin,
  inviteAsAdmin,
  setOwnerAsAdmin,
  setWorkspaceSuspendedAsAdmin,
} from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Choice, DataTable, Field, LinkButton, PageHead, Problem, StatusBar } from '../ui';
import { useLocale } from '../use-locale';
import { useWide } from '../wide';
import { SuspendedSince, dayOf } from './admin-instance';
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
import { AdminWrite, GIVEN_ROLES, INVITED_ROLES } from './admin-writes';
import { KINDS } from './connector-parts';
import { siteLabel } from '../site-address';

/**
 * The workspaces of the instance, as screen 18 of the mockup of 2026-10-13 draws them (FRU-263):
 * who owns each one, its notes, and where they go. « Delete the workspace » in the foot of a panel
 * deletes it after its name is typed (FRU-284). « New workspace », and in a panel « Add someone »,
 * « Invite someone » and « Change the owner », write at once, and the owners read it (FRU-283).
 * « Suspend » in the foot of a panel, and « Restore » at the top of a suspended one, after a
 * confirmation (FRU-323, routes of FRU-282); a suspended workspace says so in its row, with the day.
 *
 * WARNING: each read writes a trace in each workspace of the answer that the administrator is not a
 * member of (FRU-261). The panel reads its workspace again, and leaves one more trace there.
 */

/** The filters of the worker (`WORKSPACE_FILTERS`). The worker has no filter for the mockup's « Suspended ». */
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
  const { shown, again, patch } = useRead(ask);
  // The name of the workspace that was just deleted: the page says it, where its row was.
  const [said, setSaid] = useState<Saying | undefined>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  // Focus goes to the sentence: the panel or the form, and the button that had it, are gone.
  useEffect(() => {
    if (said !== undefined) statusLine.current?.focus();
  }, [said]);

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
  const { shown: read, again: readAgain, patch: patchRead } = useRead(askDetail);
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
          setSaid(
            saying(msg('{workspace} was deleted. Every instance admin reads it on the page Instance.'), {
              workspace: name,
            }),
          );
          change({ open: '' }, true);
          again();
        }}
        onChanged={() => {
          // The detail is read again, and the row: an owner or a count of people changed.
          known.current.delete(chosen.id);
          readAgain();
          again();
        }}
        onSuspension={(state) => {
          // The row and the detail change in place, as a suspension of a person does (FRU-281): each
          // read leaves a trace with the owners, and the answer says the state.
          const id = chosen.id;
          const withState = <T extends WorkspaceSuspension>(each: T): T => ({ ...withoutSuspension(each), ...state });
          patch((listed) => ({
            ...listed,
            workspaces: listed.workspaces.map((each) => (each.id === id ? withState(each) : each)),
          }));
          const kept = known.current.get(id);
          if (kept !== undefined) known.current.set(id, withState(kept));
          patchRead((current) =>
            current !== 'none' && current.id === id && typeof current.detail === 'object'
              ? { id, detail: withState(current.detail) }
              : current,
          );
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
      <div className="mb-[20px] max-w-[520px]">
        <NewWorkspace
          onMade={(made) => {
            setSaid(
              saying(msg('{workspace} was made, owned by {email}.'), {
                workspace: made.workspace.name,
                email: made.owner.email,
              }),
            );
            setTyped('');
            change({ q: '', show: 'all', open: made.workspace.id });
            again();
          }}
        />
      </div>
      {said === undefined ? null : (
        <p role="status" tabIndex={-1} ref={statusLine} className="mb-[16px] text-small font-semibold">
          {t(said.sentence, said.values)}
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
                          <SuspendedSince workspace={workspace} chosen={isChosen} />
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

/** The three fields of a suspension taken out, so that the state of an answer replaces them all. */
function withoutSuspension<T extends WorkspaceSuspension>(each: T): T {
  const { suspended: _suspended, suspendedAt: _at, reason: _reason, ...rest } = each;

  return rest as T;
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
  onChanged,
  onSuspension,
}: {
  workspace: AdminWorkspace;
  detail: AdminWorkspaceDetail | 'loading' | 'failed';
  onRetry: () => void;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
  onDeleted: (name: string) => void;
  onChanged: () => void;
  onSuspension: (state: WorkspaceSuspension) => void;
}) {
  useLocale();
  const owners = ownersOf(workspace);
  // After a change, the control that says the state now takes focus: « Restore » at the top after a
  // suspension, « Suspend » in the foot after a restoration.
  const moved = useRef(false);
  const suspension = (
    <Suspension
      workspace={workspace}
      moved={moved}
      onSuspension={(state) => {
        moved.current = true;
        onSuspension(state);
      }}
    />
  );
  const suspended = workspace.suspended === true;

  return (
    <AdminPanel
      wide={wide}
      takesFocus={takesFocus}
      onClose={onClose}
      foot={
        <div className="flex w-full flex-col gap-[16px]">
          {suspended ? null : suspension}
          <Deletion workspace={workspace} onDeleted={onDeleted} />
        </div>
      }
      title={workspace.name}
      detail={
        owners === ''
          ? t('Created {day}', { day: dayOf(workspace.createdAt) })
          : t('Owned by {owner} · created {day}', { owner: owners, day: dayOf(workspace.createdAt) })
      }
    >
      {suspended ? suspension : null}
      {detail === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {detail === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('This workspace could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={onRetry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof detail === 'object' ? <Detail workspace={detail} onChanged={onChanged} /> : null}
    </AdminPanel>
  );
}

function Detail({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
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
        <AddPerson workspace={workspace} onChanged={onChanged} />
        <InvitePerson workspace={workspace} onChanged={onChanged} />
      </PanelSection>

      <PanelSection title={t('Sites · {count}', { count: workspace.sites.length })}>
        <PanelRows
          rows={workspace.sites.map((site) => ({
            key: site.id,
            name: <span className="font-semibold">{siteLabel(site.origin)}</span>,
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
        <ChangeOwner workspace={workspace} onChanged={onChanged} />
      </PanelSection>
    </>
  );
}

/**
 * « Suspend » and « Restore » (FRU-323), on the routes of FRU-282. A press asks, as every write of an
 * administrator (`AdminWrite`): a suspension takes an optional reason, kept with it and in the trace,
 * and says what a suspended workspace does; only the button of the confirmation
 * sends. A suspended workspace says so at the top of its panel, with the day and the reason, and
 * « Restore »; an active one has « Suspend » in the foot, as screen 18 draws it. The row and the panel
 * change after a `200` only.
 */
function Suspension({
  workspace,
  moved,
  onSuspension,
}: {
  workspace: AdminWorkspace;
  moved: { current: boolean };
  onSuspension: (state: WorkspaceSuspension) => void;
}) {
  useLocale();
  const [reason, setReason] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const name = workspace.name;
  const suspending = workspace.suspended !== true;
  const given = reason.replace(/\s+/g, ' ').trim();

  // This control is drawn again in another place after a change: its button takes focus there.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [moved]);

  const done = (data: { workspace: WorkspaceSuspension }) => {
    setReason('');
    const { suspended = false, suspendedAt, reason: kept } = data.workspace;
    onSuspension({
      suspended,
      ...(suspendedAt === undefined ? {} : { suspendedAt }),
      ...(kept === undefined ? {} : { reason: kept }),
    });
  };
  const problems = {
    'invalid-reason': msg('A reason is one line of 200 characters at most.'),
    'invalid-suspended': msg('Nothing changed. Try again.'),
  };

  return (
    <div ref={box} className="flex w-full flex-col gap-[10px] text-small">
      {suspending ? null : (
        <p role="status">
          <span className="block font-semibold text-accent-strong">{t('Suspended')}</span>
          <span className="block">
            {workspace.suspendedAt === undefined
              ? t('Its sites answer as unknown, and nothing in it changes. Its members still read it.')
              : t('Since {day}. Its sites answer as unknown, and nothing in it changes. Its members still read it.', {
                  day: dayOf(workspace.suspendedAt),
                })}
          </span>
          <span className="block [overflow-wrap:anywhere]">
            {workspace.reason === undefined
              ? t('No reason was given.')
              : t('Reason: {reason}', { reason: workspace.reason })}
          </span>
        </p>
      )}
      {suspending ? (
        <AdminWrite
          label={t('Suspend')}
          name={t('Suspend {workspace}', { workspace: name })}
          fields={
            <Field
              label={t('Reason (optional)')}
              compact
              autoFocus
              autoComplete="off"
              maxLength={SUSPENSION_REASON_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          }
          consequence={t(
            '{workspace} is suspended at once. Its sites answer as unknown to the widget and the extension, every change in it is refused, and its notes wait to be delivered. Its members still sign in and read it. Nothing is deleted. Its owners see that you did it.',
            { workspace: name },
          )}
          confirmLabel={t('Suspend {workspace}', { workspace: name })}
          ready
          send={() => setWorkspaceSuspendedAsAdmin(workspace.id, true, given === '' ? undefined : given)}
          problems={problems}
          notDone={msg('Nothing changed. Try again.')}
          onDone={done}
          onClose={() => setReason('')}
        />
      ) : (
        <AdminWrite
          label={t('Restore')}
          name={t('Restore {workspace}', { workspace: name })}
          fields={null}
          consequence={t(
            '{workspace} works again at once: its sites answer, its members change it again, and the notes that waited are delivered. Its owners see that you did it.',
            { workspace: name },
          )}
          confirmLabel={t('Restore {workspace}', { workspace: name })}
          ready
          send={() => setWorkspaceSuspendedAsAdmin(workspace.id, false)}
          problems={problems}
          notDone={msg('Nothing changed. Try again.')}
          onDone={done}
        />
      )}
    </div>
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

/**
 * A sentence that a write said, kept in English with its values and translated where it is shown,
 * so it follows a change of language.
 */
type Saying = { sentence: string; values: Readonly<Record<string, string>> };

/** `sentence` is a `msg`, so the check of the words finds it. */
function saying(sentence: string, values: Readonly<Record<string, string>> = {}): Saying {
  return { sentence, values };
}

/** A sentence that a write said, under its form, until the next one (FRU-283). */
function Said({ children }: { children: Saying | undefined }) {
  useLocale();
  if (children === undefined) return null;

  return (
    <p role="status" className="text-small font-semibold [overflow-wrap:anywhere]">
      {t(children.sentence, children.values)}
    </p>
  );
}

/** « Add someone » (FRU-283): an account that exists, by its address, with a role. */
function AddPerson({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
  useLocale();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [said, setSaid] = useState<Saying | undefined>();
  const address = email.trim();
  const roleName = t((GIVEN_ROLES.find((each) => each.value === role) ?? GIVEN_ROLES[0]).label);

  return (
    <>
      <AdminWrite
        label={t('Add someone')}
        name={t('Add someone to {workspace}', { workspace: workspace.name })}
        fields={
          <>
            <Field
              label={t('Address of their account')}
              type="email"
              autoComplete="off"
              compact
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Choice
              label={t('Role')}
              compact
              value={role}
              onChange={setRole}
              options={GIVEN_ROLES.map((each) => ({ value: each.value, label: t(each.label) }))}
            />
          </>
        }
        consequence={t('{email} joins {workspace} as {role} at once. The owners of {workspace} see that you did it.', {
          email: address === '' ? t('This person') : address,
          workspace: workspace.name,
          role: roleName,
        })}
        confirmLabel={t('Add to {workspace}', { workspace: workspace.name })}
        ready={address.includes('@')}
        send={() => addMemberAsAdmin(workspace.id, address, role)}
        problems={{
          'unknown-account': msg('No account has this address. Use « Invite someone » for a person with no account.'),
          'already-member': msg('This person is a member of the workspace already.'),
          'invalid-email': msg('This is not an e-mail address.'),
        }}
        notDone={msg('Nobody was added. Try again.')}
        onDone={(data) => {
          setSaid(
            saying(msg('{email} was added to {workspace}.'), { email: data.member.email, workspace: workspace.name }),
          );
          setEmail('');
          onChanged();
        }}
        onClose={() => setEmail('')}
      />
      <Said>{said}</Said>
    </>
  );
}

/** « Invite someone » (FRU-283): an address with no account, as an invitation of a member. */
function InvitePerson({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
  useLocale();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [said, setSaid] = useState<Saying | undefined>();
  const address = email.trim();
  const roleName = t((INVITED_ROLES.find((each) => each.value === role) ?? INVITED_ROLES[0]).label);

  return (
    <>
      <AdminWrite
        label={t('Invite someone')}
        name={t('Invite someone to {workspace}', { workspace: workspace.name })}
        fields={
          <>
            <Field
              label={t('Their e-mail address')}
              type="email"
              autoComplete="off"
              compact
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Choice
              label={t('Role')}
              compact
              value={role}
              onChange={setRole}
              options={INVITED_ROLES.map((each) => ({ value: each.value, label: t(each.label) }))}
            />
          </>
        }
        consequence={t(
          '{email} is invited to {workspace} as {role}, for 7 days, in your name. The owners of {workspace} see that you did it.',
          { email: address === '' ? t('This person') : address, workspace: workspace.name, role: roleName },
        )}
        confirmLabel={t('Send the invitation')}
        ready={address.includes('@')}
        send={() => inviteAsAdmin(workspace.id, address, role)}
        problems={{
          'has-account': msg('This address has an account. Use « Add someone » instead.'),
          'already-member': msg('This person is a member of the workspace already.'),
          'already-invited': msg('This address is invited to the workspace already.'),
          'invalid-email': msg('This is not an e-mail address.'),
        }}
        notDone={msg('Nobody was invited. Try again.')}
        onDone={(data) => {
          const link = `${globalThis.location?.origin ?? ''}/invitations`;
          setSaid(
            data.invitation.mailed
              ? saying(msg('An invitation was sent to {email}.'), { email: data.invitation.email })
              : saying(msg('{email} is invited. No message left: send them {link}'), {
                  email: data.invitation.email,
                  link,
                }),
          );
          setEmail('');
          onChanged();
        }}
        onClose={() => setEmail('')}
      />
      <Said>{said}</Said>
    </>
  );
}

/** « Change the owner » (FRU-283): the owners of before become admins, and keep the workspace. */
function ChangeOwner({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
  useLocale();
  const [email, setEmail] = useState('');
  const [said, setSaid] = useState<Saying | undefined>();
  const address = email.trim();

  return (
    <>
      <AdminWrite
        label={t('Change the owner')}
        name={t('Change the owner of {workspace}', { workspace: workspace.name })}
        fields={
          <Field
            label={t('Address of the new owner')}
            type="email"
            autoComplete="off"
            compact
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        }
        consequence={t(
          '{email} becomes the owner of {workspace} at once. The owners of before become admins: they keep the workspace. The owners see that you did it.',
          { email: address === '' ? t('This person') : address, workspace: workspace.name },
        )}
        confirmLabel={t('Make them the owner')}
        ready={address.includes('@')}
        send={() => setOwnerAsAdmin(workspace.id, address)}
        problems={{
          'unknown-account': msg('No account has this address. Invite them first, then make them the owner.'),
          'suspended-account': msg('This account is suspended. Restore its access first.'),
          'invalid-email': msg('This is not an e-mail address.'),
        }}
        notDone={msg('The owner did not change. Try again.')}
        onDone={(data) => {
          setSaid(
            data.changed
              ? saying(msg('{email} owns {workspace} now.'), { email: data.owner.email, workspace: workspace.name })
              : saying(msg('{email} owned {workspace} already.'), {
                  email: data.owner.email,
                  workspace: workspace.name,
                }),
          );
          setEmail('');
          onChanged();
        }}
        onClose={() => setEmail('')}
      />
      <Said>{said}</Said>
    </>
  );
}

/** « New workspace » (FRU-283): a workspace whose owner is an account that exists. */
function NewWorkspace({
  onMade,
}: {
  onMade: (made: { workspace: { id: string; name: string }; owner: { email: string } }) => void;
}) {
  useLocale();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const address = email.trim();
  const named = name.replace(/\s+/g, ' ').trim();

  return (
    <AdminWrite
      label={t('New workspace')}
      name={t('New workspace')}
      fields={
        <>
          <Field
            label={t('Name of the workspace')}
            compact
            autoFocus
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label={t('Address of its owner')}
            type="email"
            autoComplete="off"
            compact
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </>
      }
      consequence={t('The workspace is made at once, and {email} owns it. They see that you made it.', {
        email: address === '' ? t('its owner') : address,
      })}
      confirmLabel={t('Make the workspace')}
      ready={named !== '' && address.includes('@')}
      send={() => createWorkspaceAsAdmin(named, address)}
      problems={{
        'unknown-account': msg('No account has this address. The owner signs in once first.'),
        'suspended-account': msg('This account is suspended. Restore its access first.'),
        'invalid-name': msg('A workspace needs a name of one line, up to 80 characters.'),
        'invalid-email': msg('This is not an e-mail address.'),
      }}
      notDone={msg('The workspace was not made. Try again.')}
      onDone={(data) => {
        setName('');
        setEmail('');
        onMade(data);
      }}
      onClose={() => {
        setName('');
        setEmail('');
      }}
    />
  );
}
