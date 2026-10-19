import { Fragment, useCallback, useRef } from 'react';
import { type AdminUser, adminUsers } from '../api';
import { locale, msg, t } from '../i18n';
import { Button, DataTable, Initial, PageHead, Problem } from '../ui';
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
import { seenOn } from './members';

/**
 * The people of the instance, as screen 19 of the mockup of 2026-10-13 draws them (FRU-263),
 * read-only: their workspaces, how they sign in, and whether they administer the instance. The
 * actions of the mockup come with FRU-274, so the screen has no button that changes a person.
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

type Listed = { users: AdminUser[]; total: number };

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

    return answer.ok && Array.isArray(answer.data?.users) ? answer.data : 'failed';
  }, [q, show]);
  const { shown, again } = useRead(ask);

  const rows = typeof shown === 'object' ? shown.users : [];
  const chosen = rows.find((user) => user.id === open);
  const close = () => {
    change({ open: '' }, true);
    if (chosen !== undefined) document.getElementById(rowId(chosen.id))?.focus();
  };
  const panel =
    chosen === undefined ? null : (
      <Panel key={chosen.id} user={chosen} wide={wide} takesFocus={opening} onClose={close} />
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
  wide,
  takesFocus,
  onClose,
}: {
  user: AdminUser;
  wide: boolean;
  takesFocus: { current: boolean };
  onClose: () => void;
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

      <div className="flex items-center justify-between gap-[16px] text-small">
        <span>
          <span className="block font-semibold">{t('Instance admin')}</span>
          <span className="block text-hint text-muted">{t('Sees this admin and every workspace.')}</span>
        </span>
        <span className="font-semibold">{user.instanceAdmin ? t('Yes') : t('No')}</span>
      </div>
    </AdminPanel>
  );
}
