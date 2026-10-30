import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  type Invitation,
  type Member,
  ORGANIZATION,
  type Role,
  type SharedSite,
  type Site,
  call,
  invitationLink,
  sendsMail,
} from '../api';
import { Confirmation } from '../confirm';
import { INVITED, type Message, messageOf } from '../invitation-message';
import { type Listed, edited, listedOf } from '../listed';
import { copyText, problemOf } from '../problems';
import { Button, Choice, DataTable, Field, Initial, LinkButton, LoadFailed, PageHead, Problem, folded } from '../ui';
import { useTypedSearch } from '../typed-search';
import { NotePages } from './notes';
import { useWorkspace } from './workspace';
import { locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';

const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

/** The roles an invitation gives: the worker refuses the others (FRU-104), and a guest names a site (FRU-250). */
type InvitedRole = 'guest' | 'member' | 'admin';

/** What the column « Sites » says of a row: every site, or the sites shared with a guest. */
function sitesOf(role: Role, sites: readonly SharedSite[] | undefined): string {
  if (role !== 'guest') return t('Every site');
  if (sites === undefined) return t('Shared ones');

  return sites.length === 0 ? t('No site') : sites.map((site) => siteLabel(site.origin)).join(', ');
}

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
/** The worker refused the site of a guest: it is no site of the workspace any more (FRU-250). */
const NO_SUCH_SITE = msg('This site is no longer one of the workspace. Choose another one.');
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
 * « Last seen » (FRU-249, Q7): the worker keeps a day of UTC and no hour, so that a colleague does not
 * learn when somebody works. « Today », « Yesterday », « 3 days ago » for the week, then the day.
 */
export function seenOn(day: string | undefined, now: number = Date.now()): string {
  if (day === undefined) return t('Not seen yet');
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.max(0, Math.round((today - at) / 86_400_000));
  if (days === 0) return t('Today');
  if (days === 1) return t('Yesterday');
  if (days < 7) return t('{count} days ago', { count: days });

  return new Date(at).toLocaleDateString(DAYS[locale()], { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * How many rows a page of the members, and of the invitations, shows (FRU-496). The worker gives the
 * members a page at a time, and every invitation that waits: the console cuts those in pages itself.
 */
const PAGE = 50;

/** The longest search the worker reads: `MEMBERS_SEARCH` of `organization-paths.ts`. A longer one is refused. */
const SEARCH_MOST = 100;

/** The invitations whose address holds the search, whatever its case and its accents. */
function invitationsFound(invitations: readonly Invitation[], search: string): readonly Invitation[] {
  const sought = folded(search.trim());

  return sought === '' ? invitations : invitations.filter((each) => folded(each.email).includes(sought));
}

/** What a list is while it is read again: itself when it is shown, « loading » when it is not. */
function whileRead<T>(current: Listed<T>): Listed<T> {
  return typeof current === 'string' ? 'loading' : current;
}

/**
 * Who belongs to the workspace, and who is invited, as screen 12 of the mockup of 2026-10-13 draws
 * them (FRU-247, on FRU-104): the invitation on one line and the table of the people. The legend of
 * the roles under the table is gone (FRU-437).
 *
 * The lists come from the organization plugin of better-auth, through the worker. A guest reads only
 * their own row: the worker refuses them the list (FRU-149).
 *
 * The last column is « Last seen » for an owner or an admin, who alone read it (FRU-249), and the
 * day somebody joined for the others. It is read beside the members, and the table does not wait
 * for it: its place in a row is kept, so a day that arrives moves nothing under a press.
 *
 * The guest of one site (FRU-250, Q3): « Guest, one site » in the form, offered when the workspace
 * has a site, with the list « Site » for that role only; the column « Sites » names the site of a
 * guest, and of an invitation of a guest.
 */
export default function Members() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const reads = workspace.role !== 'guest';
  const [mailed, setMailed] = useState(false);
  const [members, setMembers] = useState<Listed<Member>>('loading');
  // FRU-496: the page of the members that is shown, the search the worker answered it for, and how
  // many members that search finds. The invitations are cut in pages here.
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState<number | undefined>();
  const [invitationsFrom, setInvitationsFrom] = useState(0);
  const [typed, setTyped] = useTypedSearch(search, (q) => {
    setSearch(q);
    setOffset(0);
    setInvitationsFrom(0);
  });
  const membersAsked = useRef(0);
  const invitationsAsked = useRef(0);
  // Another workspace opens on its first page, with no search.
  const [pagedIn, setPagedIn] = useState(workspace.id);
  if (pagedIn !== workspace.id) {
    setPagedIn(workspace.id);
    setOffset(0);
    setSearch('');
    setInvitationsFrom(0);
  }
  // The day each account was last seen, by its id. `asking`: on its way. `undefined`: not for this
  // role, or refused; the column is then the day somebody joined.
  const seenAsked = useRef(0);
  const [seen, setSeen] = useState<Readonly<Record<string, string>> | 'asking' | undefined>(
    manages ? 'asking' : undefined,
  );
  const [invitations, setInvitations] = useState<Listed<Invitation>>('loading');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitedRole>('member');
  // The sites of the workspace: the ones a guest may be invited on, and for a guest their own.
  const [sites, setSites] = useState<readonly Site[] | undefined>();
  const [site, setSite] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<{ email: string; message: Message } | undefined>();
  const [stuck, setStuck] = useState<{ row: string; problem: string } | undefined>();
  const base = `${ORGANIZATION}`;
  const query = `organizationId=${encodeURIComponent(workspace.id)}`;

  const read = useCallback(async () => {
    setMailed(await sendsMail());
    // The sites are read beside the rest: the form and the column wait for nothing but them.
    void call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`).then((listed) =>
      setSites(listed.ok && Array.isArray(listed.data?.sites) ? listed.data.sites : undefined),
    );
    if (!reads) return;
    // The days come on their own: the table does not wait for them. Their place in a row is kept
    // (`min-w` of the cell), so a day that arrives moves nothing of the row.
    // An answer to a read that is no longer the last one, or of another workspace, is dropped: its
    // days are of another list. The days shown are taken away while the next ones are read.
    const asked = (seenAsked.current += 1);
    if (manages) {
      setSeen('asking');
      void call<{ seen: Record<string, string> }>('GET', `/console/workspaces/${workspace.id}/members/seen`).then(
        (days) => {
          if (asked !== seenAsked.current) return;
          setSeen(days.ok && typeof days.data?.seen === 'object' ? days.data.seen : undefined);
        },
      );
    }
    if (!manages) return;
    setInvitations(whileRead);
    // The answer of a read that is no longer the last one, of another workspace maybe, is dropped.
    const invited = (invitationsAsked.current += 1);
    const waiting = await call<Invitation[]>('GET', `${base}/list-invitations?${query}`);
    if (invited !== invitationsAsked.current) return;
    setInvitations(listedOf(waiting, (data) => data.filter((each) => each.status === 'pending')));
  }, [base, query, reads, manages, workspace.id]);

  /** The page of the members that is shown, for the search that is typed (FRU-496). */
  const readMembers = useCallback(
    async (after?: 'a-removal') => {
      if (!reads) return;
      // WARNING: a read made again keeps the rows that are shown. « Loading… » in their place took the
      // table away for the time of the read: what is under it went up, then down again, and an
      // action of a row was not there to press. Only a list that is not shown says that it is read.
      setMembers(whileRead);
      // The answer of a page or of a search that is no longer the one asked is dropped.
      const asked = (membersAsked.current += 1);
      const page = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (search !== '') page.set('q', search.slice(0, SEARCH_MOST));
      const listed = await call<{ members: Member[]; total?: number }>('GET', `${base}/list-members?${query}&${page}`);
      if (asked !== membersAsked.current) return;
      const rows = listedOf(listed, (data) => data.members);
      // A read after a removal that went through and that fails keeps the page, less the member: the
      // removal is done, and the table does not go for a read of the rows around it.
      if (rows === 'failed' && after === 'a-removal') return;
      setMembers(rows);
      setTotal(listed.ok && typeof listed.data?.total === 'number' ? listed.data.total : undefined);
    },
    [base, query, reads, offset, search],
  );

  /** Both lists, read again: after « Try again », and after a change that the worker refused. */
  const readAll = useCallback(() => {
    void read();
    void readMembers();
  }, [read, readMembers]);

  useEffect(() => void read(), [read]);
  useEffect(() => void readMembers(), [readMembers]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    setSentTo(undefined);
    setBusy(true);
    const address = email.trim();
    const sent = await call<Invitation>('POST', `${base}/invite-member`, {
      organizationId: workspace.id,
      email: address,
      role: chosen,
      ...(chosen === 'guest' && shared !== undefined ? { sites: [shared] } : {}),
    });
    setBusy(false);
    if (!sent.ok) {
      // A message that did not leave: the invitation is kept, so it is shown, to send again.
      if (sent.error === 'mail-unavailable') readAll();
      // The site was removed meanwhile: the list is read again, and the sentence says so.
      if (sent.error === 'invalid-request' && sent.field === 'sites') {
        readAll();

        return setProblem(NO_SUCH_SITE);
      }
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
      // A guest's names the same sites (FRU-250).
      ...(invitation.role === 'guest' && invitation.sites !== undefined
        ? { sites: invitation.sites.map((each) => each.id) }
        : {}),
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
      if (cancelled.error === 'INVITATION_NOT_FOUND') return readAll();

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
    // The row goes from the page, and the page is read again: the member after this page moves into it.
    setMembers((current) => edited(current, (items) => items.filter((each) => each.id !== member.id)));
    setTotal((count) => (count === undefined ? count : Math.max(0, count - 1)));
    // The last row of its page: the page before it is shown.
    const alone = typeof members !== 'string' && members.length === 1;
    if (alone && offset > 0) setOffset(Math.max(0, offset - PAGE));
    else void readMembers('a-removal');
  }

  const self = {
    id: 'self',
    userId: me.account.id,
    role: workspace.role,
    createdAt: '',
    user: { id: me.account.id, email: me.account.email, name: me.account.name ?? '' },
  } satisfies Member;
  // A guest reads their own row; their sites are the ones the worker lists to them.
  const mine =
    workspace.role === 'guest' && sites !== undefined ? { sites: sites.map(({ id, origin }) => ({ id, origin })) } : {};
  const people: Listed<Member> = reads ? members : [{ ...self, ...mine }];
  const waiting: Listed<Invitation> = manages ? invitations : [];
  // The invitations the search finds, and the first one of the page shown: a page past the end, after
  // a cancel or a search, is the last one.
  const found = typeof waiting === 'string' ? undefined : invitationsFound(waiting, search);
  const invitationsAt =
    found === undefined ? 0 : Math.min(invitationsFrom, Math.max(0, Math.ceil(found.length / PAGE) - 1) * PAGE);
  // A guest is invited on a site of the workspace: no site, no « Guest, one site ».
  const offersGuest = manages && sites !== undefined && sites.length > 0;
  const chosen: InvitedRole = role === 'guest' && !offersGuest ? 'member' : role;
  const shared = sites?.some((each) => each.id === site) ? site : sites?.[0]?.id;

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
              value={chosen}
              onChange={(value) => setRole(value as InvitedRole)}
              options={[
                ...(offersGuest ? [{ value: 'guest', label: t('Guest, one site') }] : []),
                { value: 'member', label: t('Member') },
                { value: 'admin', label: t('Admin') },
              ]}
            />
          </div>
          {chosen === 'guest' && shared !== undefined ? (
            <div className="min-w-0 flex-[1_1_200px]">
              <Choice
                label={t('Site')}
                value={shared}
                onChange={setSite}
                options={(sites ?? []).map((each) => ({ value: each.id, label: siteLabel(each.origin) }))}
              />
            </div>
          ) : null}
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
        <LoadFailed
          title={t('The members did not load')}
          detail={t('Fruitback did not answer. Your members are safe.')}
          retry={t('Try again')}
          onRetry={readAll}
        />
      ) : null}

      {typeof people !== 'string' && waiting !== 'failed' ? (
        <>
          {reads ? (
            <div className="mb-[20px] max-w-[420px]">
              <Field
                label={t('Search members')}
                labelHidden
                compact
                type="search"
                placeholder={t('Search by name or address')}
                maxLength={SEARCH_MOST}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          ) : null}
          <div>
            <h2 className="mb-[12px] text-section font-bold">
              {t('Members')}
              {reads && total !== undefined ? (
                <>
                  {' '}
                  <span className="font-normal text-muted tabular-nums">{total}</span>
                </>
              ) : null}
            </h2>
            {people.length === 0 ? (
              <p className="text-small text-muted">{t('Nobody matches this search.')}</p>
            ) : (
              <DataTable label={t('Members')} minWidth={760} dense>
                <thead>
                  <tr>
                    <th scope="col">{t('Person')}</th>
                    <th scope="col">{t('Role')}</th>
                    <th scope="col">{t('Sites')}</th>
                    {/* A guest reads their own row, which the worker gives no day: no column for one. */}
                    {reads ? (
                      <th scope="col" data-align="end">
                        {seen === undefined ? t('Joined') : t('Last seen')}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {people.map((member) => {
                    // « Last seen » for who reads it, else the day somebody joined.
                    const lastOf = (one: Member) => {
                      if (seen === 'asking') return '';
                      if (seen === undefined) return dayOf(one.createdAt, true) ?? '';

                      return seenOn(seen[one.userId]);
                    };
                    const name = nameOf(member);
                    const removes = manages && member.userId !== me.account.id;

                    return (
                      <Row
                        key={member.id}
                        initial={name}
                        name={member.userId === me.account.id ? t('{name} (you)', { name }) : name}
                        detail={member.user.email}
                        role={member.role}
                        sites={sitesOf(member.role, member.sites)}
                        when={reads ? lastOf(member) : undefined}
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
                </tbody>
              </DataTable>
            )}
            {reads && total !== undefined && total > PAGE && people.length > 0 ? (
              <NotePages
                label={t('Pages of members')}
                from={offset + 1}
                shown={people.length}
                total={total}
                first={offset === 0}
                last={offset + people.length >= total}
                onPage={(to) => setOffset((at) => (to === 'next' ? at + PAGE : Math.max(0, at - PAGE)))}
              />
            ) : null}
          </div>
          {found === undefined || (found.length === 0 && search === '') ? null : (
            <div className="mt-[32px]">
              <h2 className="mb-[12px] text-section font-bold">
                {t('Pending invitations')} <span className="font-normal text-muted tabular-nums">{found.length}</span>
              </h2>
              {found.length === 0 ? (
                <p className="text-small text-muted">{t('No invitation matches this search.')}</p>
              ) : (
                <DataTable label={t('Pending invitations')} minWidth={760} dense>
                  <thead>
                    <tr>
                      <th scope="col">{t('Person')}</th>
                      <th scope="col">{t('Role')}</th>
                      <th scope="col">{t('Sites')}</th>
                      <th scope="col" data-align="end">
                        {t('Invited on')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.slice(invitationsAt, invitationsAt + PAGE).map((invitation) => {
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
                          sites={sitesOf(invitation.role, invitation.sites)}
                          when={sent !== undefined && went ? t('Sent {date}', { date: sent }) : (sent ?? '')}
                          {...(until === undefined ? {} : { until: t('Until {date}', { date: until }) })}
                          problem={stuck?.row === invitation.id ? stuck.problem : undefined}
                          // No message left (FRU-269): the link to send by hand is on the row, after a reload too.
                          {...(went ? {} : { onCopy: () => copyText(invitationLink()) })}
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
              )}
              {found.length > PAGE ? (
                <NotePages
                  label={t('Pages of invitations')}
                  from={invitationsAt + 1}
                  shown={Math.min(PAGE, found.length - invitationsAt)}
                  total={found.length}
                  first={invitationsAt === 0}
                  last={invitationsAt + PAGE >= found.length}
                  onPage={(to) =>
                    setInvitationsFrom(to === 'next' ? invitationsAt + PAGE : Math.max(0, invitationsAt - PAGE))
                  }
                />
              ) : null}
            </div>
          )}
        </>
      ) : null}
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
  /** The column « Sites »: « Every site », or the sites of a guest. */
  sites: string;
  /** The last column: the day somebody joined, or the day an invitation was sent. No column: `undefined`. */
  when: string | undefined;
  /** Under the day of an invitation: the day it ends. */
  until?: string;
  onResend?: () => void;
  /** Copies the link of an invitation whose message did not leave. `false`: the browser refused. */
  onCopy?: () => Promise<boolean>;
  /** The gesture of the row that asks twice: « Remove », or « Cancel ». */
  asks?: { label: string; confirmLabel: string; consequence: string; onConfirm: () => void };
  /** Why the gesture of the row did not go through. */
  problem: string | undefined;
};

/** The row of a person or of an invitation, and under it the second time of its gesture. */
function Row({
  initial,
  pending = false,
  name,
  detail,
  role,
  sites,
  when,
  until,
  onResend,
  onCopy,
  asks,
  problem,
}: RowProps) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const refused =
    copied === 'refused'
      ? t('The browser refused the copy. The link is {link}: copy it by hand.', { link: invitationLink() })
      : undefined;
  const said = problem ?? refused;
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
          {/* As wide as « Not seen yet » at the least: a day that arrives after the row moves nothing. */}
          <span className="min-w-[96px]">
            <span className="block">{when}</span>
            {until === undefined ? null : <span className="block text-hint leading-[inherit]">{until}</span>}
          </span>
          {onCopy === undefined ? null : (
            <LinkButton onClick={() => void onCopy().then((taken) => setCopied(taken ? 'yes' : 'refused'))}>
              {copied === 'yes' ? t('Copied') : t('Copy the link')}
            </LinkButton>
          )}
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
        <td className="whitespace-nowrap">{t(ROLE_WORDS[role])}</td>
        <td className="[overflow-wrap:anywhere]">{sites}</td>
        {last}
      </tr>
      {(asking && asks !== undefined) || said !== undefined ? (
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
              {refused === undefined ? null : <Problem>{refused}</Problem>}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
