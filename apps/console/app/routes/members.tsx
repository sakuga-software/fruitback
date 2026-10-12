import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type Invitation,
  type Member,
  ORGANIZATION,
  type Role,
  call,
  invitationLink,
  sendsMail,
  servesBetterAuth,
} from '../api';
import { Confirm } from '../confirm';
import { type Listed, edited, listedOf } from '../listed';
import { DID_NOT_ANSWER, copyText, problemOf } from '../problems';
import { Button, Card, Chip, Choice, Field, Initial, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';

const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

/** The roles an invitation gives: the worker refuses the others (FRU-104). */
type InvitedRole = 'member' | 'admin';

const INVITE_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-request': msg('Type the full address of the person, like name@company.com.'),
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: msg('This person is already a member of the workspace.'),
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: msg(
    'This address is invited already. Send the invitation again from its row.',
  ),
  'too-many-invitations': msg(
    'This address received three invitations in the last fifteen minutes. Wait, then send it again. An invitation that is kept has its link in its row.',
  ),
  'mail-unavailable': msg('The invitation is kept, but its message did not leave. Send it again from its row.'),
  INVITATION_LIMIT_REACHED: msg('A workspace has a hundred invitations waiting at most. Cancel some first.'),
  forbidden: msg('Only an owner or an admin of the workspace invites.'),
};
const NOT_INVITED = msg('The invitation was not sent. Try again.');
const NOT_CHANGED = msg('That did not go through. Try again.');
const MEMBER_PROBLEMS: Readonly<Record<string, string>> = {
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: msg('The last owner of a workspace stays in it.'),
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: msg('Only an owner removes an owner.'),
  forbidden: msg('Only an owner or an admin of the workspace changes its members.'),
};

/**
 * Who belongs to the workspace, and who is invited (design/boards/5-workspace.png, FRU-104).
 *
 * The lists come from the organization plugin of better-auth, through the worker. A guest reads only
 * their own row: the worker refuses them the list (FRU-149). A worker of before has no list.
 */
