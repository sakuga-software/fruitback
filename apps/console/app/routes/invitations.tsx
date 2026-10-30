import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type Invitation,
  type Me,
  ORGANIZATION,
  type Site,
  call,
  callUntilAnswered,
  myInvitations,
  signOut,
} from '../api';
import { msg, t } from '../i18n';
import { FIREFOX_ADDONS, extensionInstallFor } from '../extension-store';
import { useConnectedExtension } from '../extension-connected';
import { BY_SIGN_IN, CONNECT_PAGE } from '../install-options';
import { problemOf } from '../problems';
import { withStrong } from '../sign-in-form';
import { Button, EntryPage, Initial, KeyValue, Lead, LinkButton, Problem, StatusDot, SuccessMark, Title } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import { ReadProblem } from '../read-problem';

/**
 * The invitation that waits for the person who is signed in (FRU-104), as screen 03 of the mockup of
 * 2026-10-13 draws it (FRU-241): who invites, the role, « Join », then « You are in ».
 *
 * The link of an invitation holds no id and signs nobody in: the worker lists the invitations sent
 * to the address this session proved, and only that session accepts one. Somebody who is not signed
 * in is asked to sign in with the address the message came to.
 */

const ROLE_WORDS: Readonly<Record<string, string>> = {
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};
/** What a role lets its person do, said before they join. A role this screen does not know reads as a member. */
const ROLE_MEANS: Readonly<Record<string, string>> = {
  admin: msg('You join as an admin: you manage the sites, the connectors and the members of {workspace}.'),
  member: msg('You join as a member: you see and leave notes on every site of {workspace}.'),
  guest: msg(
    'You join as a guest: you see and leave notes on this site only. Guests are free and never see the tracker.',
  ),
};

/** The hosts of the sites an invitation of a guest names (FRU-250), « staging.acme.dev ». */
function hostsOf(invitation: Invitation): string | undefined {
  const hosts = (invitation.sites ?? []).map((site) => siteLabel(site.origin));

  return hosts.length === 0 ? undefined : hosts.join(', ');
}
const ANSWER_PROBLEMS: Readonly<Record<string, string>> = {
  INVITATION_NOT_FOUND: msg('This invitation was cancelled, or it ended. Ask for another one.'),
  INVITER_NO_LONGER_INVITES: msg('This invitation was cancelled, or it ended. Ask for another one.'),
};
const NOT_ANSWERED = msg('Your answer was not sent. Try again.');
const STILL_SIGNED_IN = msg('You are still signed in: Fruitback did not confirm the sign-out. Try again.');

type Read =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'failed' }
  | { kind: 'listed'; email: string; invitations: Invitation[] }
  /** Joined: the workspace, and its first site when it has one to name. */
  | { kind: 'joined'; workspace: string; name: string; site?: Site };

/** The name of the workspace of an invitation, or its id for a worker that does not say the name. */
function nameOf(invitation: Invitation): string {
  return invitation.organizationName ?? invitation.organizationId;
}

/** The most recent first: the one the message that was just opened is about. */
function latestFirst(invitations: Invitation[]): Invitation[] {
  const sent = (invitation: Invitation) => Date.parse(invitation.createdAt ?? invitation.expiresAt);

  return [...invitations].sort((one, other) => sent(other) - sent(one));
}

