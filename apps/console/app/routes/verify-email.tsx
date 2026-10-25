import { useCallback, useEffect, useRef, useState } from 'react';
import { verifyAccountEmail } from '../api';
import { t } from '../i18n';
import { Button, EntryPage, Lead, SuccessMark, Title } from '../ui';
import { useLocale } from '../use-locale';

/**
 * Where the link that adds an address to an account lands (FRU-450). Its code is after the `#`: it
 * is read here once, taken out of the address bar, and spent in the session of this browser. The
 * worker adds the address only for the account that asked, so a person who is not signed in, or who
 * is signed in to another account, is told to sign in to that one and to open the link again.
 */
type Stage =
  | { kind: 'loading' }
  | { kind: 'added'; email: string }
  /** No session in this browser: the link is not spent. */
  | { kind: 'signed-out' }
  /** Spent, older than a day, of another account, or no code at all. */
  | { kind: 'spent' }
  | { kind: 'taken' }
  /** The worker did not answer: the link is not spent, and can be tried again. */
  | { kind: 'waiting'; code: string };

export default function VerifyEmail() {
  useLocale();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });

  const spend = useCallback((code: string) => {
    setStage({ kind: 'loading' });
    void verifyAccountEmail(code).then((answer) => {
      if (answer.ok) return setStage({ kind: 'added', email: answer.data.email });
      if (answer.status === 401) return setStage({ kind: 'signed-out' });
      if (answer.status === 409) return setStage({ kind: 'taken' });
      if (answer.status === 0 || answer.status === 429 || answer.status >= 500) {
        return setStage({ kind: 'waiting', code });
      }
      setStage({ kind: 'spent' });
    });
  }, []);

  // WARNING: read once per link, as on the sign-in page: in development an effect runs twice.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    const code = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (code === '') return setStage({ kind: 'spent' });
    spend(code);
  }, [spend]);

  useEffect(() => {
    const before = document.title;
    document.title = t('Add an address');

    return () => {
      document.title = before;
    };
  });

  return (
    <EntryPage>
      {stage.kind === 'loading' ? (
        <p role="status" aria-busy="true" className="text-lead text-muted">
          {t('Adding the address…')}
        </p>
      ) : null}
      {stage.kind === 'added' ? (
        <>
          <div className="mb-6 ml-1">
            <SuccessMark />
          </div>
          <div className="mb-2">
            <Title>{t('Address added')}</Title>
          </div>
          <p role="status" className="mb-7 text-lead text-muted [overflow-wrap:anywhere]">
            {t('{email} is now an address of your account. A sign-in link sent there opens it.', {
              email: stage.email,
            })}
          </p>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Open the console')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'signed-out' ? (
        <>
          <div className="mb-2">
            <Title>{t('Sign in first')}</Title>
          </div>
          <Lead className="mb-7">
            {t(
              'Sign in to Fruitback in this browser, with the account that asked for this address, then open the link again.',
            )}
          </Lead>
          <div>
            <Button size="page" to="/sign-in">
              {t('Sign in')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'spent' ? (
        <>
          <div className="mb-2">
            <Title>{t('This link does not work')}</Title>
          </div>
          <Lead className="mb-7">
            {t(
              'It was used already, it is older than a day, or it was asked by another account than the one signed in here. Add the address again from « My account ».',
            )}
          </Lead>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Open the console')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'taken' ? (
        <>
          <div className="mb-2">
            <Title>{t('This address was not added')}</Title>
          </div>
          <Lead className="mb-7">{t('It is now the address of another Fruitback account.')}</Lead>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Open the console')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'waiting' ? (
        <>
          <div className="mb-2">
            <Title>{t('The address is not added yet')}</Title>
          </div>
          <Lead className="mb-7">{t('Fruitback did not answer. Your link still works.')}</Lead>
          <div>
            <Button onClick={() => spend(stage.code)}>{t('Try again')}</Button>
          </div>
        </>
      ) : null}
    </EntryPage>
  );
}
