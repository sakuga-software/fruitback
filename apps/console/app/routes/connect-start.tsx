import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { type ExtensionBrowser, consoleSessions, extensionBrowsers } from '../api';
import { sameAsThisBrowser } from '../extension-connected';
import { watchConnection } from '../connect-watch';
import { t } from '../i18n';
import { extensionInstallFor } from '../extension-store';
import { Button, EntryPage, Lead, LinkButton, StatusDot, Title } from '../ui';
import { useLocale } from '../use-locale';

/**
 * « Connect this browser », from the console (FRU-313). The console cannot talk to the extension, so
 * this page says what to do in it: open the popup, then « Sign in with email ». The popup asks the
 * worker, and opens `/connect/<request>` with the word to check: the same way in as a popup opened
 * anywhere else, and the same session, of the account.
 *
 * It mints nothing. Before FRU-313 the button minted a pairing code, and the
 * worker's page `/pair` held it: a session of one workspace, with the words of a worker.
 *
 * It reads the browsers of the extension of the account while its tab is shown, and leads to the
 * console as soon as one connects (FRU-410): the worker is the only one that sees it.
 *
 * Opened in a browser that is already connected, it says so and leads to the console (FRU-441). The
 * console cannot see the extension: « this browser » is a browser of the extension whose label
 * (« Chrome on macOS ») is the label of the session of the console in this tab. Another computer
 * with the same browser and system reads the same, so the three steps stay one press away.
 */
export default function ConnectStart() {
  useLocale();
  const navigate = useNavigate();

  useEffect(
    () =>
      watchConnection({
        read: () => extensionBrowsers({ quiet: true }),
        page: document,
        now: Date.now,
        onConnected: () => void navigate('/', { replace: true }),
      }),
    [navigate],
  );

  const [already, setAlready] = useState<ExtensionBrowser | undefined>();
  const [steps, setSteps] = useState(false);
  useEffect(() => {
    let stopped = false;
    // Signed out, both reads are refused, and the page shows the steps: `quiet` ends no session.
    void Promise.all([extensionBrowsers({ quiet: true }), consoleSessions({ quiet: true })])
      .then(([browsers, sessions]) => {
        if (stopped || !browsers.ok || !sessions.ok) return;
        const here = sessions.data.find((session) => session.current)?.browser;
        setAlready(sameAsThisBrowser(browsers.data, here));
      })
      .catch(() => undefined);

    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    const before = document.title;
    document.title = t('Connect this browser');

    return () => {
      document.title = before;
    };
  });

  if (already !== undefined && !steps) {
    return (
      <EntryPage width="wide">
        <div className="mb-2.5">
          <Title>{t('This browser is already connected')}</Title>
        </div>
        <Lead className="mb-4">
          {t('The extension is signed in with your account here. Click the Fruitback icon on a site to see its notes.')}
        </Lead>
        <p className="mb-6 flex items-center gap-2 text-body font-semibold">
          <StatusDot status="done" size={10} />
          {t('Extension connected · {browser}', { browser: already.browser })}
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
          <Button size="page" to="/">
            {t('Go to the console')}
          </Button>
          <LinkButton space="loose" onClick={() => setSteps(true)}>
            {t('Connect another browser')}
          </LinkButton>
        </div>
      </EntryPage>
    );
  }

  return (
    <EntryPage width="wide">
      <div className="mb-2.5">
        <Title>{t('Connect this browser')}</Title>
      </div>
      <Lead className="mb-6">{t('The extension signs in with your account, in three steps.')}</Lead>
      <ol className="mb-6 flex list-decimal flex-col gap-3 pl-5 text-body">
        <li>
          <strong className="font-semibold">{t('Click the Fruitback icon')}</strong>{' '}
          <span className="text-muted">
            {t('in the toolbar. Not there? Open the puzzle piece at the right of the address bar.')}
          </span>
        </li>
        <li>
          <strong className="font-semibold">{t('Press Sign in with email')}</strong>{' '}
          <span className="text-muted">{t('in the popup. A tab of the console opens with a word.')}</span>
        </li>
        <li>
          <strong className="font-semibold">{t('Check the word, then press Connect')}</strong>{' '}
          <span className="text-muted">{t('in that tab. The popup shows the same word.')}</span>
        </li>
      </ol>
      <p className="mb-6 text-small text-muted">
        {t('No extension in this browser yet?')}{' '}
        <LinkButton space="inline" href={extensionInstallFor(navigator.userAgent)} newTab>
          {t('Install the extension (beta)')}
        </LinkButton>
      </p>
      <div>
        <Button tone="outline" size="page" to="/">
          {t('Go to the console')}
        </Button>
      </div>
    </EntryPage>
  );
}
