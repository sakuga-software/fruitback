import { useEffect } from 'react';
import { t } from '../i18n';
import { EXTENSION_GUIDE } from '../install-options';
import { Button, EntryPage, Lead, LinkButton, Title } from '../ui';
import { useLocale } from '../use-locale';

/**
 * « Connect this browser », from the console (FRU-313). The console cannot talk to the extension, so
 * this page says what to do in it: open the popup, then « Sign in with email ». The popup asks the
 * worker, and opens `/connect/<request>` with the word to check: the same way in as a popup opened
 * anywhere else, and the same session, of the account.
 *
 * It mints nothing and reads nothing. Before FRU-313 the button minted a pairing code, and the
 * worker's page `/pair` held it: a session of one workspace, with the words of a worker.
 */
export default function ConnectStart() {
  useLocale();

  useEffect(() => {
    const before = document.title;
    document.title = t('Connect this browser');

    return () => {
      document.title = before;
    };
  });

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
        <LinkButton space="inline" href={EXTENSION_GUIDE} newTab>
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
