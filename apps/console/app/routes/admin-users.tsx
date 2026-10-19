import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { type AdminQuery, type AdminUser, adminUsers, setInstanceAdmin } from '../api';
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
 * admin » of the panel names and removes an administrator (FRU-280). The other actions of the
 * mockup come with FRU-274.
 *
 * The panel is the row: the worker has no route for one person. It lists accounts only, so somebody
 * invited who never signed in is not a row.
 *
 * WARNING: each read writes a trace in each workspace of the answer that the administrator is not a
 * member of (FRU-261).
 */

/**
 * The filters of the worker (`USER_FILTERS`), with no count: the worker counts the filter it answers
 * only. The mockup's « Suspended » comes with FRU-274, and its « Invited » has no filter.
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
type Listed = { users: AdminUser[]; total: number; asked: AdminQuery };

type Status = 'admin' | 'active' | 'invited';

const STATUSES = {
  admin: { word: msg('Instance admin'), colour: 'text-ink' },
  active: { word: msg('Active'), colour: 'text-done' },
  invited: { word: msg('Invited'), colour: 'text-muted' },
} as const satisfies Record<Status, { word: string; colour: string }>;

/** An account in no workspace with an invitation that waits is « Invited ». */
function statusOf(user: AdminUser): Status {
  if (user.instanceAdmin) return 'admin';

  return user.workspaces.length === 0 && user.pendingInvitations.length > 0 ? 'invited' : 'active';
}

function roleOf(role: string | undefined): string {
  if (role === undefined) return '';

  return ROLES[role] === undefined ? role : t(ROLES[role] as string);
}

/** The two refusals of the worker, which are also the reasons why a switch is held. */
const SELF_REMOVAL = msg('You cannot take this role from yourself. Another instance admin can.');
const LAST_ADMIN = msg('The last instance admin keeps the role. Name another admin first.');

const ROLE_PROBLEMS: Readonly<Record<string, string>> = { 'self-removal': SELF_REMOVAL, 'last-admin': LAST_ADMIN };
const ROLE_NOT_CHANGED = msg('The role did not change. Try again.');

/**
 * Why the switch of a person cannot change, before the worker is asked. `admins` is the count of
 * administrators, or `undefined` when the list does not hold all of them: then the worker answers.
 * The list does not say which account is banned, so the worker can count fewer administrators.
 */
function heldBy(user: AdminUser, me: string, admins: number | undefined): string | undefined {
  if (user.id === me) return SELF_REMOVAL;

  return user.instanceAdmin && admins === 1 ? LAST_ADMIN : undefined;
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

    return answer.ok && Array.isArray(answer.data?.users) ? { ...answer.data, asked: { q, show } } : 'failed';
  }, [q, show]);
  const { shown, again, patch } = useRead(ask);
  const { me } = useAdmin();

  const rows = typeof shown === 'object' ? shown.users : [];
  // Only a list with no search, of everybody or of the administrators, and not cut, holds them all.
  // The rows of a read before stay while the next read is on its way: the count reads their question.
  const whole =
    typeof shown === 'object' && shown.asked.q === '' && shown.asked.show !== 'alone' && shown.total === rows.length;
  const admins = whole ? rows.filter((user) => user.instanceAdmin).length : undefined;
  const chosen = rows.find((user) => user.id === open);
  const close = () => {
    change({ open: '' }, true);
    if (chosen !== undefined) document.getElementById(rowId(chosen.id))?.focus();
  };
  const changed = (id: string, instanceAdmin: boolean) =>
    patch((listed) => ({
      ...listed,
      users: listed.users.map((user) => (user.id === id ? { ...user, instanceAdmin } : user)),
    }));
  const panel =
    chosen === undefined ? null : (
      <Panel
        key={chosen.id}
        user={chosen}
        held={heldBy(chosen, me.account.id, admins)}
        wide={wide}
        takesFocus={opening}
        onClose={close}
        onRole={(instanceAdmin) => changed(chosen.id, instanceAdmin)}
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
                          <span className={`block font-semibold ${STATUSES[status].colour}`}>
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
  wide,
  takesFocus,
  onClose,
  onRole,
}: {
  user: AdminUser;
  held: string | undefined;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
  onRole: (instanceAdmin: boolean) => void;
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

  return (
    <AdminPanel
      wide={wide}
      takesFocus={takesFocus}
      onClose={onClose}
      title={user.name ?? user.email}
      {...(user.name === undefined ? {} : { detail: user.email })}
    >
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
        value={user.instanceAdmin}
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
