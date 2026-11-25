import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Invitation,
  type Member,
  ORGANIZATION,
  type Role,
  type SiteChoice,
  call,
  invitationLink,
  sendsMail,
  siteChoices,
} from '../api';
import { INVITED, INVITED_SEVERAL, type Message, invitedSentences, messageOf } from '../invitation-message';
import { type Listed, edited, listedOf } from '../listed';
import { copyText, problemOf } from '../problems';
import { Button, LinkButton, LoadFailed, folded } from '../ui';
import { useTypedSearch } from '../typed-search';
import { NotePages } from '../parts/note-pages';
import { InviteDialog, type InvitedRole, type Sent } from '../parts/members-invite';
import {
  type Column,
  MenuCell,
  MembersHead,
  MembersList,
  MembersSearch,
  type MembersTab,
  MembersTabs,
  NameCell,
  RoleCell,
  SitesCell,
  TextCell,
  UnderRow,
  useAsking,
} from '../parts/members-table';
import { useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { ReadProblem } from '../read-problem';
import { dayIn, seenOn } from '../ago';

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
const NOT_CANCELLED = msg('The invitation was not cancelled. Try again.');
const NOT_REMOVED = msg('This member was not removed. Try again.');
const MEMBER_PROBLEMS: Readonly<Record<string, string>> = {
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: msg('The last owner of a workspace stays in it.'),
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: msg('Only an owner removes an owner.'),
  forbidden: msg('Only an owner or an admin of the workspace changes its members.'),
};
/** What the worker answers to a change of role it refuses (`update-member-role`, FRU-209). */
const ROLE_PROBLEMS: Readonly<Record<string, string>> = {
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: msg('Only an owner changes the role of an owner.'),
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: msg('The last owner of a workspace stays its owner.'),
  forbidden: msg('Only an owner or an admin of the workspace changes its members.'),
};
const NOT_CHANGED = msg('The role was not changed. Try again.');
const COPIED = msg('The link is copied. Send it to them.');
const NOT_COPIED = msg('The browser refused the copy. The link is {link}: copy it by hand.');

/**
 * How many rows a page of the members, and of the invitations, shows (FRU-496). The worker gives the
 * members a page at a time, and every invitation that waits: the console cuts those in pages itself.
 */
const PAGE = 50;

/** The longest search the worker reads: `MEMBERS_SEARCH` of `organization-paths.ts`. A longer one is refused. */
const SEARCH_MOST = 100;

/**
 * The roles a change of role gives from this screen (FRU-691): `admin` and `member`, the ones of
 * `GIVEN_ROLES` of the worker less `owner`. An owner row is no list (« sauf Owner » of the ticket):
 * a workspace changes its owner from the administration of the instance (FRU-283).
 */
const GIVEN: readonly Role[] = ['member', 'admin'];

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
 * Who belongs to the workspace, and who is invited, as the mockup « Membres » of the redesign draws
 * them (FRU-691): a head of 48 px with « Invite », the tabs « Members » and « Invitations » with their
 * counts and the search, and one dense table a tab, a line of 36 px per person. Before, screen 12 of
 * the mockup of 2026-10-13 (FRU-247): two tables under their headings.
 *
 * The lists come from the organization plugin of better-auth, through the worker. A guest reads only
 * their own row: the worker refuses them the list (FRU-149). The invitations are for an owner or an
 * admin, who alone read them.
 *
 * « Last active » is for an owner or an admin, who alone read it (FRU-249): a day, never an hour. It is
 * read beside the members, and the table does not wait for it; its column is there from the start, so
 * a day that arrives moves nothing. « Joined » is the day somebody joined.
 *
 * An owner or an admin changes a role in its row (FRU-691): « Member » or « Admin », and « Guest » for a
 * guest, who keeps their sites with it. A guest made a member reads every site: that asks twice.
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
  const searchField = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<MembersTab>('members');
  const membersAsked = useRef(0);
  const invitationsAsked = useRef(0);
  // Another workspace opens on its first page, with no search, on its members.
  const [pagedIn, setPagedIn] = useState(workspace.id);
  if (pagedIn !== workspace.id) {
    setPagedIn(workspace.id);
    setOffset(0);
    setSearch('');
    setInvitationsFrom(0);
    setTab('members');
  }
  // The day each account was last seen, by its id. `asking`: on its way. `undefined`: not for this
  // role, or refused; the column then says nothing.
  const seenAsked = useRef(0);
  const [seen, setSeen] = useState<Readonly<Record<string, string>> | 'asking' | undefined>(
    manages ? 'asking' : undefined,
  );
  const [invitations, setInvitations] = useState<Listed<Invitation>>('loading');
  // The sites of the workspace: the ones a guest may be invited on, and for a guest their own.
  const [sites, setSites] = useState<readonly SiteChoice[] | undefined>();
  // FRU-565: the dialog of the invitation is open.
  const [inviting, setInviting] = useState(false);
  const [sentTo, setSentTo] = useState<readonly { email: string; message: Message }[]>([]);
  // What a row says under its line: why its gesture did not go through, or that its link is copied.
  const [stuck, setStuck] = useState<Stuck>();
  const asking = useAsking();
  const base = `${ORGANIZATION}`;
  const query = `organizationId=${encodeURIComponent(workspace.id)}`;

  const read = useCallback(async () => {
    setMailed(await sendsMail());
    // The sites are read beside the rest: the form and the column wait for nothing but them.
    // Their id and address only (FRU-497): no count of the notes of every site.
    void siteChoices(workspace.id).then((listed) =>
      setSites(listed.ok && Array.isArray(listed.data?.sites) ? listed.data.sites : undefined),
    );
    if (!reads) return;
    // The days come on their own: the table does not wait for them, and their column is there.
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

  /** One invitation of the dialog: the invitation the worker kept, or the sentence of its refusal. */
  async function invite(email: string, role: InvitedRole, site: string | undefined): Promise<Sent> {
    setSentTo([]);
    const sent = await call<Invitation>('POST', `${base}/invite-member`, {
      organizationId: workspace.id,
      email,
      role,
      ...(role === 'guest' && site !== undefined ? { sites: [site] } : {}),
    });
    if (sent.ok) return { ok: true, invitation: sent.data };
    // A message that did not leave: the invitation is kept, so it is shown, to send again from its row.
    if (sent.error === 'mail-unavailable') {
      readAll();

      return { ok: false, problem: problemOf(sent, INVITE_PROBLEMS, NOT_INVITED), kept: true };
    }
    // The site was removed meanwhile: the list is read again, and the sentence says so.
    if (sent.error === 'invalid-request' && sent.field === 'sites') {
      readAll();

      return { ok: false, problem: NO_SUCH_SITE };
    }

    return { ok: false, problem: problemOf(sent, INVITE_PROBLEMS, NOT_INVITED) };
  }

  function invited(kept: readonly Invitation[]) {
    setSentTo(kept.map((each) => ({ email: each.email, message: messageOf(each, mailed) })));
    setInvitations((current) =>
      edited(current, (items) => [...items.filter((each) => !kept.some((one) => one.id === each.id)), ...kept]),
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
    setSentTo([{ email: invitation.email, message: messageOf(sent.data, mailed) }]);
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

      return setStuck({ row: invitation.id, problem: problemOf(cancelled, {}, NOT_CANCELLED) });
    }
    setInvitations((current) => edited(current, (items) => items.filter((each) => each.id !== invitation.id)));
  }

  async function remove(member: Member) {
    setStuck(undefined);
    const removed = await call('POST', `${base}/remove-member`, {
      organizationId: workspace.id,
      memberIdOrEmail: member.id,
    });
    if (!removed.ok) return setStuck({ row: member.id, problem: problemOf(removed, MEMBER_PROBLEMS, NOT_REMOVED) });
    // The last row of a page past the first: the page before it is read, and the row stays until it
    // comes with its count. Taken away at once, the empty page said « Nobody matches this search. »
    // for the time of the read.
    const alone = typeof members !== 'string' && members.length === 1;
    if (alone && offset > 0) return setOffset(Math.max(0, offset - PAGE));
    // Else the row goes from the page, and the page is read again: the member after it moves in.
    setTotal((count) => (count === undefined ? count : Math.max(0, count - 1)));
    setMembers((current) => edited(current, (items) => items.filter((each) => each.id !== member.id)));
    void readMembers('a-removal');
  }

  /** A change of role (FRU-691), by the route of the plugin that the worker guards (`update-member-role`). */
  async function changeRole(member: Member, role: Role) {
    setStuck(undefined);
    const changed = await call('POST', `${base}/update-member-role`, {
      organizationId: workspace.id,
      memberId: member.id,
      role,
    });
    if (!changed.ok) return setStuck({ row: member.id, problem: problemOf(changed, ROLE_PROBLEMS, NOT_CHANGED) });
    // A guest given another role reads every site: the worker takes their sites away.
    setMembers((current) =>
      edited(current, (items) =>
        items.map((each) => {
          if (each.id !== member.id) return each;
          const { sites: _shared, ...rest } = each;

          return { ...rest, role };
        }),
      ),
    );
  }

  async function copyLink(invitation: Invitation) {
    const taken = await copyText(invitationLink());
    setStuck(
      taken
        ? { row: invitation.id, said: COPIED }
        : { row: invitation.id, problem: NOT_COPIED, values: { link: invitationLink() } },
    );
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
  // The list is drawn: the people were read, and the invitations did not fail. A read again keeps the
  // list of before (`whileRead`), so nothing below moves while it is on its way.
  const listed = typeof people !== 'string' && waiting !== 'failed';
  const shownTab: MembersTab = manages ? tab : 'members';

  return (
    <>
      <MembersHead
        // FRU-616: « Invite » comes with the list. While it loads, or when its read failed, the page
        // offers only the box of the failure and its « Try again ». The dialog stays mounted, so what
        // was typed in it is kept.
        action={
          manages && listed ? (
            <Button size="panel" onClick={() => setInviting(true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[14px] flex-none">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t('Invite')}
            </Button>
          ) : null
        }
      />
      {manages ? (
        <InviteDialog
          open={inviting}
          onClose={() => setInviting(false)}
          sites={sites}
          invite={invite}
          onInvited={invited}
        />
      ) : null}

      {listed ? (
        <MembersTabs
          tab={shownTab}
          onTab={(next) => {
            asking.done();
            setStuck(undefined);
            setTab(next);
          }}
          tabs={[
            { id: 'members', label: t('Members'), count: reads ? total : undefined },
            ...(manages ? [{ id: 'invitations' as const, label: t('Invitations'), count: found?.length }] : []),
          ]}
          search={
            reads ? <MembersSearch typed={typed} onType={setTyped} longest={SEARCH_MOST} field={searchField} /> : null
          }
        />
      ) : null}

      {sentTo.length === 0 ? null : <Invited sent={sentTo} />}

      {people === 'loading' ? <p className="mt-[24px] text-small text-muted">{t('Loading…')}</p> : null}

      {/* The box of a read that failed is the one of the Sites screen: the mockup draws no other. */}
      {people !== 'loading' && (people === 'failed' || waiting === 'failed') ? (
        <div className="mt-[24px]">
          <LoadFailed
            title={t('The members did not load')}
            detail={
              <>
                <ReadProblem /> {t('Your members are safe.')}
              </>
            }
            retry={t('Try again')}
            onRetry={readAll}
          />
        </div>
      ) : null}

      {listed && shownTab === 'members' ? (
        <>
          <MemberRows
            people={people}
            meId={me.account.id}
            manages={manages}
            reads={reads}
            seen={seen}
            stuck={stuck}
            asking={asking}
            onRole={(member, role) => void changeRole(member, role)}
            onRemove={(member) => void remove(member)}
          />
          {people.length === 0 ? (
            <p className="mt-[16px] text-small text-muted">{t('Nobody matches this search.')}</p>
          ) : null}
          {reads && total !== undefined && total > PAGE && people.length > 0 ? (
            <div className="mt-[16px]">
              <NotePages
                label={t('Pages of members')}
                from={offset + 1}
                shown={people.length}
                total={total}
                first={offset === 0}
                last={offset + people.length >= total}
                onPage={(to) => setOffset((at) => (to === 'next' ? at + PAGE : Math.max(0, at - PAGE)))}
                numbers={{
                  at: Math.floor(offset / PAGE) + 1,
                  count: Math.ceil(total / PAGE),
                  onGo: (to) => setOffset((to - 1) * PAGE),
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {listed && shownTab === 'invitations' && found !== undefined ? (
        <>
          <InvitationRows
            invitations={found.slice(invitationsAt, invitationsAt + PAGE)}
            mailed={mailed}
            stuck={stuck}
            asking={asking}
            onResend={(invitation) => void resend(invitation)}
            onCopy={(invitation) => void copyLink(invitation)}
            onCancel={(invitation) => void cancel(invitation)}
          />
          {found.length === 0 ? (
            <p className="mt-[16px] text-small text-muted">
              {search === '' ? t('No invitation waits.') : t('No invitation matches this search.')}
            </p>
          ) : null}
          {found.length > PAGE ? (
            <div className="mt-[16px]">
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
                numbers={{
                  at: Math.floor(invitationsAt / PAGE) + 1,
                  count: Math.ceil(found.length / PAGE),
                  onGo: (to) => setInvitationsFrom((to - 1) * PAGE),
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

type Asking = ReturnType<typeof useAsking>;
/**
 * What a row says under its line: why its gesture did not go through, or that its link is copied. The
 * sentences are kept in English with their values, and translated where they are shown, so they follow
 * a change of language.
 */
type Stuck = { row: string; problem?: string; said?: string; values?: Readonly<Record<string, string>> } | undefined;

/** The tab « Members »: a row of 36 px per person, and under a row what it asks or why it failed. */
function MemberRows({
  people,
  meId,
  manages,
  reads,
  seen,
  stuck,
  asking,
  onRole,
  onRemove,
}: {
  people: readonly Member[];
  meId: string;
  manages: boolean;
  reads: boolean;
  seen: Readonly<Record<string, string>> | 'asking' | undefined;
  stuck: Stuck;
  asking: Asking;
  onRole: (member: Member, role: Role) => void;
  onRemove: (member: Member) => void;
}) {
  useLocale();
  // « Last active » for who reads it (FRU-249); a guest reads their own row, which the worker gives no
  // day: no « Joined » for one.
  const columns: Column[] = [
    { key: 'name', label: t('Name'), width: manages ? '22%' : '26%' },
    { key: 'email', label: t('Email'), width: manages ? '22%' : '26%' },
    { key: 'role', label: t('Role'), width: manages ? '13%' : '15%' },
    { key: 'sites', label: t('Sites'), width: manages ? '17%' : '19%' },
    ...(manages ? [{ key: 'seen', label: t('Last active'), width: '11%' }] : []),
    ...(reads ? [{ key: 'joined', label: t('Joined'), width: manages ? '11%' : '14%' }] : []),
    ...(manages ? [{ key: 'menu', label: t('Actions'), width: '4%' }] : []),
  ];
  if (people.length === 0) return null;

  return (
    <MembersList tab="members" label={t('Members')} columns={columns}>
      {people.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          you={member.userId === meId}
          manages={manages}
          reads={reads}
          seen={seen}
          span={columns.length}
          stuck={stuck?.row === member.id ? stuck : undefined}
          asking={asking}
          onRole={(role) => onRole(member, role)}
          onRemove={() => onRemove(member)}
        />
      ))}
    </MembersList>
  );
}

function nameOf(member: Member): string {
  return member.user.name.trim() || member.user.email.split('@')[0] || member.user.email;
}

function MemberRow({
  member,
  you,
  manages,
  reads,
  seen,
  span,
  stuck,
  asking,
  onRole,
  onRemove,
}: {
  member: Member;
  you: boolean;
  manages: boolean;
  reads: boolean;
  seen: Readonly<Record<string, string>> | 'asking' | undefined;
  span: number;
  stuck: Stuck;
  asking: Asking;
  onRole: (role: Role) => void;
  onRemove: () => void;
}) {
  useLocale();
  const roleCell = useRef<HTMLTableCellElement>(null);
  const menuCell = useRef<HTMLTableCellElement>(null);
  const name = nameOf(member);
  // Nobody changes their own role or removes themselves here, and an owner row is no list: the
  // worker refuses an admin both (`workspace-keeps-owner.test.ts`), and an owner leaves a workspace
  // to another owner from the administration.
  const changes = manages && !you && member.role !== 'owner';
  let roles: readonly Role[] = [];
  if (changes) roles = member.role === 'guest' ? ['guest', ...GIVEN] : GIVEN;
  const asked = asking.askedOf(member.id);
  const mine = (what: { confirmLabel: string; consequence: string; act: () => void }, from: typeof roleCell) =>
    asking.ask(
      member.id,
      { confirmLabel: what.confirmLabel, consequence: what.consequence, onConfirm: what.act },
      from,
    );
  const choose = (role: Role) => {
    // A guest given another role reads every site of the workspace: that asks twice.
    if (member.role !== 'guest') return onRole(role);
    mine(
      {
        confirmLabel: role === 'admin' ? t('Make {name} an admin', { name }) : t('Make {name} a member', { name }),
        consequence: t('{name} reads every site of the workspace, not only the sites shared with them.', { name }),
        act: () => onRole(role),
      },
      roleCell,
    );
  };
  let last = '';
  if (seen !== 'asking' && seen !== undefined) last = seenOn(seen[member.userId]);

  return (
    <>
      <tr className="[&:hover]:bg-hover" data-member={member.id}>
        <NameCell initial={name} name={name} you={you} />
        <TextCell tone="soft">{member.user.email}</TextCell>
        <RoleCell role={member.role} roles={roles} name={name} onChoose={choose} cell={roleCell} />
        <SitesCell role={member.role} sites={member.sites} />
        {manages ? <TextCell>{last}</TextCell> : null}
        {reads ? <TextCell>{dayIn(member.createdAt, 'always') ?? ''}</TextCell> : null}
        {manages ? (
          <MenuCell
            cell={menuCell}
            label={t('Actions for {name}', { name })}
            items={manages && !you ? [{ id: 'remove', label: t('Remove from workspace'), danger: true }] : []}
            onAction={() =>
              mine(
                {
                  confirmLabel: t('Remove {name}', { name }),
                  consequence: t(
                    '{name} leaves the workspace, and their extension stops reading its sites. Their notes stay.',
                    { name },
                  ),
                  act: onRemove,
                },
                menuCell,
              )
            }
          />
        ) : null}
      </tr>
      <UnderRow
        span={span}
        asked={asked}
        onKeep={asking.keep}
        problem={stuck?.problem}
        said={stuck?.said}
        values={stuck?.values}
      />
    </>
  );
}

/** The tab « Invitations »: a row of 36 px per invitation that waits, for an owner or an admin. */
function InvitationRows({
  invitations,
  mailed,
  stuck,
  asking,
  onResend,
  onCopy,
  onCancel,
}: {
  invitations: readonly Invitation[];
  mailed: boolean;
  stuck: Stuck;
  asking: Asking;
  onResend: (invitation: Invitation) => void;
  onCopy: (invitation: Invitation) => void;
  onCancel: (invitation: Invitation) => void;
}) {
  useLocale();
  const columns: Column[] = [
    { key: 'email', label: t('Email'), width: '27%' },
    { key: 'role', label: t('Role'), width: '12%' },
    { key: 'sites', label: t('Sites'), width: '18%' },
    { key: 'message', label: t('Message'), width: '15%' },
    { key: 'sent', label: t('Invited'), width: '12%' },
    { key: 'until', label: t('Expires'), width: '12%' },
    { key: 'menu', label: t('Actions'), width: '4%' },
  ];
  if (invitations.length === 0) return null;

  return (
    <MembersList tab="invitations" label={t('Invitations')} columns={columns}>
      {invitations.map((invitation) => (
        <InvitationRow
          key={invitation.id}
          invitation={invitation}
          mailed={mailed}
          span={columns.length}
          stuck={stuck?.row === invitation.id ? stuck : undefined}
          asking={asking}
          onResend={() => onResend(invitation)}
          onCopy={() => onCopy(invitation)}
          onCancel={() => onCancel(invitation)}
        />
      ))}
    </MembersList>
  );
}

function InvitationRow({
  invitation,
  mailed,
  span,
  stuck,
  asking,
  onResend,
  onCopy,
  onCancel,
}: {
  invitation: Invitation;
  mailed: boolean;
  span: number;
  stuck: Stuck;
  asking: Asking;
  onResend: () => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  useLocale();
  const menuCell = useRef<HTMLTableCellElement>(null);
  const roleCell = useRef<HTMLTableCellElement>(null);
  // No message left for this one: the worker has no mailer, or it said so when it kept the invitation
  // (FRU-209). The invitation is kept, and its link is given by hand: « Copy invite link » in its menu
  // (FRU-269), after a reload too.
  const went = messageOf(invitation, mailed) === 'sent';
  const email = invitation.email;
  const confirmLabel = t('Cancel the invitation of {email}', { email });
  const asked = asking.askedOf(invitation.id);

  return (
    <>
      <tr className="[&:hover]:bg-hover" data-invitation={invitation.id}>
        <NameCell initial={email} name={email} pending />
        <RoleCell role={invitation.role} roles={[]} name={email} onChoose={() => undefined} cell={roleCell} />
        <SitesCell role={invitation.role} sites={invitation.sites} />
        <TextCell tone="soft">{went ? t('Invitation sent') : t('Invitation kept')}</TextCell>
        <TextCell>{dayIn(invitation.createdAt, 'never') ?? ''}</TextCell>
        <TextCell>{dayIn(invitation.expiresAt, 'never') ?? ''}</TextCell>
        <MenuCell
          cell={menuCell}
          label={t('Actions for {email}', { email })}
          items={[
            { id: 'resend', label: t('Resend invitation') },
            ...(went ? [] : [{ id: 'copy', label: t('Copy invite link') }]),
            { id: 'cancel', label: t('Cancel invitation'), danger: true },
          ]}
          onAction={(id) => {
            if (id === 'resend') return onResend();
            if (id === 'copy') return onCopy();
            asking.ask(
              invitation.id,
              {
                confirmLabel,
                consequence: t('The message already sent no longer lets {email} join.', { email }),
                onConfirm: onCancel,
              },
              menuCell,
            );
          }}
        />
      </tr>
      <UnderRow
        span={span}
        asked={asked}
        onKeep={asking.keep}
        problem={stuck?.problem}
        said={stuck?.said}
        values={stuck?.values}
      />
    </>
  );
}

/**
 * What an invitation became, and the link to send by hand (FRU-104, decided on FRU-107): the link
 * opens nothing by itself, so a chat is as good as a message. With a mailer, the message went too.
 * Several addresses invited at once (FRU-691) each have their sentence, over one link.
 */
/** The short guide of a client who leaves notes: `docs/leave-a-note.md` (FRU-642). */
const LEAVE_A_NOTE_GUIDE = 'https://fruitback.com/leave-a-note.html';

function Invited({ sent }: { sent: readonly { email: string; message: Message }[] }) {
  useLocale();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const link = invitationLink();
  const one = sent.length === 1 ? sent[0] : undefined;

  return (
    <div role="status" className="mt-[16px] rounded-card border border-line bg-subtle px-[20px] py-[16px] text-small">
      {invitedSentences(sent).map(({ message, emails }) => (
        <p key={message}>
          {emails.length === 1
            ? t(INVITED[message], { email: emails[0]! })
            : t(INVITED_SEVERAL[message], { emails: emails.join(', ') })}
        </p>
      ))}
      <p className="mt-[10px] rounded-control border border-line bg-surface px-[12px] py-[8px] font-mono text-hint break-all">
        {link}
      </p>
      <p className="mt-[10px] text-hint text-muted">
        {one === undefined
          ? t('They open it, sign in with the address that was invited, and join. The link alone opens nothing.')
          : t('They open it, sign in with {email}, and join. The link alone opens nothing.', { email: one.email })}
      </p>
      <p className="mt-[10px] text-hint text-muted">
        {t('Their first note, in two minutes:')}{' '}
        <LinkButton space="inline" href={LEAVE_A_NOTE_GUIDE} newTab>
          {t('How to leave a note')}
        </LinkButton>
      </p>
      <div className="mt-[14px]">
        <Button
          tone="outline"
          size="panel"
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
