import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Invitation, type Member, ORGANIZATION, type Role, call, invitationLink, sendsMail } from '../api';
import { Confirmation } from '../confirm';
import { INVITED, type Message, messageOf } from '../invitation-message';
import { type Listed, edited, known, listedOf } from '../listed';
import { DID_NOT_ANSWER, copyText, problemOf } from '../problems';
import { Button, Choice, DataTable, Field, Initial, LinkButton, PageHead, Problem } from '../ui';
import { useWorkspace } from './workspace';
import { locale, msg, t } from '../i18n';
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

/** « 3 Oct », as the mockup writes a day: the day first, in the language of the console. */
const DAYS = { en: 'en-GB', fr: 'fr' } as const;

/** The day of a date of the worker, with its year when asked. Nothing for a date that is not one. */
function dayOf(iso: string | undefined, year: boolean): string | undefined {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toLocaleDateString(DAYS[locale()], {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' as const } : {}),
  });
}

/**
 * Who belongs to the workspace, and who is invited, as screen 12 of the mockup of 2026-10-13 draws
 * them (FRU-247, on FRU-104): the invitation on one line, the table of the people, and what each
 * role does.
 *
 * The lists come from the organization plugin of better-auth, through the worker. A guest reads only
 * their own row: the worker refuses them the list (FRU-149).
 *
 * Not here, because the worker of today cannot say them: when somebody was last seen (the last
 * column is the day they joined), and the one site of a guest (an invitation is for a member or an
 * admin, and « Sites » says every site, or the shared ones for a guest).
 */