export default function Invitations() {
  useLocale();
  const navigate = useNavigate();
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [stuck, setStuck] = useState<{ id: string; problem: string } | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(() => {
    setRead({ kind: 'loading' });

    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return setRead({ kind: 'signed-out' });
      void myInvitations().then((invitations) =>
        setRead(
          invitations.ok
            ? { kind: 'listed', email: me.data.account.email, invitations: latestFirst(invitations.data) }
            : { kind: 'failed' },
        ),
      );
    });
  }, []);

  useEffect(() => load(), [load]);

  async function answer(invitation: Invitation, accept: boolean) {
    setStuck(undefined);
    setBusy(invitation.id);
    const route = accept ? 'accept-invitation' : 'reject-invitation';
    const answered = await call('POST', `${ORGANIZATION}/${route}`, { invitationId: invitation.id });
    if (!answered.ok) {
      setBusy(undefined);

      return setStuck({ id: invitation.id, problem: problemOf(answered, ANSWER_PROBLEMS, NOT_ANSWERED) });
    }
    if (!accept) {
      setBusy(undefined);

      return setRead((current) =>
        current.kind === 'listed'
          ? { ...current, invitations: current.invitations.filter((each) => each.id !== invitation.id) }
          : current,
      );
    }
    // The first site of the workspace, to name it in what comes next. A list that could not be
    // read names none: the screen then speaks of the sites of the workspace.
    const sites = await call<{ sites: Site[] }>(
      'GET',
      `/console/workspaces/${invitation.organizationId}/sites?limit=1&counts=none`,
    );
    const site = sites.ok ? sites.data.sites[0] : undefined;
    setBusy(undefined);
    setRead({
      kind: 'joined',
      workspace: invitation.organizationId,
      name: nameOf(invitation),
      ...(site === undefined ? {} : { site }),
    });
  }

  /** « Use another address »: the session ends, and the sign-in page is for the other address. */
  async function another(invitation: Invitation) {
    setStuck(undefined);
    if (await signOut()) return navigate('/sign-in', { replace: true });
    // A session that did not end is said: the person believes they left this account.
    setStuck({ id: invitation.id, problem: STILL_SIGNED_IN });
  }

  return (
    <EntryPage width="wide">
      {read.kind === 'loading' ? <p aria-busy="true" /> : null}
      {read.kind === 'signed-out' ? (
        <Note
          title={t('Invitations')}
          lead={t('Sign in with the address the invitation was sent to, and it shows here.')}
          action={<Button to="/sign-in">{t('Sign in')}</Button>}
        />
      ) : null}
      {read.kind === 'failed' ? (
        <Note
          title={t('Invitations')}
          lead={
            <>
              <ReadProblem /> {t('Your invitations are safe.')}
            </>
          }
          alert
          action={
            <Button tone="outline" size="page" onClick={load}>
              {t('Try again')}
            </Button>
          }
        />
      ) : null}
      {read.kind === 'listed' && read.invitations.length === 0 ? (
        <Note
          title={t('Invitations')}
          lead={t(
            'No invitation waits for {email}. An invitation sent to another address shows to that address only.',
            {
              email: read.email,
            },
          )}
          action={
            <LinkButton space="loose" to="/">
              {t('Go to the console')}
            </LinkButton>
          }
        />
      ) : null}
      {read.kind === 'listed' && read.invitations[0] !== undefined ? (
        <Invited
          email={read.email}
          invitation={read.invitations[0]}
          others={read.invitations.slice(1)}
          busy={busy}
          stuck={stuck}
          onAnswer={(each, accept) => void answer(each, accept)}
          onAnother={(each) => void another(each)}
        />
      ) : null}
      {read.kind === 'joined' ? <Joined workspace={read.workspace} name={read.name} site={read.site} /> : null}
    </EntryPage>
  );
}

/** A state with nothing to join: a title, what happened, and the one way on. */
function Note({
  title,
  lead,
  action,
  alert = false,
}: {
  title: string;
  lead: ReactNode;
  action: ReactNode;
  alert?: boolean;
}) {
  return (
    <>
      <div className="mb-2.5">
        <Title>{title}</Title>
      </div>
      <p {...(alert ? { role: 'alert' as const } : {})} className="mb-7 text-lead text-muted wrap-anywhere">
        {lead}
      </p>
      <div>{action}</div>
    </>
  );
}

type InvitedProps = {
  email: string;
  invitation: Invitation;
  others: Invitation[];
  busy: string | undefined;
  stuck: { id: string; problem: string } | undefined;
  onAnswer: (invitation: Invitation, accept: boolean) => void;
  onAnother: (invitation: Invitation) => void;
};

