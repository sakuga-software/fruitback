import { useEffect, useState } from 'react';
import { type AdminUser, addMemberAsAdmin, adminWorkspaces, setMemberRoleAsAdmin } from '../api';
import { msg, t } from '../i18n';
import { Choice } from '../ui';
import { useLocale } from '../use-locale';
import { AdminWrite, GIVEN_ROLES } from './admin-writes';
import { ReadProblem } from '../read-problem';

/**
 * The writes of an administrator on the workspaces of one person, in the panel of « Users »
 * (FRU-283): a role in one of their workspaces, and « Add to a workspace ». Each is written at once,
 * and the owners of the workspace read that the administrator did it.
 */

type Workspaces = AdminUser['workspaces'];

function roleName(role: string): string {
  const known = GIVEN_ROLES.find((each) => each.value === role);

  return known === undefined ? role : t(known.label);
}

/**
 * « Change a role »: one of the workspaces of the person, and the role there. A guest keeps their
 * role here: a guest is made by an invitation that names their sites, and their row says so.
 */
export function ChangeRole({ user, onChanged }: { user: AdminUser; onChanged: (workspaces: Workspaces) => void }) {
  useLocale();
  const roles = user.workspaces.filter((each) => each.role !== 'guest');
  const [workspace, setWorkspace] = useState(roles[0]?.id ?? '');
  const [role, setRole] = useState('member');
  const chosen = roles.find((each) => each.id === workspace);
  const name = user.name ?? user.email;
  if (roles.length === 0) return null;

  return (
    <AdminWrite
      label={t('Change a role')}
      name={t('Change the role of {name}', { name })}
      fields={
        <>
          <Choice
            label={t('Workspace')}
            compact
            value={workspace}
            onChange={setWorkspace}
            options={roles.map((each) => ({ value: each.id, label: `${each.name} · ${roleName(each.role)}` }))}
          />
          <Choice
            label={t('New role')}
            compact
            value={role}
            onChange={setRole}
            options={GIVEN_ROLES.map((each) => ({ value: each.value, label: t(each.label) }))}
          />
        </>
      }
      consequence={t('{name} becomes {role} of {workspace} at once. The owners of {workspace} see that you did it.', {
        name,
        role: roleName(role),
        workspace: chosen?.name ?? '',
      })}
      confirmLabel={t('Change the role')}
      ready={chosen !== undefined}
      send={() => setMemberRoleAsAdmin(workspace, user.id, role)}
      problems={{
        'last-owner': msg('This is the last owner of the workspace. Make somebody else its owner first.'),
        'not-a-member': msg('This person is no longer a member of the workspace. Reload the page.'),
      }}
      notDone={msg('The role did not change. Try again.')}
      onDone={(data) => {
        onChanged(user.workspaces.map((each) => (each.id === workspace ? { ...each, role: data.member.role } : each)));
      }}
    />
  );
}

/** The workspaces the person may join, read when the form opens: the read leaves a trace with their owners. */
function useOtherWorkspaces(user: AdminUser): { id: string; name: string }[] | 'loading' | 'failed' {
  const [found, setFound] = useState<{ id: string; name: string }[] | 'loading' | 'failed'>('loading');

  useEffect(() => {
    let live = true;
    void adminWorkspaces({ q: '', show: 'all' }).then((answer) => {
      if (!live) return;
      if (!answer.ok || !Array.isArray(answer.data?.workspaces)) return setFound('failed');
      const mine = new Set(user.workspaces.map((each) => each.id));
      setFound(answer.data.workspaces.filter((each) => !mine.has(each.id)).map(({ id, name }) => ({ id, name })));
    });

    return () => {
      live = false;
    };
  }, [user.workspaces]);

  return found;
}

function WorkspaceChoice({
  user,
  value,
  onChange,
}: {
  user: AdminUser;
  value: string;
  onChange: (workspace: { id: string; name: string } | undefined) => void;
}) {
  useLocale();
  const found = useOtherWorkspaces(user);

  useEffect(() => {
    if (typeof found === 'object' && value === '' && found[0] !== undefined) onChange(found[0]);
  }, [found, value, onChange]);

  if (found === 'loading') return <p className="text-muted">{t('Loading…')}</p>;
  if (found === 'failed')
    return (
      <p className="text-muted">
        {t('The workspaces did not load.')} <ReadProblem alone />
      </p>
    );
  if (found.length === 0) return <p className="text-muted">{t('This person is in every workspace already.')}</p>;

  return (
    <Choice
      label={t('Workspace')}
      hint={t('The owners of each workspace listed here see that you read the list.')}
      compact
      value={value}
      onChange={(id) => onChange(found.find((each) => each.id === id))}
      options={found.map((each) => ({ value: each.id, label: each.name }))}
    />
  );
}

/** « Add to a workspace »: one the person is not in, with a role. */
export function AddToWorkspace({ user, onChanged }: { user: AdminUser; onChanged: (workspaces: Workspaces) => void }) {
  useLocale();
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | undefined>();
  const [role, setRole] = useState('member');
  const name = user.name ?? user.email;

  return (
    <AdminWrite
      label={t('Add to a workspace')}
      name={t('Add {name} to a workspace', { name })}
      fields={
        <>
          <WorkspaceChoice user={user} value={workspace?.id ?? ''} onChange={setWorkspace} />
          <Choice
            label={t('Role')}
            compact
            value={role}
            onChange={setRole}
            options={GIVEN_ROLES.map((each) => ({ value: each.value, label: t(each.label) }))}
          />
        </>
      }
      consequence={t('{name} joins {workspace} as {role} at once. The owners of {workspace} see that you did it.', {
        name,
        role: roleName(role),
        workspace: workspace?.name ?? '',
      })}
      confirmLabel={t('Add to the workspace')}
      ready={workspace !== undefined}
      send={() => addMemberAsAdmin((workspace as { id: string }).id, user.email, role)}
      problems={{ 'already-member': msg('This person is a member of the workspace already.') }}
      notDone={msg('Nobody was added. Try again.')}
      onDone={(data) => {
        const added = workspace as { id: string; name: string };
        onChanged([...user.workspaces, { id: added.id, name: added.name, role: data.member.role }]);
        setWorkspace(undefined);
      }}
      onClose={() => setWorkspace(undefined)}
    />
  );
}