export default function Members() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const reads = workspace.role !== 'guest';
  const [served, setServed] = useState<boolean | undefined>();
  const [mailed, setMailed] = useState(false);
  const [members, setMembers] = useState<Listed<Member>>('loading');
  const [invitations, setInvitations] = useState<Listed<Invitation>>('loading');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitedRole>('member');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<string | undefined>();
  const [stuck, setStuck] = useState<{ row: string; problem: string } | undefined>();
  const base = `${ORGANIZATION}`;
  const query = `organizationId=${encodeURIComponent(workspace.id)}`;

  const read = useCallback(async () => {
    const serves = await servesBetterAuth();
    setServed(serves);
    setMailed(await sendsMail());
    if (!serves || !reads) return;
    setMembers('loading');
    const listed = await call<{ members: Member[] }>('GET', `${base}/list-members?${query}`);
    setMembers(listedOf(listed, (data) => data.members));
    if (!manages) return;
    setInvitations('loading');
    const waiting = await call<Invitation[]>('GET', `${base}/list-invitations?${query}`);
    setInvitations(listedOf(waiting, (data) => data.filter((each) => each.status === 'pending')));
  }, [base, query, reads, manages]);

  useEffect(() => void read(), [read]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    setSentTo(undefined);
    setBusy(true);
    const address = email.trim();
    const sent = await call<Invitation>('POST', `${base}/invite-member`, {
      organizationId: workspace.id,
      email: address,
      role,
    });
    setBusy(false);
    if (!sent.ok) {
      // A message that did not leave, or one too many in the window: the invitation may be kept all
      // the same, so the list is read again. Its row has the link to copy, and « Resend ».
      if (sent.error === 'mail-unavailable' || sent.error === 'too-many-invitations') void read();
      // The field keeps what was typed: the sentence says the cause.
      return setProblem(problemOf(sent, INVITE_PROBLEMS, NOT_INVITED));
    }
    setSentTo(sent.data.email);
    setEmail('');
    setInvitations((current) =>
      edited(current, (items) => [...items.filter((each) => each.id !== sent.data.id), sent.data]),
    );
  }

  async function resend(invitation: Invitation) {
    setStuck(undefined);
    const sent = await call<Invitation>('POST', `${base}/invite-member`, {
      organizationId: workspace.id,
      email: invitation.email,
      role: invitation.role,
      resend: true,
    });
    if (!sent.ok) return setStuck({ row: invitation.id, problem: problemOf(sent, INVITE_PROBLEMS, NOT_INVITED) });
    setSentTo(invitation.email);
    setInvitations((current) =>
      edited(current, (items) => items.map((each) => (each.id === sent.data.id ? sent.data : each))),
    );
  }

  async function cancel(invitation: Invitation) {
    setStuck(undefined);
    const cancelled = await call('POST', `${base}/cancel-invitation`, {
      organizationId: workspace.id,
      invitationId: invitation.id,
    });
    if (!cancelled.ok) return setStuck({ row: invitation.id, problem: problemOf(cancelled, {}, NOT_CHANGED) });
    setInvitations((current) => edited(current, (items) => items.filter((each) => each.id !== invitation.id)));
  }

  async function remove(member: Member) {
    setStuck(undefined);
    const removed = await call('POST', `${base}/remove-member`, {
      organizationId: workspace.id,
      memberIdOrEmail: member.id,
    });
    if (!removed.ok) return setStuck({ row: member.id, problem: problemOf(removed, MEMBER_PROBLEMS, NOT_CHANGED) });
    setMembers((current) => edited(current, (items) => items.filter((each) => each.id !== member.id)));
  }

  const self = {
    id: 'self',
    userId: me.account.id,
    role: workspace.role,
    createdAt: '',
    user: { id: me.account.id, email: me.account.email, name: me.account.name ?? '' },
  } satisfies Member;

  return (
    <>
      <PageHead title={t('Members')} lead={t('Who can see and leave feedback, and who can change the workspace.')} />
      {manages && served === true ? (
        <form onSubmit={invite} className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              label={t('Address of the person to invite')}
              labelHidden
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="sm:w-44">
            <Choice
              label={t('Role of the person to invite')}
              labelHidden
              value={role}
              onChange={(value) => setRole(value as InvitedRole)}
              options={[
                { value: 'member', label: t('Member') },
                { value: 'admin', label: t('Admin') },
              ]}
            />
          </div>
          <Button type="submit" disabled={busy || email.trim() === ''}>
            {busy ? t('Sending…') : t('Invite')}
          </Button>
        </form>
      ) : null}
      {manages && served === false ? (
        <p className="mb-4 text-xs text-muted">
          {t('Invitations come after the beta. Until then, each person signs in and makes their own workspace.')}
        </p>
      ) : null}
      {manages && served === true ? (
        <p className="mb-4 text-xs text-muted">
          {t('The person signs in with that address, and joins. Guests, who see one site only, come later.')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <div className="mb-4">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
      {sentTo === undefined ? null : <Invited email={sentTo} mailed={mailed} />}

      <Card>
        <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-line px-4 py-3 text-xs text-muted sm:grid-cols-[1fr_110px_90px_200px]">
          <span>{t('Person')}</span>
          <span>{t('Role')}</span>
          <span className="hidden sm:block">{t('Sites')}</span>
          <span className="hidden sm:block" />
        </div>
        <Rows
          members={served === true && reads ? members : [self]}
          invitations={manages && served === true ? invitations : []}
          me={me.account.id}
          manages={manages}
          stuck={stuck}
          onRetry={() => void read()}
          onResend={(each) => void resend(each)}
          onCancel={(each) => void cancel(each)}
          onRemove={(each) => void remove(each)}
        />
      </Card>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold">{t('Admin')}</dt>
          <dd className="text-muted">{t('Sites, connectors, members.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Member')}</dt>
          <dd className="text-muted">{t('Every site. Sees the tracker links.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Guest')}</dt>
          <dd className="text-muted">{t('Only the sites shared with them. Free, never sees the tracker.')}</dd>
        </div>
      </dl>
    </>
  );
}

/**
 * What an invitation became, and the link to send by hand (FRU-104, decided on FRU-107): the link
 * opens nothing by itself, so a chat is as good as a message. With a mailer, the message went too.
 */
function Invited({ email, mailed }: { email: string; mailed: boolean }) {
  useLocale();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const link = invitationLink();

  return (
    <div role="status" className="mb-4 rounded-[10px] border border-line bg-surface p-4 text-sm">
      <p>
        {mailed
          ? t('Invitation sent to {email}. You can also send them this link:', { email })
          : t('Invitation kept for {email}. Send them this link:', { email })}
      </p>
      <p className="mt-2 break-all rounded-md bg-chip px-3 py-2 font-mono text-xs">{link}</p>
      <p className="mt-2 text-xs text-muted">
        {t('They open it, sign in with {email}, and join. The link alone opens nothing.', { email })}
      </p>
      <Button
        tone="outline"
        className="mt-3"
        onClick={() => void copyText(link).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
      >
        {copied === 'yes' ? t('Copied') : t('Copy the link')}
      </Button>
      {copied === 'refused' ? (
        <p role="alert" className="mt-2 text-xs text-muted">
          {t('The browser refused the copy. Select the link above and copy it by hand.')}
        </p>
      ) : null}
    </div>
  );
}

function nameOf(member: Member): string {
  return member.user.name.trim() || member.user.email.split('@')[0] || member.user.email;
}

function Rows({
  members,
  invitations,
  me,
  manages,
  stuck,
  onRetry,
  onResend,
  onCancel,
  onRemove,
}: {
  members: Listed<Member>;
  invitations: Listed<Invitation>;
  me: string;
  manages: boolean;
  stuck: { row: string; problem: string } | undefined;
  onRetry: () => void;
  onResend: (invitation: Invitation) => void;
  onCancel: (invitation: Invitation) => void;
  onRemove: (member: Member) => void;
}) {
  useLocale();
  if (members === 'loading') return <p className="p-5 text-sm text-muted">{t('Loading…')}</p>;
  if (members === 'failed' || invitations === 'failed')
    return (
      <div className="flex flex-wrap items-center gap-3 p-5">
        <p role="alert" className="flex-1 text-sm text-muted">
          {t(DID_NOT_ANSWER)}
        </p>
        <Button tone="outline" onClick={onRetry}>
          {t('Try again')}
        </Button>
      </div>
    );
  const row = 'grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[1fr_110px_90px_200px]';

  return (
    <ul>
      {members.map((member) => (
        <li key={member.id} className="border-b border-line last:border-b-0">
          <div className={row}>
            <span className="flex min-w-0 items-center gap-3">
              <Initial name={nameOf(member)} />
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-semibold">
                  {member.userId === me ? t('{name} (you)', { name: nameOf(member) }) : nameOf(member)}
                </span>
                <span className="block truncate text-xs text-muted">{member.user.email}</span>
              </span>
            </span>
            <span>
              <Chip tone={member.role === 'owner' ? 'accent' : 'neutral'}>{t(ROLE_WORDS[member.role])}</Chip>
            </span>
            <span className="hidden text-sm sm:block">{member.role === 'guest' ? t('Shared ones') : t('All')}</span>
            {manages && member.userId !== me && member.id !== 'self' ? (
              <span className="col-span-full flex justify-end sm:col-span-1">
                <Confirm
                  label={t('Remove')}
                  confirmLabel={t('Remove {name}', { name: nameOf(member) })}
                  consequence={t(
                    '{name} leaves the workspace, and their extension stops reading its sites. Their notes stay.',
                    { name: nameOf(member) },
                  )}
                  onConfirm={() => onRemove(member)}
                />
              </span>
            ) : null}
          </div>
          {stuck?.row === member.id ? (
            <div className="px-4 pb-3">
              <Problem>{t(stuck.problem)}</Problem>
            </div>
          ) : null}
        </li>
      ))}
      {invitations === 'loading'
        ? null
        : invitations.map((invitation) => (
            <li key={invitation.id} className="border-b border-line last:border-b-0">
              <div className={row}>
                <span className="flex min-w-0 items-center gap-3">
                  <Initial name={invitation.email} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">{invitation.email}</span>
                    <span className="block truncate text-xs text-muted">
                      {t('Invited as {role}, until {date}', {
                        role: t(ROLE_WORDS[invitation.role]).toLowerCase(),
                        date: new Date(invitation.expiresAt).toLocaleDateString(),
                      })}
                    </span>
                  </span>
                </span>
                <span>
                  <Chip tone="done">{t('Invited')}</Chip>
                </span>
                <span className="hidden text-sm sm:block">{t('All')}</span>
                <span className="col-span-full flex flex-wrap justify-end gap-2 sm:col-span-1">
                  <Button tone="quiet" onClick={() => onResend(invitation)}>
                    {t('Resend')}
                  </Button>
                  <Confirm
                    label={t('Cancel')}
                    confirmLabel={t('Cancel the invitation of {email}', { email: invitation.email })}
                    consequence={t('The message already sent no longer lets {email} join.', {
                      email: invitation.email,
                    })}
                    onConfirm={() => onCancel(invitation)}
                  />
                </span>
              </div>
              {stuck?.row === invitation.id ? (
                <div className="px-4 pb-3">
                  <Problem>{t(stuck.problem)}</Problem>
                </div>
              ) : null}
            </li>
          ))}
    </ul>
  );
}
