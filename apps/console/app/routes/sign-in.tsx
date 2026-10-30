import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { call, redeemLink } from '../api';
import { msg, t } from '../i18n';
import {
  AnotherAddress,
  EmailForm,
  INVITATION_NEEDED,
  ProviderButtons,
  SignInClosed,
  providerProblem,
  useCarryOn,
  useSendAgain,
  useSignInWays,
  withStrong,
} from '../sign-in-form';
import { announceSignIn } from '../tab-signal';
import { Button, EntryPage, Lead, LinkButton, Problem, SuccessMark, Title } from '../ui';
import { useLocale } from '../use-locale';
import { ReadProblem } from '../read-problem';

/**
 * The sign-in page (FRU-235, screen 02 of the mockup of 2026-10-13), and where a sign-in link lands.
 *
 * With no code after the `#`: the form, then « Check your inbox », which goes on by itself when the
 * link is opened in another tab. With a code: it is read here, spent once, and removed from the
 * address bar so a reload or a shared screen does not show it. The code never reached a server in
 * an address.
 */
type Stage =
  | { kind: 'loading' }
  /** `problem`: a link that was spent and opened no account (FRU-278). */
  | { kind: 'form'; problem?: string }
  | { kind: 'sent'; email: string }
  /** The code of a link is being spent. */
  | { kind: 'landing' }
  /** The worker did not answer for this code. The link is not spent, so it can be tried again. */
  | { kind: 'waiting'; code: string }
  /** The link is spent, and another tab of this browser carried on with the session. */
  | { kind: 'opened' }
  | { kind: 'expired' };

export default function SignIn() {
  useLocale();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Kept above the stages: « Use another address » gives the form back with the address in it.
  const [email, setEmail] = useState('');

  const redeem = useCallback(
    (code: string) => {
      setStage({ kind: 'landing' });
      void redeemLink(code).then(async (redeemed) => {
        if (redeemed.ok) {
          // A tab that waited for this link goes on with the session, and this one says so. With no
          // such tab, this one is the console.
          if (await announceSignIn()) return setStage({ kind: 'opened' });

          return navigate('/', { replace: true });
        }
        // No answer, or a refusal that is not about the link (FRU-205): the link was not spent, or
        // the next try says that it was.
        if (redeemed.status === 0 || redeemed.status === 429 || redeemed.status >= 500) {
          return setStage({ kind: 'waiting', code });
        }
        // The link worked, and this Fruitback creates no account for that address (FRU-278).
        if (redeemed.error === 'invitation-required') return setStage({ kind: 'form', problem: INVITATION_NEEDED });
        setStage({ kind: 'expired' });
      });
    },
    [navigate],
  );

  // WARNING: the code of a link is read once per link, and never from an effect that runs again.
  // In development an effect runs twice, and the second run finds an address with no code: it must
  // not take the page for a visit with no link, nor spend the code a second time.
  const landed = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    /** Reads the code after the `#`, takes it out of the address bar, and spends it. */
    const land = (): boolean => {
      const code = window.location.hash.slice(1);
      if (code === '') return false;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      redeem(code);

      return true;
    };
    landed.current ??= land();
    // A link opened in the tab that asked for it changes the part after the `#` only: the page is
    // not loaded again, so nothing above runs. The same reading, when the address changes.
    window.addEventListener('hashchange', land);
    const stop = () => window.removeEventListener('hashchange', land);
    if (landed.current) return stop;

    // Somebody who is signed in already has nothing to do here. Quiet: nobody signed in is the
    // usual answer on this page, and not a session that ended.
    let asked = true;
    void call('GET', '/console/me', undefined, { quiet: true }).then((me) => {
      if (!asked) return;
      if (me.ok) return navigate('/', { replace: true });
      // A link that landed while the worker answered has the page now.
      setStage((now) => (now.kind === 'loading' ? { kind: 'form' } : now));
    });

    return () => {
      asked = false;
      stop();
    };
  }, [navigate, redeem]);

  // The title of the tab, as the mockup names it. The root gives back the name of the product.
  useEffect(() => {
    const before = document.title;
    document.title = t('Sign in to Fruitback');

    return () => {
      document.title = before;
    };
  });

  return (
    <EntryPage>
      {stage.kind === 'loading' ? <p aria-busy="true" /> : null}
      {stage.kind === 'form' ? (
        <Form
          email={email}
          onEmail={setEmail}
          onSent={(sent) => setStage({ kind: 'sent', email: sent })}
          problem={stage.problem ?? providerProblem(search.get('error'))}
        />
      ) : null}
      {stage.kind === 'sent' ? (
        <Sent
          email={stage.email}
          onBack={() => setStage({ kind: 'form' })}
          onSignedIn={() => navigate('/', { replace: true })}
        />
      ) : null}
      {stage.kind === 'landing' ? (
        <p role="status" className="text-lead text-muted">
          {t('Signing you in…')}
        </p>
      ) : null}
      {stage.kind === 'waiting' ? (
        <>
          <div className="mb-2">
            <Title>{t('You are not signed in yet')}</Title>
          </div>
          <Lead className="mb-7">
            <ReadProblem /> {t('Your link still works.')}
          </Lead>
          <div>
            <Button onClick={() => redeem(stage.code)}>{t('Try again')}</Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'opened' ? (
        <>
          <div className="mb-6 ml-1">
            <SuccessMark />
          </div>
          <div className="mb-2">
            <Title>{t('You are signed in')}</Title>
          </div>
          <p role="status" className="mb-7 text-lead text-muted">
            {t('Your other Fruitback tab has carried on without you. You can close this one.')}
          </p>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Continue in this tab')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'expired' ? (
        <Expired email={email} onEmail={setEmail} onSent={(sent) => setStage({ kind: 'sent', email: sent })} />
      ) : null}
    </EntryPage>
  );
}