/** The invitation on the screen, and under it the others that wait for the same address. */
function Invited({ email, invitation, others, busy, stuck, onAnswer, onAnother }: InvitedProps) {
  useLocale();
  const workspace = nameOf(invitation);
  // The guest of one site (FRU-250): the screen names the site they review.
  const site = invitation.role === 'guest' ? hostsOf(invitation) : undefined;

  return (
    <>
      <p className="mb-5 flex items-center gap-2.5 text-small leading-auto text-muted">
        <Initial name={workspace} size="small" />
        <span className="min-w-0 wrap-anywhere">
          {withStrong(msg('{workspace} invited you'), 'workspace', workspace, 'text-ink')}
        </span>
      </p>
      <div className="mb-2.5 text-balance wrap-anywhere">
        <Title>
          {site === undefined
            ? t('Join {workspace} on Fruitback', { workspace })
            : t('Review {site} with {workspace}', { site, workspace })}
        </Title>
      </div>
      <Lead className="mb-6">{t(ROLE_MEANS[invitation.role] ?? (ROLE_MEANS.member as string), { workspace })}</Lead>

      <div className="mb-7">
        <KeyValue
          rows={[
            { term: t('Signed in as'), value: email },
            { term: t('Role'), value: t(ROLE_WORDS[invitation.role] ?? msg('Member')) },
            ...(site === undefined ? [] : [{ term: t('Site'), value: site }]),
          ]}
        />
      </div>

      <Button wide disabled={busy !== undefined} onClick={() => onAnswer(invitation, true)}>
        {busy === invitation.id ? t('Joining…') : t('Join {workspace}', { workspace })}
      </Button>
      {stuck?.id === invitation.id ? (
        <div className="mt-3.5">
          <Problem>{t(stuck.problem)}</Problem>
        </div>
      ) : null}
      <div className="mt-4.5 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <p className="min-w-0 text-small text-muted wrap-anywhere">
          {t('Not {email}?', { email })}{' '}
          <LinkButton space="inline" onClick={() => onAnother(invitation)}>
            {t('Use another address')}
          </LinkButton>
        </p>
        <LinkButton space="flush" disabled={busy !== undefined} onClick={() => onAnswer(invitation, false)}>
          {t('Decline')}
        </LinkButton>
      </div>

      {others.length === 0 ? null : (
        <section aria-labelledby="more-invitations" className="mt-10">
          <h2 id="more-invitations" className="mb-2.5 text-body leading-auto font-semibold">
            {others.length === 1 ? t('One more invitation') : t('{count} more invitations', { count: others.length })}
          </h2>
          <ul className="border-t border-line">
            {others.map((other) => (
              <li key={other.id} className="border-b border-line py-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="block text-body font-semibold wrap-anywhere">{nameOf(other)}</span>
                    <span className="block text-hint text-muted">{t(ROLE_WORDS[other.role] ?? msg('Member'))}</span>
                  </span>
                  <LinkButton disabled={busy !== undefined} onClick={() => onAnswer(other, false)}>
                    {t('Decline')}
                  </LinkButton>
                  <Button tone="outline" disabled={busy !== undefined} onClick={() => onAnswer(other, true)}>
                    {busy === other.id ? t('Joining…') : t('Join {workspace}', { workspace: nameOf(other) })}
                  </Button>
                </div>
                {stuck?.id === other.id ? (
                  <div className="mt-3">
                    <Problem>{t(stuck.problem)}</Problem>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The arrow of a link that leaves the console. */
function Away() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5">
      <path
        d="M8 16L16 8M9.5 8H16v6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Joined: what comes next is the extension, which shows the notes on the page.
 *
 * The mockup goes on with « It signs in with this account. ». That is not so today: a browser is
 * connected from the console, with a code. The sentence waits for the decision on that (Q8 of
 * FRU-230), and the way to the console is here in its place.
 *
 * With a browser of the extension already connected to the account, nothing asks to install it: the
 * screen names that browser, and « Connect another browser » is a link at the foot (FRU-441).
 */
function Joined({ workspace, name, site }: { workspace: string; name: string; site: Site | undefined }) {
  useLocale();
  const host = site === undefined ? undefined : siteLabel(site.origin);
  const connected = useConnectedExtension();
  // Not on the mockup, which leaves no way on but the extension: the console is where the person
  // connects their browser today.
  const console = (
    <LinkButton space="loose" to={`/w/${workspace}/sites`}>
      {t('Go to the console')}
    </LinkButton>
  );
  let lead: string;
  if (connected === undefined) {
    lead =
      host === undefined
        ? t('One more thing: the extension shows the notes on the sites of {workspace} and lets you leave yours.', {
            workspace: name,
          })
        : t('One more thing: the extension shows the notes on {site} and lets you leave yours.', { site: host });
  } else {
    lead =
      host === undefined
        ? t('Your extension shows the notes on the sites of {workspace} and lets you leave yours.', { workspace: name })
        : t('Your extension shows the notes on {site} and lets you leave yours.', { site: host });
  }
  // The extension is there: the site is what comes next, so it is the button.
  const openSite = (origin: string, label: string) =>
    connected === undefined ? (
      <LinkButton space="loose" href={origin} newTab>
        {t('Open {site}', { site: label })}
      </LinkButton>
    ) : (
      <Button href={origin} newTab>
        {t('Open {site}', { site: label })}
        <Away />
      </Button>
    );

  return (
    <>
      <div className="mb-6 ml-1">
        <SuccessMark />
      </div>
      <div className="mb-2.5">
        <Title>{t('You are in')}</Title>
      </div>
      <p role="status" className="mb-7 text-lead text-muted wrap-anywhere">
        {lead}
      </p>
      {connected === undefined ? null : (
        <p className="mb-5 flex items-center gap-2 text-body font-semibold">
          <StatusDot status="done" size={10} />
          {t('Extension connected · {browser}', { browser: connected.browser })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {connected === undefined ? (
          <Button href={extensionInstallFor(navigator.userAgent)} newTab>
            {t('Install the extension (beta)')}
            <Away />
          </Button>
        ) : null}
        {site === undefined || host === undefined ? console : openSite(site.origin, host)}
      </div>
      {connected === undefined ? (
        <p className="mt-7 border-t border-line pt-4.5 text-small text-muted">
          {t('Using Firefox?')}{' '}
          <LinkButton space="inline" href={FIREFOX_ADDONS} newTab>
            {t('Install it in Firefox (beta)')}
          </LinkButton>
        </p>
      ) : (
        <p className="mt-7 border-t border-line pt-4.5 text-small text-muted">
          <LinkButton space="inline" href={BY_SIGN_IN ? CONNECT_PAGE : extensionInstallFor(navigator.userAgent)} newTab>
            {t('Connect another browser')}
          </LinkButton>
        </p>
      )}
      {/* With a site to open beside the button, the way to the console has its own line. */}
      {site === undefined ? null : <p className="mt-1">{console}</p>}
    </>
  );
}
