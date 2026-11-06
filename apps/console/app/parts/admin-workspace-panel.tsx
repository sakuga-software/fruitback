import { useEffect, useRef, useState } from 'react';
import {
  type AdminWorkspace,
  type AdminWorkspaceDetail,
  SUSPENSION_REASON_LENGTH,
  type WorkspaceSuspension,
  deleteWorkspaceAsAdmin,
  setWorkspaceSuspendedAsAdmin,
} from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { dayOf } from '../ago';
import { AdminPanel, PanelRows, PanelSection } from './admin-list';
import { AdminWrite } from './admin-writes';
import { siteLabel } from '../site-address';
import { ReadProblem } from '../read-problem';
import { type Fetched } from '../listed';
import { ROLES, kindOf, ownersOf } from './admin-workspace-facts';
import { AddPerson, ChangeOwner, InvitePerson } from './admin-workspace-writes';

// The panel of one workspace of « Workspaces » (FRU-263, FRU-614): its detail, its suspension, its deletion.

/**
 * The panel of a workspace: where its notes go, its people and its sites. Its head is the row, so it
 * shows at once; the rest is the read of the workspace, which the page does.
 */
export function Panel({
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
  detail: Fetched<AdminWorkspaceDetail>;
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
          <Problem>
            {t('This workspace did not load.')} <ReadProblem />
          </Problem>
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
    'invalid-suspended': msg('The workspace did not change. Reload the page, then try again.'),
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
            '{workspace} stops at once: its sites take no notes, nothing in it can change, and its notes wait to be delivered. Its members can still read it. Nothing is deleted. Its owners see that you did it.',
            { workspace: name },
          )}
          confirmLabel={t('Suspend {workspace}', { workspace: name })}
          ready
          send={() => setWorkspaceSuspendedAsAdmin(workspace.id, true, given === '' ? undefined : given)}
          problems={problems}
          notDone={msg('The workspace was not suspended. Try again.')}
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
          notDone={msg('The workspace was not restored. Try again.')}
          onDone={done}
        />
      )}
    </div>
  );
}

/** What the worker refuses when a workspace is deleted (FRU-284). */
const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  'name-mismatch': msg('This is not the name of the workspace. Type it as it is written, capitals included.'),
  'not-found': msg('This workspace no longer exists. Another admin or its owner may have deleted it. Reload the page.'),
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
              'This deletes {workspace} for good: its sites, members, invitations, connectors and the notes Fruitback keeps. Issues already in its trackers stay, and its people keep their accounts. Every instance admin sees that you did it.',
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
