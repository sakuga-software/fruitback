import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type ConsoleSession,
  type ExtensionBrowser,
  consoleSessions,
  endConsoleSession,
  endExtensionBrowser,
  extensionBrowsers,
  signOut,
  signOutEverywhere,
} from '../api';
import { agoInSentence, dayOf, moment } from '../ago';
import { t } from '../i18n';
import { type Listed, edited } from '../listed';
import { ReadProblem } from '../read-problem';
import { Button, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { ONE_ROW, Row, SectionHelp, SectionTitle } from './account-rows';
import { Disconnect as AsksTwice } from './connector-parts';

/**
 * « Console · Chrome on macOS », as the worker names the browser of a session (FRU-249). A worker of
 * before, or a browser it could not name, reads as this browser or another one.
 */
function titleOf(session: ConsoleSession): string {
  const named = session.browser !== undefined && session.browser !== 'A browser' ? session.browser : undefined;
  if (named !== undefined) return t('Console · {browser}', { browser: named });

  return session.current ? t('Console · this browser') : t('Console · another browser');
}

/** Where the person is signed in (FRU-181, FRU-238): the browsers of the console and of the extension. */
export function SessionsSection() {
  useLocale();
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
      // A list read now says what the line of a read that failed before did not.
      setExtensionsFailed(false);
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

  // This browser first, then the others, the one used last first.
  const browsers =
    typeof sessions === 'string'
      ? []
      : [...sessions].sort(
          (one, other) => Number(other.current) - Number(one.current) || other.lastUsedAt.localeCompare(one.lastUsedAt),
        );

  return (
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
            {t('The browsers where you are signed in did not load.')} <ReadProblem />
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
                  day: dayOf(browser.connectedAt, 'never'),
                  last: agoInSentence(browser.usedAt),
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
                {t('The browsers of the extension did not load.')} <ReadProblem />
              </p>
              <Button tone="outline" onClick={() => void read()}>
                {t('Try again')}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

/** « Sign out », here or in every browser. Neither says it is done before the worker does (FRU-204). */
export function SignOutSection() {
  useLocale();
  const navigate = useNavigate();
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

  return (
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
              : t('You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.')}
          </Problem>
        </div>
      )}
    </section>
  );
}
