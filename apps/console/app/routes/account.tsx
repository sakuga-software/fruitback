import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  type ConsoleSession,
  type ExtensionBrowser,
  LINKABLE,
  type Linkable,
  type SignInMethods,
  call,
  consoleSessions,
  endConsoleSession,
  endExtensionBrowser,
  extensionBrowsers,
  linkAddress,
  renameMe,
  saveLanguage,
  signInMethods,
  signOut,
  signOutEverywhere,
  unlinkProvider,
} from '../api';
import { ago } from '../ago';
import { type Listed, edited } from '../listed';
import { problemOf } from '../problems';
import { Button, Choice, Field, LinkButton, Problem } from '../ui';
import { Disconnect as AsksTwice } from './connector-parts';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * My account, as screen 13 of the mockup of 2026-10-13 draws it (FRU-248, FRU-249): the profile, how
 * the person signs in, the browsers where the console is signed in, and the end of the workspace for
 * its owner.
 *
 * The name is changed here, and a provider linked or unlinked (FRU-249). The browsers of the
 * extension are not listed yet: their route comes with the session of an account (FRU-238).
 */

/** `asking`: the worker has not answered yet. `silent`: it did not say, and nothing is in flight. */
type Asked = SignInMethods | 'asking' | 'silent';

const PROVIDER_NAMES: Readonly<Record<Linkable, string>> = { github: 'GitHub', google: 'Google' };

/** What the page says of one provider. WARNING: « Not set up » only when the worker said so. */
function providerWord(asked: Asked, provider: Linkable): string {
  if (asked === 'asking') return msg('Checking…');
  if (asked === 'silent') return msg('Could not check');
  const known = asked[provider];
  if (known === undefined) return msg('Not set up');

  return known.linked ? msg('Linked') : msg('Not linked');
}

/** Why a provider did not link, by the code the worker puts in the address on the way back. */
const LINK_PROBLEMS: Readonly<Record<string, string>> = {
  "email_doesn't_match": msg(
    'That account has another address than yours. Fruitback links only the address of your account.',
  ),
  account_already_linked_to_different_user: msg('That account already opens another Fruitback account.'),
  email_not_verified: msg('The provider did not say that this address is verified. Verify it there, then link again.'),
  identity_required: msg('Your session ended before the link. Sign in, then link again.'),
};
const NOT_LINKED = msg('The account was not linked. Try again.');

/** Why a provider is still there after « Unlink ». */
const UNLINK_PROBLEMS: Readonly<Record<string, string>> = {
  'last-sign-in': msg('This is the last way you sign in here: link another one first.'),
  'sign-in-again': msg('Sign in again first: a way to sign in changes only in the day after a sign-in.'),
};
const NOT_UNLINKED = msg('{provider} is still linked. Try again.');

const NAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A name is one line of 1 to 80 characters.'),
};
const NAME_NOT_KEPT = msg('Your name was not changed. Try again.');

const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only the owner of the workspace deletes it.'),
};
const WORKSPACE_NOT_DELETED = msg('The workspace was not deleted. Try again.');