type FormProps = {
  email: string;
  onEmail: (email: string) => void;
  onSent: (email: string) => void;
  problem?: string | undefined;
};

function Form({ email, onEmail, onSent, problem }: FormProps) {
  useLocale();
  const { providers, closed } = useSignInWays();

  return (
    <>
      <div className="mb-2">
        <Title>{t('Sign in to Fruitback')}</Title>
      </div>
      <Lead className="mb-7">{t('We email you a link that signs you in on this browser.')}</Lead>
      {closed ? (
        <SignInClosed />
      ) : (
        <>
          <EmailForm
            action={msg('Email me a link')}
            email={email}
            onEmail={onEmail}
            onSent={onSent}
            problem={problem}
          />
          <ProviderButtons providers={providers} />
        </>
      )}
      <p className="mt-8 text-small leading-auto text-muted">
        {t('New to Fruitback?')}{' '}
        <LinkButton space="inline" to="/setup">
          {t('Set up a workspace')}
        </LinkButton>
      </p>
    </>
  );
}

function Sent({ email, onBack, onSignedIn }: { email: string; onBack: () => void; onSignedIn: () => void }) {
  useLocale();
  useCarryOn(onSignedIn);
  const again = useSendAgain(email);

  return (
    <>
      <div className="mb-2">
        <Title>{t('Check your inbox')}</Title>
      </div>
      <p role="status" className="mb-2 text-lead">
        {withStrong(msg('A sign-in link is on its way to {email}.'), 'email', email)}
      </p>
      <p className="mb-7 text-body text-muted">
        {t('Open it in this browser and this tab signs in by itself. The link works once, for fifteen minutes.')}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Button tone="outline" size="page" inset={16} disabled={again.disabled} onClick={again.send}>
          {again.label}
        </Button>
        <AnotherAddress onBack={onBack} />
      </div>
      {again.problem === undefined ? null : (
        <div className="mt-3.5">
          <Problem>{t(again.problem)}</Problem>
        </div>
      )}
    </>
  );
}

function Expired({ email, onEmail, onSent }: Omit<FormProps, 'problem'>) {
  useLocale();
  const { closed } = useSignInWays();

  return (
    <>
      <div className="mb-2">
        <Title>{t('This link no longer works')}</Title>
      </div>
      <Lead className="mb-7">
        {t('A link works once, for fifteen minutes. This one was already used or ran out of time.')}
      </Lead>
      {closed ? (
        <SignInClosed />
      ) : (
        <EmailForm action={msg('Send me a new link')} email={email} onEmail={onEmail} onSent={onSent} />
      )}
    </>
  );
}
