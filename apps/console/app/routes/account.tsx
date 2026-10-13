import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type ConsoleSession,
  type Providers,
  call,
  consoleSessions,
  endConsoleSession,
  saveLanguage,
  signInProviders,
  signOut,
  signOutEverywhere,
} from '../api';
import { type Listed, edited } from '../listed';
import { problemOf } from '../problems';
import { Button, Choice, Field, LinkButton, Problem } from '../ui';
import { Disconnect as AsksTwice } from './connector-parts';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * My account, as screen 13 of the mockup of 2026-10-13 draws it (FRU-248), with what the worker of
 * today does: the profile, how the person signs in, the browsers where the console is signed in, and
 * the end of the workspace for its owner.
 *
 * The name is read and not changed, a provider is not linked or unlinked, and the browsers of the
 * extension are not listed: the worker has no route for these yet (FRU-249).
 */

/** `asking`: the worker has not answered yet. `silent`: it did not say, and nothing is in flight. */
type Asked = Providers | 'asking' | 'silent';

/** What the page says of one provider. WARNING: « Not set up » only when the worker said so. */
function providerWord(asked: Asked, provider: keyof Providers): string {
  if (asked === 'asking') return msg('Checking…');
  if (asked === 'silent') return msg('Could not check');

  return asked[provider] ? msg('On this Fruitback') : msg('Not set up');
}

const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only the owner of the workspace deletes it.'),
};
const WORKSPACE_NOT_DELETED = msg('The workspace was not deleted. Try again.');

