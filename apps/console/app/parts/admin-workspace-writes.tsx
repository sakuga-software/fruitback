import { useState } from 'react';
import {
  type AdminWorkspaceDetail,
  addMemberAsAdmin,
  createWorkspaceAsAdmin,
  inviteAsAdmin,
  setOwnerAsAdmin,
} from '../api';
import { msg, t } from '../i18n';
import { Choice, Field } from '../ui';
import { useLocale } from '../use-locale';
import { AdminWrite, GIVEN_ROLES, INVITED_ROLES } from './admin-writes';

// The writes of the administrator on a workspace (FRU-263, FRU-614): a person added or invited, its owner, a new workspace.

/**
 * A sentence that a write said, kept in English with its values and translated where it is shown,
 * so it follows a change of language.
 */
export type Saying = { sentence: string; values: Readonly<Record<string, string>> };

/** `sentence` is a `msg`, so the check of the words finds it. */
export function saying(sentence: string, values: Readonly<Record<string, string>> = {}): Saying {
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
export function AddPerson({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
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
              someoneElse
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
          'invalid-email': msg('This is not an e-mail address. Type one like name@company.com.'),
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
export function InvitePerson({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
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
              someoneElse
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
          'invalid-email': msg('This is not an e-mail address. Type one like name@company.com.'),
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
export function ChangeOwner({ workspace, onChanged }: { workspace: AdminWorkspaceDetail; onChanged: () => void }) {
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
            someoneElse
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
          'invalid-email': msg('This is not an e-mail address. Type one like name@company.com.'),
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
export function NewWorkspace({
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
            someoneElse
            compact
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </>
      }
      consequence={t('The workspace is created at once, and {email} owns it. They see that you created it.', {
        email: address === '' ? t('its owner') : address,
      })}
      confirmLabel={t('Create the workspace')}
      ready={named !== '' && address.includes('@')}
      send={() => createWorkspaceAsAdmin(named, address)}
      problems={{
        'unknown-account': msg('No account has this address. The owner signs in once first.'),
        'suspended-account': msg('This account is suspended. Restore its access first.'),
        'invalid-name': msg('A workspace needs a name of one line, up to 80 characters.'),
        'invalid-email': msg('This is not an e-mail address. Type one like name@company.com.'),
      }}
      notDone={msg('The workspace was not created. Try again.')}
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