export default function Members() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const reads = workspace.role !== 'guest';
  const [mailed, setMailed] = useState(false);
  const [members, setMembers] = useState<Listed<Member>>('loading');
  const [invitations, setInvitations] = useState<Listed<Invitation>>('loading');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitedRole>('member');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<{ email: string; message: Message } | undefined>();
  const [stuck, setStuck] = useState<{ row: string; problem: string } | undefined>();
  const base = `${ORGANIZATION}`;
  const query = `organizationId=${encodeURIComponent(workspace.id)}`;

  const read = useCallback(async () => {
    setMailed(await sendsMail());
    if (!reads) return;
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
      // A message that did not leave: the invitation is kept, so it is shown, to send again.
      if (sent.error === 'mail-unavailable') void read();
      // The field keeps what was typed: the sentence says the cause.
      return setProblem(problemOf(sent, INVITE_PROBLEMS, NOT_INVITED));
    }
    setSentTo({ email: sent.data.email, message: messageOf(sent.data, mailed) });
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
    setSentTo({ email: invitation.email, message: messageOf(sent.data, mailed) });
    // A message that did not leave this time says nothing of the ones before it: the row keeps what
    // it knew of them.
    setInvitations((current) =>
      edited(current, (items) =>
        items.map((each) => {
          if (each.id !== sent.data.id) return each;
          const { mailed: leftNow, ...rest } = sent.data;
          const left = leftNow === false ? each.mailed : leftNow;

          return left === undefined ? rest : { ...rest, mailed: left };
        }),
      ),
    );
  }

  async function cancel(invitation: Invitation) {
    setStuck(undefined);
    const cancelled = await call('POST', `${base}/cancel-invitation`, {
      organizationId: workspace.id,
      invitationId: invitation.id,
    });
    if (!cancelled.ok) {
      // It was accepted, declined or cancelled in the meantime: the list is read again.
      if (cancelled.error === 'INVITATION_NOT_FOUND') return void read();

      return setStuck({ row: invitation.id, problem: problemOf(cancelled, {}, NOT_CHANGED) });
    }
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
  const people: Listed<Member> = reads ? members : [self];
  const waiting: Listed<Invitation> = manages ? invitations : [];
  // What a guest does is said only where a guest is on the screen: nobody is invited as one yet.
  const guests =
    workspace.role === 'guest' ||
    [...(known(people) ?? []), ...(known(waiting) ?? [])].some((each) => each.role === 'guest');

  return (
    <>
      <PageHead
        title={t('Members')}
        lead={t('Who sees and leaves notes, and who changes the workspace.')}
        className="mb-[24px]"
      />
      {manages ? (
        <form
          onSubmit={invite}
          aria-label={t('Invite someone')}
          className="mb-[24px] flex flex-wrap items-end gap-[10px]"
        >
          <div className="min-w-0 flex-[999_1_260px]">
            <Field
              label={t('Email')}
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="min-w-0 flex-[1_1_200px]">
            <Choice
              label={t('Role')}
              value={role}
              onChange={(value) => setRole(value as InvitedRole)}
              options={[
                { value: 'member', label: t('Member') },
                { value: 'admin', label: t('Admin') },
              ]}
            />
          </div>
          <Button type="submit" inset={24} disabled={busy || email.trim() === ''}>
            {busy ? t('Sending…') : t('Invite')}
          </Button>
        </form>
      ) : null}
      {problem === undefined ? null : (
        <div className="mb-[24px]">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
      {sentTo === undefined ? null : <Invited email={sentTo.email} message={sentTo.message} />}

      {people === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

      {/* The box of a read that failed is the one of the Sites screen: the mockup draws no other. */}
      {people !== 'loading' && (people === 'failed' || waiting === 'failed') ? (
        <div className="box-content flex max-w-[760px] flex-wrap items-center justify-between gap-[16px] rounded-frame border border-control px-[32px] py-[28px]">
          <p role="alert" className="text-body text-muted">
            {t(DID_NOT_ANSWER)}
          </p>
          <Button tone="outline" size="page" inset={18} onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}

      {typeof people !== 'string' && waiting !== 'failed' ? (
        <DataTable label={t('Members')} minWidth={760} dense>
          <thead>
            <tr>
              <th scope="col">{t('Person')}</th>
              <th scope="col">{t('Role')}</th>
              <th scope="col">{t('Sites')}</th>
              {/* A guest reads their own row, which the worker gives no day: no column for one. */}
              {reads ? (
                <th scope="col" data-align="end">
                  {t('Joined')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {people.map((member) => {
              const name = nameOf(member);
              const removes = manages && member.userId !== me.account.id;

              return (
                <Row
                  key={member.id}
                  initial={name}
                  name={member.userId === me.account.id ? t('{name} (you)', { name }) : name}
                  detail={member.user.email}
                  role={member.role}
                  when={reads ? (dayOf(member.createdAt, true) ?? '') : undefined}
                  problem={stuck?.row === member.id ? stuck.problem : undefined}
                  {...(removes
                    ? {
                        asks: {
                          label: t('Remove'),
                          confirmLabel: t('Remove {name}', { name }),
                          consequence: t(
                            '{name} leaves the workspace, and their extension stops reading its sites. Their notes stay.',
                            { name },
                          ),
                          onConfirm: () => void remove(member),
                        },
                      }
                    : {})}
                />
              );
            })}
            {typeof waiting === 'string'
              ? null
              : waiting.map((invitation) => {
                  const sent = dayOf(invitation.createdAt, false);
                  const until = dayOf(invitation.expiresAt, false);
                  // No message left for this one: the worker has no mailer, or it said so when it kept
                  // the invitation (FRU-209). The invitation is kept, and its link is given by hand.
                  const went = messageOf(invitation, mailed) === 'sent';

                  return (
                    <Row
                      key={invitation.id}
                      pending
                      initial={invitation.email}
                      name={invitation.email}
                      detail={went ? t('Invitation sent') : t('Invitation kept')}
                      role={invitation.role}
                      when={sent !== undefined && went ? t('Sent {date}', { date: sent }) : (sent ?? '')}
                      {...(until === undefined ? {} : { until: t('Until {date}', { date: until }) })}
                      problem={stuck?.row === invitation.id ? stuck.problem : undefined}
                      onResend={() => void resend(invitation)}
                      asks={{
                        label: t('Cancel'),
                        confirmLabel: t('Cancel the invitation of {email}', { email: invitation.email }),
                        consequence: t('The message already sent no longer lets {email} join.', {
                          email: invitation.email,
                        }),
                        onConfirm: () => void cancel(invitation),
                      }}
                    />
                  );
                })}
          </tbody>
        </DataTable>
      ) : null}

      <dl className="mt-[28px] grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-x-[32px] gap-y-[16px] text-small">
        <div>
          <dt className="font-semibold">{t('Admin')}</dt>
          <dd className="mt-[2px] text-muted">{t('Sites, connectors and members.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Member')}</dt>
          <dd className="mt-[2px] text-muted">{t('Every site. Sees the links to the tracker.')}</dd>
        </div>
        {guests ? (
          <div>
            <dt className="font-semibold">{t('Guest')}</dt>
            <dd className="mt-[2px] text-muted">
              {t('Only the sites shared with them. Free, and never sees the tracker.')}
            </dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

/**
 * What an invitation became, and the link to send by hand (FRU-104, decided on FRU-107): the link
 * opens nothing by itself, so a chat is as good as a message. With a mailer, the message went too.
 * The mockup draws none: it is a block of its « Check your inbox ».
 */
function Invited({ email, message }: { email: string; message: Message }) {
  useLocale();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const link = invitationLink();

  return (
    <div role="status" className="mb-[24px] rounded-frame border border-line bg-subtle px-[22px] py-[20px] text-small">
      <p>{t(INVITED[message], { email })}</p>
      <p className="mt-[10px] rounded-button border border-line bg-surface px-[12px] py-[8px] font-mono text-hint break-all">
        {link}
      </p>
      <p className="mt-[10px] text-hint text-muted">
        {t('They open it, sign in with {email}, and join. The link alone opens nothing.', { email })}
      </p>
      <div className="mt-[14px]">
        <Button
          tone="outline"
          onClick={() => void copyText(link).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
        >
          {copied === 'yes' ? t('Copied') : t('Copy the link')}
        </Button>
      </div>
      {copied === 'refused' ? (
        <p role="alert" className="mt-[10px] text-hint text-muted">
          {t('The browser refused the copy. Select the link above and copy it by hand.')}
        </p>
      ) : null}
    </div>
  );
}

function nameOf(member: Member): string {
  return member.user.name.trim() || member.user.email.split('@')[0] || member.user.email;
}

type RowProps = {
  /** What the initial of the round chip is read from. */
  initial: string;
  /** Somebody invited who has not come: the chip is empty of colour. */
  pending?: boolean;
  name: string;
  /** The second line: an address, or « Invitation sent ». */
  detail: string;
  role: Role;
  /** The last column: the day somebody joined, or the day an invitation was sent. No column: `undefined`. */
  when: string | undefined;
  /** Under the day of an invitation: the day it ends. */
  until?: string;
  onResend?: () => void;
  /** The gesture of the row that asks twice: « Remove », or « Cancel ». */
  asks?: { label: string; confirmLabel: string; consequence: string; onConfirm: () => void };
  /** Why the gesture of the row did not go through. */
  problem: string | undefined;
};

/** The row of a person or of an invitation, and under it the second time of its gesture. */
function Row({ initial, pending = false, name, detail, role, when, until, onResend, asks, problem }: RowProps) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const actions = useRef<HTMLSpanElement>(null);
  // « Keep it » and Escape give focus back to the button that asked, the last one of the row.
  const keep = () => {
    setAsking(false);
    [...(actions.current?.querySelectorAll('button') ?? [])].at(-1)?.focus();
  };
  const last: ReactNode =
    when === undefined ? null : (
      <td data-align="end" className="whitespace-nowrap text-muted tabular-nums">
        <span ref={actions} className="inline-flex items-center gap-[16px]">
          <span>
            <span className="block">{when}</span>
            {until === undefined ? null : <span className="block text-hint leading-[inherit]">{until}</span>}
          </span>
          {onResend === undefined ? null : <LinkButton onClick={onResend}>{t('Resend')}</LinkButton>}
          {asks === undefined ? null : <LinkButton onClick={() => setAsking(true)}>{asks.label}</LinkButton>}
        </span>
      </td>
    );

  return (
    <>
      <tr>
        <td>
          <span className="flex items-center gap-[12px]">
            <Initial name={initial} pending={pending} />
            <span className="min-w-0">
              <span className="block font-semibold [overflow-wrap:anywhere]">{name}</span>
              <span className="block text-hint leading-[inherit] text-muted [overflow-wrap:anywhere]">{detail}</span>
            </span>
          </span>
        </td>
        <td>{t(ROLE_WORDS[role])}</td>
        <td>{role === 'guest' ? t('Shared ones') : t('Every site')}</td>
        {last}
      </tr>
      {(asking && asks !== undefined) || problem !== undefined ? (
        <tr className="bg-subtle">
          <td colSpan={when === undefined ? 3 : 4}>
            {/* The table is wider than a phone and scrolls in its frame: what the gesture costs stays
                in what is seen of it, at the padding of a cell, and as wide as the frame at most. */}
            <div className="sticky left-[20px] flex max-w-[calc(100vw-72px)] flex-col gap-[12px] py-[6px]">
              {asking && asks !== undefined ? (
                <Confirmation
                  confirmLabel={asks.confirmLabel}
                  consequence={asks.consequence}
                  onConfirm={asks.onConfirm}
                  onKeep={keep}
                />
              ) : null}
              {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