/** « 12 Oct », as the mockup writes the day a browser connected. */
function dayOf(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(locale() === 'fr' ? 'fr' : 'en-GB', { day: 'numeric', month: 'short' });
}

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
  const readMethods = useCallback(async () => {
    const asked = await signInMethods();
    setProviders(asked.ok ? asked.data : 'silent');
  }, []);
  useEffect(() => void readMethods(), [readMethods]);

  // The way back of a link: `?linked=<provider>` or `?error=<code>`, said once, then taken away.
  const [params, setParams] = useSearchParams();
  const [linked] = useState(() => params.get('linked'));
  const [linkError] = useState(() => params.get('error'));
  useEffect(() => {
    if (params.has('linked') || params.has('error')) setParams({}, { replace: true });
  }, [params, setParams]);
  const [unlinkStuck, setUnlinkStuck] = useState<{ provider: Linkable; problem: string } | undefined>();

  async function unlink(provider: Linkable) {
    setUnlinkStuck(undefined);
    const gone = await unlinkProvider(provider);
    if (!gone.ok && gone.status !== 404) {
      // Own keys only (`problemOf`): a code named `constructor` must not find a method of `Object`.
      setUnlinkStuck({ provider, problem: problemOf(gone, UNLINK_PROBLEMS, NOT_UNLINKED) });
    }
    await readMethods();
  }

  // The name on the notes. What is typed stays when the worker refuses it.
  const [name, setName] = useState(me.account.name ?? '');
  const [nameProblem, setNameProblem] = useState<string | undefined>();
  // The name the worker keeps, and what is in the field now: an answer reads them when it lands, and
  // not as they were when the name left.
  const kept = useRef(me.account.name ?? '');
  const typed = useRef(name);
  typed.current = name;
  // One name on its way at a time: Enter, then leaving the field before the answer, sent it twice.
  const saving = useRef(false);
  async function saveName(event?: FormEvent) {
    event?.preventDefault();
    const sent = typed.current.trim();
    if (saving.current || sent === kept.current.trim()) return;
    saving.current = true;
    setNameProblem(undefined);
    const saved = await renameMe(sent);
    saving.current = false;
    if (!saved.ok) return setNameProblem(problemOf(saved, NAME_PROBLEMS, NAME_NOT_KEPT));
    kept.current = saved.data.account.name ?? sent;
    // What was typed while the name was on its way stays in the field, and leaves in its turn: the
    // answer never writes over it.
    if (typed.current.trim() !== sent) return void saveName();
    setName(kept.current);
  }
  const [unsent, setUnsent] = useState(false);

  // The browsers where the console is signed in. No list is not an empty list (FRU-162).
  // The browsers of the extension come in the same list, read together: the rows are drawn once, and
  // nothing under them moves when the second answer comes (FRU-271).
  const [sessions, setSessions] = useState<Listed<ConsoleSession>>('loading');
  // The browsers of the extension that could not be read do not take the browsers of the console
  // with them: those stay, with their « Disconnect », and a line says what is missing.
  const [extensions, setExtensions] = useState<ExtensionBrowser[]>([]);
  const [extensionsFailed, setExtensionsFailed] = useState(false);
  const read = useCallback(async () => {
    setSessions('loading');
    const [listed, connected] = await Promise.all([consoleSessions(), extensionBrowsers()]);
    setExtensions(connected.ok ? connected.data : []);
    setExtensionsFailed(!connected.ok);
    setSessions(listed.ok ? listed.data : 'failed');
  }, []);
  const [extensionStuck, setExtensionStuck] = useState<string | undefined>();

  async function disconnectExtension(browser: ExtensionBrowser) {
    setExtensionStuck(undefined);
    const ended = await endExtensionBrowser(browser.id);
    if (ended === 'failed') return setExtensionStuck(browser.id);
    if (ended === 'unknown') {
      // Ended since the list was read, or a worker with no such route: only the list says which.
      const connected = await extensionBrowsers();
      // A list that could not be read says nothing of this browser: the line of a failed read says so.
      if (!connected.ok) return setExtensionsFailed(true);
      if (connected.data.some((each) => each.id === browser.id)) return setExtensionStuck(browser.id);
      return setExtensions(connected.data);
    }
    setExtensions((current) => current.filter((each) => each.id !== browser.id));
  }
  useEffect(() => void read(), [read]);
  // The browser whose session did not end, by the id of its session.
  const [stuck, setStuck] = useState<string | undefined>();

  async function disconnect(session: ConsoleSession) {
    setStuck(undefined);
    const ended = await endConsoleSession(session.id);
    if (ended === 'unknown') {
      // Ended since the list was read, or a worker with no such route: only the list says which.
      const listed = await consoleSessions();
      if (!listed.ok || listed.data.some((each) => each.id === session.id)) return setStuck(session.id);
      return setSessions(listed.data);
    }
    if (ended === 'failed') return setStuck(session.id);
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
            {/* Kept when the field is left, or by Enter: the mockup draws no button. */}
            <form onSubmit={(event) => void saveName(event)} onBlur={() => void saveName()} className="min-w-0">
              <Field
                label={t('Name shown on notes')}
                value={name}
                maxLength={80}
                autoComplete="name"
                hint={me.account.email}
                onChange={(event) => setName(event.target.value)}
              />
            </form>
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
          {nameProblem === undefined ? null : <Problem>{t(nameProblem)}</Problem>}
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
          {linked !== null && (LINKABLE as readonly string[]).includes(linked) ? (
            <p role="status" className="mb-[12px] text-small text-muted">
              {t('{provider} is linked to your account.', { provider: PROVIDER_NAMES[linked as Linkable] })}
            </p>
          ) : null}
          {linkError === null ? null : (
            <div className="mb-[12px]">
              {/* The code comes from the address, which anybody writes: own keys only, so that
                  `?error=constructor` reads the sentence of a link that failed, not a method of Object. */}
              <Problem>
                {t(Object.hasOwn(LINK_PROBLEMS, linkError) ? (LINK_PROBLEMS[linkError] as string) : NOT_LINKED)}
              </Problem>
            </div>
          )}
          {/* The three rows are drawn before the worker answers, so nothing under them moves when it does. */}
          <ul className="border-t border-line text-body">
            <Row title={t('Email link')} detail={me.account.email}>
              <span className="text-small leading-auto text-muted">
                {typeof providers === 'object' && !providers.email ? t('Not sent by this Fruitback') : t('Always on')}
              </span>
            </Row>
            {LINKABLE.map((provider) => {
              const known = typeof providers === 'object' ? providers[provider] : undefined;
              const named = PROVIDER_NAMES[provider];

              return (
                <Row
                  key={provider}
                  title={named}
                  detail={t(providerWord(providers, provider))}
                  under={
                    unlinkStuck?.provider === provider ? (
                      <Problem>{t(unlinkStuck.problem, { provider: named })}</Problem>
                    ) : undefined
                  }
                >
                  {known?.linked === true ? (
                    <AsksTwice
                      space="normal"
                      label={t('Unlink')}
                      confirmLabel={t('Unlink {provider}', { provider: named })}
                      keepLabel={t('Keep it')}
                      consequence={t('You no longer sign in with {provider}. Your account and its notes stay.', {
                        provider: named,
                      })}
                      onConfirm={() => void unlink(provider)}
                    />
                  ) : null}
                  {known?.linked === false ? (
                    // An outlined button of 40 px, as the mockup draws it, that leads to the worker.
                    <Button tone="outline" href={linkAddress(provider, workspace.id)}>
                      {t('Link {provider}', { provider: named })}
                    </Button>
                  ) : null}
                </Row>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="where-title">
          <SectionTitle id="where-title">{t('Where you are signed in')}</SectionTitle>
          <SectionHelp>{t('Disconnect a browser you no longer use. It stops showing notes at once.')}</SectionHelp>
          {sessions === 'loading' ? (
            <div className={ONE_ROW}>
              <p className="text-small text-muted">{t('Loading…')}</p>
            </div>
          ) : null}
          {sessions === 'failed' ? (
            <div className={`${ONE_ROW} gap-[12px]`}>
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
                  <Row key={session.id} title={titleOf(session)} detail={t('Active now')}>
                    <span className="text-small leading-auto text-muted">{t('This browser')}</span>
                  </Row>
                ) : (
                  <Row
                    key={session.id}
                    title={titleOf(session)}
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
              {[...extensions]
                .sort((one, other) => other.usedAt.localeCompare(one.usedAt))
                .map((browser) => (
                  <Row
                    key={browser.id}
                    title={t('Extension · {browser}', { browser: browser.browser })}
                    detail={t('Connected {day} · used {last}', {
                      day: dayOf(browser.connectedAt),
                      last: ago(browser.usedAt),
                    })}
                    under={
                      extensionStuck === browser.id ? (
                        <Problem>
                          {t('This extension is still connected: Fruitback did not end its session. Try again.')}
                        </Problem>
                      ) : undefined
                    }
                  >
                    <AsksTwice
                      space="normal"
                      label={t('Disconnect')}
                      confirmLabel={t('Disconnect the extension in {browser}', { browser: browser.browser })}
                      keepLabel={t('Keep it')}
                      consequence={t(
                        'It stops showing notes at once. It connects again from its popup, with your approval here.',
                      )}
                      onConfirm={() => void disconnectExtension(browser)}
                    />
                  </Row>
                ))}
              {extensionsFailed ? (
                <li className={`${ONE_ROW} gap-[12px] border-t-0`}>
                  <p role="alert" className="min-w-0 flex-1 text-small text-muted">
                    {t('Fruitback did not answer. The browsers of the extension could not be read.')}
                  </p>
                  <Button tone="outline" onClick={() => void read()}>
                    {t('Try again')}
                  </Button>
                </li>
              ) : null}
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

/**
 * « Console · Chrome on macOS », as the worker names the browser of a session (FRU-249). A worker of
 * before, or a browser it could not name, reads as this browser or another one.
 */
function titleOf(session: ConsoleSession): string {
  const named = session.browser !== undefined && session.browser !== 'A browser' ? session.browser : undefined;
  if (named !== undefined) return t('Console · {browser}', { browser: named });

  return session.current ? t('Console · this browser') : t('Console · another browser');
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
 * The box of a list of one row, where there is no list yet: its two rules, and the height of a row.
 *
 * WARNING: the list of the browsers arrives after the screen is drawn, and « Sign out » is under it.
 * While the list is read, and when it could not be, its place is the one of the row of this browser,
 * which every list has. So the buttons do not move under a press: a press that starts before a
 * button moves and ends after is lost. `e2e/console-account.spec.ts` holds the list back to see it.
 * A second browser still adds its row under the first.
 */
const ONE_ROW = 'box-content flex min-h-[56px] flex-wrap items-center border-y border-line py-[8px]';

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
