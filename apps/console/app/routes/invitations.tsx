import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type Invitation, type Me, ORGANIZATION, call, callUntilAnswered, myInvitations } from '../api';
import { problemOf } from '../problems';
import { Button, Card, Chip, Mark, Problem } from '../ui';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * The invitations that wait for the person who is signed in (FRU-104): where the link of an
 * invitation leads.
 *
 * The link holds no id: the worker lists the invitations sent to the address this session proved, and
 * only that session accepts one. Somebody who is not signed in is asked to sign in with the address
 * the message came to.
 */

const ROLE_WORDS: Readonly<Record<string, string>> = { admin: msg('Admin'), member: msg('Member') };
const ANSWER_PROBLEMS: Readonly<Record<string, string>> = {
  INVITATION_NOT_FOUND: msg('This invitation was cancelled, or it ended. Ask for another one.'),
};
const NOT_ANSWERED = msg('The invitation could not be answered. Try again.');

type Read = { email: string; invitations: Invitation[] } | 'loading' | 'signed-out' | 'failed';

export default function Invitations() {
  useLocale();
  const navigate = useNavigate();
  const [read, setRead] = useState<Read>('loading');
  const [stuck, setStuck] = useState<{ id: string; problem: string } | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(() => {
    setRead('loading');

    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return setRead('signed-out');
      void myInvitations().then((invitations) =>
        setRead(invitations.ok ? { email: me.data.account.email, invitations: invitations.data } : 'failed'),
      );
    });
  }, []);

  useEffect(() => load(), [load]);

  async function answer(invitation: Invitation, accept: boolean) {
    setStuck(undefined);
    setBusy(invitation.id);
    const route = accept ? 'accept-invitation' : 'reject-invitation';
    const answered = await call('POST', `${ORGANIZATION}/${route}`, { invitationId: invitation.id });
    setBusy(undefined);
    if (!answered.ok)
      return setStuck({ id: invitation.id, problem: problemOf(answered, ANSWER_PROBLEMS, NOT_ANSWERED) });
    if (accept) return navigate(`/w/${invitation.organizationId}/sites`, { replace: true });
    setRead((current) =>
      typeof current === 'string'
        ? current
        : { ...current, invitations: current.invitations.filter((each) => each.id !== invitation.id) },
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-setup px-4 py-16">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2">
          <Mark size={18} />
          <span className="font-semibold">{t('Fruitback')}</span>
        </div>
        <h1 className="text-[26px] font-bold tracking-[-0.02em]">{t('Invitations')}</h1>
        <Body
          read={read}
          busy={busy}
          stuck={stuck}
          onAnswer={(each, accept) => void answer(each, accept)}
          onRetry={load}
        />
      </div>
    </main>
  );
}

function Body({
  read,
  busy,
  stuck,
  onAnswer,
  onRetry,
}: {
  read: Read;
  busy: string | undefined;
  stuck: { id: string; problem: string } | undefined;
  onAnswer: (invitation: Invitation, accept: boolean) => void;
  onRetry: () => void;
}) {
  useLocale();
  if (read === 'loading') return <p className="mt-4 text-sm text-muted">{t('Loading…')}</p>;
  if (read === 'signed-out')
    return (
      <>
        <p className="mt-2 text-[15px] text-muted">
          {t('Sign in with the address the invitation was sent to, and it shows here.')}
        </p>
        <Link
          to="/setup"
          className="mt-5 inline-block rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white"
        >
          {t('Sign in')}
        </Link>
      </>
    );
  if (read === 'failed')
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p role="alert" className="flex-1 text-sm text-muted">
          {t('Fruitback did not answer. Your invitations are not lost.')}
        </p>
        <Button tone="outline" onClick={onRetry}>
          {t('Try again')}
        </Button>
      </div>
    );
  if (read.invitations.length === 0)
    return (
      <>
        <p className="mt-2 text-[15px] text-muted">
          {t('No invitation waits for {email}. An invitation sent to another address shows to that address only.', {
            email: read.email,
          })}
        </p>
        <Link to="/" className="mt-5 inline-block text-sm font-semibold underline">
          {t('Go to the console')}
        </Link>
      </>
    );

  return (
    <>
      <p className="mt-2 text-[15px] text-muted">{t('For {email}.', { email: read.email })}</p>
      <Card className="mt-5">
        <ul>
          {read.invitations.map((invitation) => (
            <li key={invitation.id} className="border-b border-line px-5 py-4 last:border-b-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 grow basis-40">
                  <span className="block text-[15px] font-semibold [overflow-wrap:anywhere]">
                    {invitation.organizationName ?? invitation.organizationId}
                  </span>
                  <span className="block text-xs text-muted">
                    {t('Until {date}', { date: new Date(invitation.expiresAt).toLocaleDateString() })}
                  </span>
                </span>
                <Chip>{t(ROLE_WORDS[invitation.role] ?? msg('Member'))}</Chip>
                <span className="flex flex-wrap gap-2">
                  <Button tone="quiet" disabled={busy !== undefined} onClick={() => onAnswer(invitation, false)}>
                    {t('Decline')}
                  </Button>
                  <Button disabled={busy !== undefined} onClick={() => onAnswer(invitation, true)}>
                    {busy === invitation.id
                      ? t('Joining…')
                      : t('Join {workspace}', {
                          workspace: invitation.organizationName ?? '',
                        })}
                  </Button>
                </span>
              </div>
              {stuck?.id === invitation.id ? (
                <div className="mt-3">
                  <Problem>{t(stuck.problem)}</Problem>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
