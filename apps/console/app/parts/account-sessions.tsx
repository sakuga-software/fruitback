import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
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
import { Confirmation } from '../confirm';
import { t } from '../i18n';
import { type Listed, edited } from '../listed';
import { ReadProblem } from '../read-problem';
import { SettingsIcon } from '../settings-icons';
import { Button, Chip, Dialog, Menu, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { ONE_ROW, Row, RowMark, SettingsCard } from './account-rows';

/**
 * « Console · Chrome on macOS », as the worker names the browser of a session (FRU-249). A worker of
 * before, or a browser it could not name, reads as this browser or another one.
 */
function titleOf(session: ConsoleSession): string {
  const named = session.browser !== undefined && session.browser !== 'A browser' ? session.browser : undefined;
  if (named !== undefined) return t('Console · {browser}', { browser: named });

  return session.current ? t('Console · this browser') : t('Console · another browser');
}

/** A browser where the person is signed in: one of the console, or one of the extension. */
type Browser =
  | { kind: 'console'; id: string; usedAt: string; session: ConsoleSession }
  | { kind: 'extension'; id: string; usedAt: string; browser: ExtensionBrowser };

/**
 * The browsers where the person is signed in (FRU-181, FRU-238), and the way to end each one. The
 * profile shows the last ones, the page « Sessions » all of them: each reads them on its own.
 */
function useBrowsers() {
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
  useEffect(() => void read(), [read]);
  // The browser whose session did not end, by the id of its session, and the extension.
  const [stuck, setStuck] = useState<string | undefined>();
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

  // This browser first, then the others, the one used last first: of the console and of the extension.
  const browsers: Browser[] =
    typeof sessions === 'string'
      ? []
      : [
          ...sessions.map((session) => ({
            kind: 'console' as const,
            id: session.id,
            usedAt: session.lastUsedAt,
            session,
          })),
          ...extensions.map((browser) => ({
            kind: 'extension' as const,
            id: browser.id,
            usedAt: browser.usedAt,
            browser,
          })),
        ].sort(
          (one, other) =>
            Number(other.kind === 'console' && other.session.current) -
              Number(one.kind === 'console' && one.session.current) || other.usedAt.localeCompare(one.usedAt),
        );

  return {
    sessions,
    browsers,
    extensionsFailed,
    read,
    disconnect,
    disconnectExtension,
    stuck,
    extensionStuck,
  };
}

/**
 * Where the person is signed in, as a card (FRU-692). With `limit`, the card of the profile: the last
 * browsers, a short line under each, and « See all » to the page « Sessions ». Without, that page:
 * every browser, when it signed in and when it was used last.
 *
 * Another browser of the console is disconnected from its menu, in one press: a session ended by
 * mistake is a sign-in away. A browser of the extension asks twice, under its row: it connects again
 * only with an approval here.
 */
export function SessionsSection({ workspace, limit }: { workspace: string; limit?: number }) {
  useLocale();
  const { sessions, browsers, extensionsFailed, read, disconnect, disconnectExtension, stuck, extensionStuck } =
    useBrowsers();
  // The browser of the extension whose « Disconnect » was chosen in its menu: its row asks the second time.
  const [ending, setEnding] = useState<string | undefined>();
  const shown = limit === undefined ? browsers : browsers.slice(0, limit);
  const all =
    limit === undefined || typeof sessions === 'string' ? undefined : (
      <Link
        to={`/w/${workspace}/account/sessions`}
        viewTransition
        className="text-hint font-medium text-muted no-underline [&:hover]:text-ink"
      >
        {t('See all {count}', { count: browsers.length })}
      </Link>
    );

  return (
    <SettingsCard
      id="where-title"
      icon="screen"
      title={t('Where you are signed in')}
      {...(all === undefined ? {} : { actions: all })}
    >
      {sessions === 'loading' ? (
        <div className={ONE_ROW}>
          <p className="text-hint text-muted">{t('Loading…')}</p>
        </div>
      ) : null}
      {sessions === 'failed' ? (
        <div className={ONE_ROW}>
          <p role="alert" className="min-w-0 flex-1 text-hint text-muted">
            {t('The browsers where you are signed in did not load.')} <ReadProblem />
          </p>
          <Button tone="outline" size="small" onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof sessions === 'string' ? null : (
        <ul>
          {shown.map((each) => {
            if (each.kind === 'console') {
              const { session } = each;
              if (session.current)
                return (
                  <Row
                    key={each.id}
                    icon={<RowMark name="screen" />}
                    title={titleOf(session)}
                    detail={t('This browser')}
                  >
                    <Chip tone="done">{t('Active now')}</Chip>
                  </Row>
                );

              return (
                <Row
                  key={each.id}
                  icon={<RowMark name="screen" />}
                  title={titleOf(session)}
                  detail={
                    limit === undefined
                      ? t('Signed in {since} · used {last}', {
                          since: moment(session.createdAt),
                          last: moment(session.lastUsedAt),
                        })
                      : t('Used {last}', { last: agoInSentence(session.lastUsedAt) })
                  }
                  under={
                    stuck === session.id ? (
                      <Problem>
                        {t('This browser is still signed in: Fruitback did not end its session. Try again.')}
                      </Problem>
                    ) : undefined
                  }
                >
                  <Menu
                    trigger="icon"
                    triggerLabel={t('More for {browser}', { browser: titleOf(session) })}
                    items={[{ id: 'disconnect', label: t('Disconnect'), danger: true }]}
                    onAction={() => void disconnect(session)}
                  >
                    <SettingsIcon name="more" />
                  </Menu>
                </Row>
              );
            }
            const { browser } = each;
            const title = t('Extension · {browser}', { browser: browser.browser });
            const notEnded =
              extensionStuck === browser.id ? (
                <Problem>
                  {t('This extension is still connected: Fruitback did not end its session. Try again.')}
                </Problem>
              ) : null;
            // The second time stays after a refusal: the person tries again in one press.
            const under =
              ending === browser.id ? (
                <div className="flex flex-col gap-[8px]">
                  <Confirmation
                    confirmLabel={t('Disconnect the extension in {browser}', { browser: browser.browser })}
                    keepLabel={t('Keep it')}
                    consequence={t(
                      'It stops showing notes at once. It connects again from its popup, with your approval here.',
                    )}
                    onConfirm={() => void disconnectExtension(browser)}
                    onKeep={() => setEnding(undefined)}
                  />
                  {notEnded}
                </div>
              ) : (
                (notEnded ?? undefined)
              );

            return (
              <Row
                key={each.id}
                icon={<RowMark name="extension" />}
                title={title}
                detail={
                  limit === undefined
                    ? t('Connected {day} · used {last}', {
                        day: dayOf(browser.connectedAt, 'never'),
                        last: agoInSentence(browser.usedAt),
                      })
                    : t('Used {last}', { last: agoInSentence(browser.usedAt) })
                }
                {...(under === undefined ? {} : { under })}
              >
                <Menu
                  trigger="icon"
                  triggerLabel={t('More for {browser}', { browser: title })}
                  items={[{ id: 'disconnect', label: t('Disconnect'), danger: true }]}
                  onAction={() => setEnding(browser.id)}
                >
                  <SettingsIcon name="more" />
                </Menu>
              </Row>
            );
          })}
          {extensionsFailed ? (
            <li className={ONE_ROW}>
              <p role="alert" className="min-w-0 flex-1 text-hint text-muted">
                {t('The browsers of the extension did not load.')} <ReadProblem />
              </p>
              <Button tone="outline" size="small" onClick={() => void read()}>
                {t('Try again')}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </SettingsCard>
  );
}

/** Where the person is after a way out that did not go through: here, or in every browser. */
type StillIn = 'here' | 'everywhere' | undefined;

/**
 * « Sign out », here or in every browser. Neither says it is done before the worker does (FRU-204):
 * `stillIn` says which one did not go through, and `SignOutProblem` says it.
 */
export function useSignOut() {
  const navigate = useNavigate();
  const [stillIn, setStillIn] = useState<StillIn>();

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

  return { stillIn, leave, leaveEverywhere };
}

/** « Sign out », the action of the head of the profile. */
export function SignOutButton({ onPress }: { onPress: () => void }) {
  useLocale();

  return (
    <Button tone="outline" size="panel" onClick={onPress}>
      <SettingsIcon name="out" size={14} />
      {t('Sign out')}
    </Button>
  );
}

/**
 * « Sign out everywhere », the action of the head of « Sessions ». It asks twice, in a dialog: it ends
 * this browser too.
 */
export function SignOutEverywhere({ onConfirm }: { onConfirm: () => void }) {
  useLocale();
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button tone="outline" size="panel" onClick={() => setAsking(true)}>
        <SettingsIcon name="out" size={14} />
        {t('Sign out everywhere')}
      </Button>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t('Sign out everywhere')}
        closeLabel={t('Close')}
        size="sm"
      >
        <Confirmation
          confirmLabel={t('Sign out of every browser')}
          keepLabel={t('Stay signed in')}
          consequence={t(
            'Every browser where the console is signed in to your account is signed out, this one too. The extension stays connected.',
          )}
          onConfirm={() => {
            setAsking(false);
            onConfirm();
          }}
          onKeep={() => setAsking(false)}
        />
      </Dialog>
    </>
  );
}

/** What a way out that the worker did not confirm says, under the head of the page. */
export function SignOutProblem({ stillIn }: { stillIn: StillIn }) {
  useLocale();
  if (stillIn === undefined) return null;

  return (
    <div className="mb-[16px]">
      <Problem>
        {stillIn === 'here'
          ? t('You are still signed in: Fruitback did not confirm the sign-out. Try again.')
          : t('You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.')}
      </Problem>
    </div>
  );
}