/** A day and a time, in the language of the console. */
function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // What the worker signs people in with (FRU-135). A provider is on or "not set up" only when the
  // worker said so: a slow answer and no answer prove neither, and each has its own word.
  const [providers, setProviders] = useState<Asked>('asking');
  useEffect(() => {
    let asked = true;
    void signInProviders().then((has) => {
      if (asked) setProviders(has ?? 'silent');
    });

    return () => {
      asked = false;
    };
  }, []);
  const [unsent, setUnsent] = useState(false);

  // The browsers where the console is signed in. No list is not an empty list (FRU-162).
  const [sessions, setSessions] = useState<Listed<ConsoleSession>>('loading');
  const read = useCallback(async () => {
    setSessions('loading');
    const listed = await consoleSessions();
    setSessions(listed.ok ? listed.data : 'failed');
  }, []);
  useEffect(() => void read(), [read]);
  // The browser whose session did not end, by the id of its session.
  const [stuck, setStuck] = useState<string | undefined>();

  async function disconnect(session: ConsoleSession) {
    setStuck(undefined);
    if (!(await endConsoleSession(session.id))) return setStuck(session.id);
    // A list that was not read stays what it is (`edited`).
    setSessions((current) => edited(current, (items) => items.filter((each) => each.id !== session.id)));
  }

  const [stillIn, setStillIn] = useState<'here' | 'everywhere' | undefined>();

  async function leave() {
    setStillIn(undefined);
    if (await signOut()) return navigate('/setup', { replace: true });
    // The worker did not say that the session ended: it can still be good (FRU-204).
    setStillIn('here');
  }

  async function leaveEverywhere() {
    setStillIn(undefined);
    if (await signOutEverywhere()) return navigate('/setup', { replace: true });
    // As above: no browser is said to be signed out when the worker did not say so.
    setStillIn('everywhere');
  }

  const [undeleted, setUndeleted] = useState<string | undefined>();

  async function destroy() {
    setUndeleted(undefined);
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    if (deleted.ok) return navigate('/', { replace: true });
    // The workspace is still there: say so beside the button (FRU-164).
    setUndeleted(problemOf(deleted, DELETION_PROBLEMS, WORKSPACE_NOT_DELETED));
  }

  // This browser first, then the others, the one used last first.
  const browsers =
    typeof sessions === 'string'
      ? []
      : [...sessions].sort(
          (one, other) => Number(other.current) - Number(one.current) || other.lastUsedAt.localeCompare(one.lastUsedAt),
        );

  return (
    <>
      <PageHead title={t('My account')} lead={t('Your name on notes, how you sign in, and where.')} />
      {/* The mockup puts 40 px between the head and each section: the head has 28 px under it. */}
      <div className="flex flex-col gap-[40px] pt-[12px]">
        <section aria-labelledby="profile-title" className="flex flex-col gap-[14px]">
          <SectionTitle id="profile-title">{t('Profile')}</SectionTitle>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-[14px]">
            {/* Read, and not changed: the worker has no route that changes a name yet (FRU-249). */}
            <Field label={t('Name shown on notes')} value={me.account.name ?? ''} locked hint={me.account.email} />
            <div>
              <Choice
                label={t('Language')}
                hint={t('The language of the console, and of the e-mails Fruitback sends you.')}
                value={locale()}
                options={LOCALES.map((each) => ({ value: each.tag, label: each.name }))}
                onChange={(tag) => {
                  // The screen changes at once. The account keeps the choice for the e-mails and for
                  // the next browser. When it did not hear it, say so: the choice stays in this browser
                  // and is sent again at the next visit.
                  setUnsent(false);
                  void chooseLanguage(tag, saveLanguage).then((heard) => setUnsent(!heard));
                }}
              />
            </div>
          </div>
          {unsent ? (
            <Problem>
              {t(
                'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.',
              )}
            </Problem>
          ) : null}
        </section>

        <section aria-labelledby="signin-title">
          <SectionTitle id="signin-title">{t('How you sign in')}</SectionTitle>
          <SectionHelp>{t('Any of these opens the same account, in the console and in the extension.')}</SectionHelp>
          <ul className="border-t border-line text-body">
            <Row title={t('Email link')} detail={me.account.email}>
              <span className="text-small leading-auto text-muted">{t('Always on')}</span>
            </Row>
            {/* What the worker signs people in with, read only: no route links or unlinks a provider
                yet (FRU-249), so no button says that it does. */}
            {(['GitHub', 'Google'] as const).map((provider) => (
              <Row
                key={provider}
                title={provider}
                detail={t(providerWord(providers, provider === 'GitHub' ? 'github' : 'google'))}
              />
            ))}
          </ul>
        </section>

        <section aria-labelledby="where-title">
          <SectionTitle id="where-title">{t('Where you are signed in')}</SectionTitle>
          <SectionHelp>{t('Disconnect a browser you no longer use. It stops showing notes at once.')}</SectionHelp>
          {sessions === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
          {sessions === 'failed' ? (
            <div className="flex flex-wrap items-center gap-[12px]">
              <p role="alert" className="min-w-0 flex-1 text-small text-muted">
                {t('Fruitback did not answer. The browsers where you are signed in could not be read.')}
              </p>
              <Button tone="outline" onClick={() => void read()}>
                {t('Try again')}
              </Button>
            </div>
          ) : null}
          {typeof sessions === 'string' ? null : (
            <ul className="border-t border-line text-body">
              {browsers.map((session) =>
                session.current ? (
                  <Row key={session.id} title={t('Console · this browser')} detail={t('Active now')}>
                    <span className="text-small leading-auto text-muted">{t('This browser')}</span>
                  </Row>
                ) : (
                  <Row
                    key={session.id}
                    title={t('Console · another browser')}
                    detail={t('Signed in {since} · used {last}', {
                      since: moment(session.createdAt),
                      last: moment(session.lastUsedAt),
                    })}
                    under={
                      stuck === session.id ? (
                        <Problem>
                          {t('This browser is still signed in: Fruitback did not end its session. Try again.')}
                        </Problem>
                      ) : undefined
                    }
                  >
                    <LinkButton space="normal" onClick={() => void disconnect(session)}>
                      {t('Disconnect')}
                    </LinkButton>
                  </Row>
                ),
              )}
            </ul>
          )}
        </section>

        <section aria-label={t('Sign out')} className="flex flex-wrap items-center gap-x-[20px] gap-y-[12px]">
          <Button tone="outline" size="page" inset={18} onClick={() => void leave()}>
            {t('Sign out')}
          </Button>
          <AsksTwice
            space="loose"
            label={t('Sign out everywhere')}
            confirmLabel={t('Sign out of every browser')}
            keepLabel={t('Stay signed in')}
            consequence={t(
              'Every browser where the console is signed in to your account is signed out, this one too. The extension stays connected.',
            )}
            onConfirm={() => void leaveEverywhere()}
          />
          {stillIn === undefined ? null : (
            <div className="w-full">
              <Problem>
                {stillIn === 'here'
                  ? t('You are still signed in: Fruitback did not confirm the sign-out. Try again.')
                  : t(
                      'You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.',
                    )}
              </Problem>
            </div>
          )}
        </section>

        {/* The mockup does not draw it, and it is the one place where an owner deletes a workspace. */}
        {workspace.role === 'owner' ? (
          <section aria-labelledby="delete-title" className="border-t border-line pt-[24px]">
            <SectionTitle id="delete-title">{t('Delete the workspace')}</SectionTitle>
            <SectionHelp>
              {t('Sites, members and pin positions go. Items already in your sources stay there.')}
            </SectionHelp>
            {undeleted === undefined ? null : (
              <div className="mb-[12px]">
                <Problem>{t(undeleted)}</Problem>
              </div>
            )}
            {confirming ? (
              <span className="flex flex-wrap gap-[8px]">
                <Button tone="quiet" autoFocus onClick={() => setConfirming(false)}>
                  {t('Keep it')}
                </Button>
                <Button tone="danger" onClick={() => void destroy()}>
                  {t('Delete {workspace}', { workspace: workspace.name })}
                </Button>
              </span>
            ) : (
              <Button tone="outline" inset={16} onClick={() => setConfirming(true)}>
                {t('Delete workspace')}
              </Button>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}

/** The title of a section: the section is named by it. */
function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-section font-bold">
      {children}
    </h2>
  );
}

/** What a section is for, under its title. */
function SectionHelp({ children }: { children: string }) {
  return <p className="mt-[4px] mb-[12px] text-small text-muted">{children}</p>;
}

/**
 * A row of a list of the account: a name, a line under it, and at its end a state or one action. The
 * mockup sizes it by its content: 56 px at the least inside its padding.
 */
function Row({
  title,
  detail,
  under,
  children,
}: {
  title: string;
  detail: string;
  /** Under the row: why its action did not go through. */
  under?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="box-content flex min-h-[56px] flex-wrap items-center gap-x-[16px] gap-y-[4px] border-b border-line py-[8px]">
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="block leading-auto font-semibold">{title}</span>
        <span className="block text-hint leading-auto text-muted [overflow-wrap:anywhere]">{detail}</span>
      </span>
      {children ?? null}
      {under === undefined ? null : <div className="w-full">{under}</div>}
    </li>
  );
}
