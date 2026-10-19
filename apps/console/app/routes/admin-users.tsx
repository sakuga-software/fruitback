import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { type AdminQuery, type AdminUser, adminUsers, setInstanceAdmin, setSuspended } from '../api';
import { Confirmation } from '../confirm';
import { locale, msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, DataTable, Initial, PageHead, Problem, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { useWide } from '../wide';
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
import { useAdmin } from './admin';
import { seenOn } from './members';

/**
 * The people of the instance, as screen 19 of the mockup of 2026-10-13 draws them (FRU-263): their
 * workspaces, how they sign in, and whether they administer the instance. The switch « Instance
 * admin » of the panel names and removes an administrator (FRU-280). « Suspend » and « Restore
 * access » suspend and restore the account (FRU-281). The other actions of the mockup come with
 * FRU-274.
 *
 * The panel is the row: the worker has no route for one person. It lists accounts only, so somebody
 * invited who never signed in is not a row.
 *
 * WARNING: each read writes a trace in each workspace of the answer that the administrator is not a
 * member of (FRU-261).
 */

/**
 * The filters of the worker (`USER_FILTERS`), with no count: the worker counts the filter it answers
 * only. The worker has no filter for the mockup's « Suspended » and « Invited ».
 */
const SHOW = [
  { value: 'all', label: msg('All people') },
  { value: 'admins', label: msg('Instance admins') },
  { value: 'alone', label: msg('In no workspace') },
] as const;

const ROLES: Readonly<Record<string, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

const PROVIDERS: Readonly<Record<string, string>> = {
  email: msg('Email link'),
  github: 'GitHub',
  google: 'Google',
};

/** A list of the people, with the search and the filter that it answers. */
type Listed = {
  users: AdminUser[];
  total: number;
  asked: AdminQuery;
  /** The accounts that the read answered as suspended. The worker does not say their role. */
  suspendedWhenRead: readonly string[];
  /** Those of them restored since the read: each can be an admin again, and the list does not say. */
  restoredSinceRead: readonly string[];
};

type Status = 'admin' | 'active' | 'invited' | 'suspended';

const STATUSES = {
  admin: { word: msg('Instance admin'), colour: 'text-ink' },
  active: { word: msg('Active'), colour: 'text-done' },
  invited: { word: msg('Invited'), colour: 'text-muted' },
  suspended: { word: msg('Suspended'), colour: 'text-accent' },
} as const satisfies Record<Status, { word: string; colour: string }>;

/**
 * The colour of a status. The red of the mockup is 4.28:1 on the tint of the chosen row
 * (design/simpler-flow/SPEC.md), so the chosen row takes the darker red.
 */
function colourOf(status: Status, chosen: boolean): string {
  return status === 'suspended' && chosen ? 'text-accent-strong' : STATUSES[status].colour;
}

/** An account in no workspace with an invitation that waits is « Invited ». */
function statusOf(user: AdminUser): Status {
  if (user.suspended) return 'suspended';
  if (user.instanceAdmin) return 'admin';

  return user.workspaces.length === 0 && user.pendingInvitations.length > 0 ? 'invited' : 'active';
}

function roleOf(role: string | undefined): string {
  if (role === undefined) return '';

  return ROLES[role] === undefined ? role : t(ROLES[role] as string);
}

/** Why a control is held before the worker is asked: on yourself, and on the last admin. */
type Holds = { self: string; last: string };

/** The two refusals of the role, which are also the reasons why its switch is held. */
const ROLE_HOLDS: Holds = {
  self: msg('You cannot take this role from yourself. Another instance admin can.'),
  last: msg('The last instance admin keeps the role. Name another admin first.'),
};
const ROLE_PROBLEMS: Readonly<Record<string, string>> = {
  'self-removal': ROLE_HOLDS.self,
  'last-admin': ROLE_HOLDS.last,
};
const ROLE_NOT_CHANGED = msg('The role did not change. Try again.');
/** The worker counts a suspended admin as no admin, and a change of the role would not show. */
const ROLE_OF_SUSPENDED = msg('A suspended account is not an instance admin. Restore access first.');
/** The worker does not say the role of a suspended account, and a restore does not either. */
const ROLE_AFTER_RESTORE = msg('Its role shows when you open Users again.');

/** The two refusals of a suspension, which are also the reasons why « Suspend » is held. */
const SUSPENSION_HOLDS: Holds = {
  self: msg('You cannot suspend your own account. Another instance admin can.'),
  last: msg('The last instance admin cannot be suspended. Name another admin first.'),
};
const SUSPENSION_PROBLEMS: Readonly<Record<string, string>> = {
  'self-suspension': SUSPENSION_HOLDS.self,
  'last-admin': SUSPENSION_HOLDS.last,
};
const NOTHING_CHANGED = msg('Nothing changed. Try again.');

/**
 * Why a control of a person is held, before the worker is asked. `admins` is the count of
 * administrators that are not suspended, or `undefined` when the list does not hold all of them:
 * then the worker answers.
 */
function heldBy(user: AdminUser, me: string, admins: number | undefined, holds: Holds): string | undefined {
  if (user.id === me) return holds.self;

  return user.instanceAdmin && !user.suspended && admins === 1 ? holds.last : undefined;
}

function providerOf(provider: string): string {
  const name = PROVIDERS[provider];

  return name === undefined ? provider : t(name);
}

export default function AdminUsers() {
  useLocale();
  const { q, show, open, typed, setTyped, change, openTo } = useListAddress();
  const wide = useWide();
  // Whether the panel that is about to appear was opened by a press of its row (FRU-197).
  const opening = useRef(false);

  const ask = useCallback(async (): Promise<Listed | 'failed'> => {
    const answer = await adminUsers({ q, show });

    if (!answer.ok || !Array.isArray(answer.data?.users)) return 'failed';
    const suspendedWhenRead = answer.data.users.filter((user) => user.suspended).map((user) => user.id);

    return { ...answer.data, asked: { q, show }, suspendedWhenRead, restoredSinceRead: [] };
  }, [q, show]);
  const { shown, again, patch } = useRead(ask);
  const { me } = useAdmin();

  const rows = typeof shown === 'object' ? shown.users : [];
  // Only a list with no search, of everybody or of the administrators, and not cut, holds them all.
  // The rows of a read before stay while the next read is on its way: the count reads their question.
  const whole =
    typeof shown === 'object' &&
    shown.asked.q === '' &&
    shown.asked.show !== 'alone' &&
    shown.total === rows.length &&
    shown.restoredSinceRead.length === 0;
  const admins = whole ? rows.filter((user) => user.instanceAdmin && !user.suspended).length : undefined;
  const chosen = rows.find((user) => user.id === open);
  const close = () => {
    change({ open: '' }, true);
    if (chosen !== undefined) document.getElementById(rowId(chosen.id))?.focus();
  };
  const changed = (id: string, change: Partial<AdminUser>) =>
    patch((listed) => ({
      ...listed,
      restoredSinceRead:
        change.suspended === false && listed.suspendedWhenRead.includes(id)
          ? [...new Set([...listed.restoredSinceRead, id])]
          : listed.restoredSinceRead,
      users: listed.users.map((user) => (user.id === id ? { ...user, ...change } : user)),
    }));
  const roleHeld = (user: AdminUser): string | undefined => {
    if (user.suspended) return ROLE_OF_SUSPENDED;
    if (typeof shown === 'object' && shown.restoredSinceRead.includes(user.id)) return ROLE_AFTER_RESTORE;

    return heldBy(user, me.account.id, admins, ROLE_HOLDS);
  };
  const panel =
    chosen === undefined ? null : (
      <Panel
        key={chosen.id}
        user={chosen}
        held={roleHeld(chosen)}
        suspensionHeld={heldBy(chosen, me.account.id, admins, SUSPENSION_HOLDS)}
        wide={wide}
        takesFocus={opening}
        onClose={close}
        onRole={(instanceAdmin) => changed(chosen.id, { instanceAdmin })}
        onSuspended={(suspended) => changed(chosen.id, { suspended })}
      />
    );

  return (
    <>
      <PageHead
        title={t('Users')}
        lead={t('Everyone who can sign in to this instance, and in which workspaces.')}
        className="mb-[8px]"
      />
      <p className="mb-[24px] max-w-[64ch] text-small text-muted">
        {t('The owners of each workspace see that you read its people, with your address and the day.')}
      </p>
      <ListBar
        label={t('Search people')}
        placeholder={t('Search by name or address')}
        typed={typed}
        onType={setTyped}
        show={show}
        onShow={(chosenShow) => change({ show: chosenShow })}
        options={SHOW.map((option) => ({ value: option.value, label: t(option.label) }))}
      />

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {shown === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('The people could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={again}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof shown === 'object' && rows.length === 0 ? (
        <NoRows
          filtered={q !== '' || show !== 'all'}
          empty={t('Nobody has an account on this instance yet.')}
          noMatch={t('Nobody matches this search.')}
          onClear={() => {
            setTyped('');
            change({ q: '', show: 'all', open: '' });
          }}
        />
      ) : null}

      {typeof shown === 'object' && rows.length > 0 ? (
        <div className="flex flex-wrap items-start gap-[28px]">
          <div className="min-w-0 flex-[999_1_560px]">
            <DataTable label={t('People of the instance')} minWidth={700} dense hover>
              <thead>
                <tr>
                  <th scope="col">{t('Person')}</th>
                  <th scope="col">{t('Workspaces')}</th>
                  <th scope="col">{t('Signs in with')}</th>
                  <th scope="col">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => {
                  const isChosen = user.id === chosen?.id;
                  const status = statusOf(user);

                  return (
                    <Fragment key={user.id}>
                      <tr data-chosen={isChosen}>
                        <td>
                          <span className="flex items-center gap-[12px]">
                            <Initial name={user.name ?? user.email} pending={status === 'invited'} />
                            <span className="min-w-0">
                              <RowLink
                                id={user.id}
                                to={openTo(user.id)}
                                chosen={isChosen}
                                onOpen={() => (opening.current = true)}
                              >
                                {user.name ?? user.email}
                              </RowLink>
                              {user.name === undefined ? null : (
                                <span className="block text-hint text-muted [overflow-wrap:anywhere]">
                                  {user.email}
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="whitespace-pre-line">
                          <Workspaces user={user} />
                        </td>
                        <td className="text-ink-soft">
                          <SignsInWith user={user} />
                        </td>
                        <td>
                          <span className={`block font-semibold ${colourOf(status, isChosen)}`}>
                            <StatusWord status={status} />
                          </span>
                          <span className="block text-hint text-muted tabular-nums">
                            <Seen user={user} />
                          </span>
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
              sentence={t('The first {count} of {total} people.', { count: rows.length, total: shown.total })}
            />
          </div>
          {wide ? panel : null}
        </div>
      ) : null}
    </>
  );
}

/** « Acme web · owner », one line per workspace, and the invitations that wait. */
function Workspaces({ user }: { user: AdminUser }) {
  useLocale();
  const lower = (word: string) => word.toLocaleLowerCase(locale());
  const lines = [
    ...user.workspaces.map((workspace) => `${workspace.name} · ${lower(roleOf(workspace.role))}`),
    ...user.pendingInvitations.map((invitation) => `${invitation.workspace.name} · ${lower(t('Invited'))}`),
  ];

  return <>{lines.length === 0 ? <span className="text-muted">{t('None')}</span> : lines.join('\n')}</>;
}

function SignsInWith({ user }: { user: AdminUser }) {
  useLocale();

  return <>{user.providers.length === 0 ? t('Not signed in yet') : user.providers.map(providerOf).join(', ')}</>;
}

function StatusWord({ status }: { status: Status }) {
  useLocale();

  return <>{t(STATUSES[status].word)}</>;
}

/** The last day the person was seen: the worker keeps a day, and no hour (FRU-249). */
function Seen({ user }: { user: AdminUser }) {
  useLocale();

  return <>{seenOn(user.lastSeen)}</>;
}

/** The panel of a person, from their row: their workspaces, how they sign in, and their role here. */
function Panel({
  user,
  held,
  suspensionHeld,
  wide,
  takesFocus,
  onClose,
  onRole,
  onSuspended,
}: {
  user: AdminUser;
  held: string | undefined;
  suspensionHeld: string | undefined;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
  onRole: (instanceAdmin: boolean) => void;
  onSuspended: (suspended: boolean) => void;
}) {
  useLocale();
  const rows = [
    ...user.workspaces.map((workspace) => ({ key: workspace.id, name: workspace.name, value: roleOf(workspace.role) })),
    ...user.pendingInvitations.map((invitation) => ({
      key: `invited-${invitation.workspace.id}`,
      name: invitation.workspace.name,
      value: t('Invited'),
    })),
  ];
  const ways = user.providers.map((provider) => ({
    key: provider,
    name: providerOf(provider),
    value: provider === 'email' ? user.email : t('Linked'),
  }));

  const suspension = useSuspension(user, onSuspended);
  const control = <Suspension user={user} held={suspensionHeld} state={suspension} />;

  return (
    <AdminPanel
      wide={wide}
      takesFocus={takesFocus}
      onClose={onClose}
      title={user.name ?? user.email}
      {...(user.name === undefined ? {} : { detail: user.email })}
      {...(user.suspended ? {} : { foot: control })}
    >
      {user.suspended ? control : null}

      <PanelSection title={t('Workspaces')}>
        {rows.length === 0 ? (
          <p className="text-small text-muted">{t('In no workspace.')}</p>
        ) : (
          <PanelRows rows={rows.map((row) => ({ ...row, name: <span className="font-semibold">{row.name}</span> }))} />
        )}
      </PanelSection>

      <PanelSection title={t('Sign-in')}>
        {ways.length === 0 ? (
          <p className="text-small text-muted">{t('Not signed in yet')}</p>
        ) : (
          <PanelRows rows={ways} />
        )}
      </PanelSection>

      <AdminRole user={user} held={held} onRole={onRole} />
    </AdminPanel>
  );
}

/**
 * The switch « Instance admin ». A press asks first, and only the button of the confirmation sends.
 * The switch shows the role of the list, and the list changes after a `200` only: a refusal leaves
 * it as it was. After the answer, focus goes back to the switch, where the gesture started.
 */
function AdminRole({
  user,
  held,
  onRole,
}: {
  user: AdminUser;
  held: string | undefined;
  onRole: (instanceAdmin: boolean) => void;
}) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // A second press of the button that sends comes before React draws the first one as busy.
  const sending = useRef(false);
  const back = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const name = user.name ?? user.email;
  const naming = !user.instanceAdmin;

  // The confirmation and a refusal appear under the switch, and can appear under the screen on a phone.
  useEffect(() => {
    if (asking || problem !== undefined) box.current?.scrollIntoView({ block: 'nearest' });
  }, [asking, problem]);

  useEffect(() => {
    if (!back.current || asking || busy) return;
    back.current = false;
    box.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  }, [asking, busy]);

  const keep = () => {
    back.current = true;
    setAsking(false);
  };

  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    const answer = await setInstanceAdmin(user.id, naming);
    sending.current = false;
    if (answer.ok) onRole(answer.data.user.instanceAdmin);
    else setProblem(problemOf(answer, ROLE_PROBLEMS, ROLE_NOT_CHANGED));
    back.current = true;
    setAsking(false);
    setBusy(false);
  }

  return (
    <div ref={box} className="flex flex-col gap-[12px]">
      <Toggle
        strong
        label={t('Instance admin')}
        hint={t('Sees this admin and every workspace.')}
        value={user.instanceAdmin && !user.suspended}
        disabled={busy || held !== undefined}
        onChange={() => setAsking(true)}
      />
      {held === undefined ? null : <p className="text-hint text-muted">{t(held)}</p>}
      {asking ? (
        <Confirmation
          confirmLabel={naming ? t('Name {name} admin', { name }) : t('Remove {name} as admin', { name })}
          consequence={
            naming
              ? t(
                  '{name} sees this admin and every workspace, and can name and remove admins. Every instance admin reads that you made this change.',
                  { name },
                )
              : t(
                  '{name} no longer sees this admin, nor the workspaces they are not a member of. Every instance admin reads that you made this change.',
                  { name },
                )
          }
          onConfirm={() => void send()}
          onKeep={keep}
        />
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </div>
  );
}

type SuspensionState = ReturnType<typeof useSuspension>;

/**
 * « Suspend » and « Restore access » (FRU-281), as the switch of `AdminRole`: a press asks first,
 * only the button of the confirmation sends, and the row changes after a `200` only. After the
 * answer, focus goes to the button that says the state of the account now: « Restore access » after
 * a suspension, the same button after a refusal.
 */
function useSuspension(user: AdminUser, onSuspended: (suspended: boolean) => void) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // A second press of the button that sends comes before React draws the first one as busy.
  const sending = useRef(false);
  const back = useRef(false);
  // The control is in the foot of an active account and at the top of a suspended one: after a
  // `200`, this box is another element.
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (asking || problem !== undefined) box.current?.scrollIntoView({ block: 'nearest' });
  }, [asking, problem]);

  useEffect(() => {
    if (!back.current || asking || busy) return;
    back.current = false;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [asking, busy, user.suspended]);

  const keep = () => {
    back.current = true;
    setAsking(false);
  };

  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    const answer = await setSuspended(user.id, !user.suspended);
    sending.current = false;
    if (answer.ok) onSuspended(answer.data.user.suspended);
    else setProblem(problemOf(answer, SUSPENSION_PROBLEMS, NOTHING_CHANGED));
    back.current = true;
    setAsking(false);
    setBusy(false);
  }

  return { asking, busy, problem, box, ask: () => setAsking(true), keep, send };
}

/**
 * A suspended account says so at the top of its panel, with « Restore access », as screen 19 draws
 * it. An active account has « Suspend » in the foot of its panel, as screen 18 draws it for a
 * workspace.
 */
function Suspension({ user, held, state }: { user: AdminUser; held: string | undefined; state: SuspensionState }) {
  useLocale();
  const name = user.name ?? user.email;
  const suspending = !user.suspended;

  return (
    <div ref={state.box} className="flex w-full flex-col gap-[10px] text-small">
      {suspending ? null : (
        <p role="status">
          <span className="block font-semibold text-accent-strong">{t('Suspended')}</span>
          <span className="block">{t('{name} cannot sign in, and every session they had ended.', { name })}</span>
        </p>
      )}
      <div>
        <Button tone="outline" disabled={state.busy || held !== undefined} onClick={state.ask}>
          {suspending ? t('Suspend') : t('Restore access')}
        </Button>
      </div>
      {held === undefined ? null : <p className="text-hint text-muted">{t(held)}</p>}
      {state.asking ? (
        <Confirmation
          confirmLabel={suspending ? t('Suspend {name}', { name }) : t('Restore access for {name}', { name })}
          consequence={
            suspending
              ? t(
                  '{name} cannot sign in by any method, and their sessions of the console and of the extension end at once. Their notes stay. The owners of each of their workspaces see that you did it.',
                  { name },
                )
              : t(
                  '{name} can sign in again. Their old sessions stay ended. The owners of each of their workspaces see that you did it.',
                  { name },
                )
          }
          onConfirm={() => void state.send()}
          onKeep={state.keep}
        />
      ) : null}
      {state.problem === undefined ? null : <Problem>{t(state.problem)}</Problem>}
    </div>
  );
}
