import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { type ConnectRequest, type Me, answerConnect, call, connectRequest, signOut } from '../api';
import { keepConnect } from '../connect-return';
import { locale, msg, t } from '../i18n';
import { DID_NOT_ANSWER } from '../problems';
import {
  AnotherAddress,
  EmailForm,
  ProviderButtons,
  SignInClosed,
  useCarryOn,
  useSendAgain,
  useSignInWays,
  withStrong,
} from '../sign-in-form';
import { Button, EntryPage, KeyValue, Lead, LinkButton, Problem, SuccessMark, Title, VerifyWord } from '../ui';
import { useLocale } from '../use-locale';

/**
 * « Connect this browser » (FRU-240, screen 04 of the mockup of 2026-10-13): the extension asked to
 * sign in as the person, and this page answers. The extension opened it at `/connect/<request>`.
 *
 * WARNING: the page never connects a browser without a press on « Connect ». The person must see
 * the word, and check that the popup shows the same one: a request that somebody else made shows
 * another word, or none. A sign-in on this page (a link, a provider) leads back to the question, and
 * never to the answer. The word, the browser and the workspaces come from the worker, never from
 * the address of the page.
 */
type Stage =
  | { kind: 'loading' }
  /** The worker did not answer. Nothing was decided: the same reading again. */
  | { kind: 'silent' }
  | { kind: 'signed-out' }
  | { kind: 'sent'; email: string }
  | { kind: 'ask'; request: Asked }
  | { kind: 'connected'; request: ConnectRequest }
  | { kind: 'refused' }
  /** Expired, unknown, or answered already by somebody else: nothing to do here any more. */
  | { kind: 'gone' };

/** The name of a browser in a sentence: « Chrome » for « Chrome on macOS ». */
function short(browser: string): string {
  return browser.split(' on ')[0] ?? browser;
}

/**
 * The browser this page runs in, before the worker says it: the extension that asks is in this
 * browser. Only for the sentence of a person who is not signed in, who cannot read the request yet.
 */
function thisBrowser(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const agent = navigator.userAgent;
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Firefox/')) return 'Firefox';
  if (agent.includes('Chrome/')) return 'Chrome';
  if (agent.includes('Safari/')) return 'Safari';

  return undefined;
}

/** A request that waits, with all the page shows of it. */
type Asked = ConnectRequest & { word: string; account: NonNullable<ConnectRequest['account']> };

/** What a request that was read is for this page. */
function stageOf(request: ConnectRequest): Stage {
  if (request.state === 'pending') {
    const { word, account } = request;
    // A request that waits with no word, or no account, is no question: the person could not check it.
    return word === undefined || account === undefined
      ? { kind: 'gone' }
      : { kind: 'ask', request: { ...request, word, account } };
  }
  // Approved here or in another tab, and maybe claimed by the extension since: it is connected.
  if (request.state === 'approved' || request.state === 'claimed') return { kind: 'connected', request };
  if (request.state === 'refused') return { kind: 'refused' };

  return { kind: 'gone' };
}

/**
 * Reads the request, and says which stage the page is at. The worker reads the session. An answered
 * request comes with its browser only: the workspaces it reads are those of the account, now.
 */
async function resolve(request: string): Promise<Stage> {
  const read = await connectRequest(request);
  if (
    read.ok &&
    read.data.workspaces === undefined &&
    (read.data.state === 'approved' || read.data.state === 'claimed')
  ) {
    const me = await call<Me>('GET', '/console/me', undefined, { quiet: true });
    // Workspaces that could not be read are not « none »: the page reads again rather than send the
    // person to the setup.
    if (!me.ok) return me.status === 401 ? { kind: 'signed-out' } : { kind: 'silent' };

    return stageOf({ ...read.data, workspaces: me.data.workspaces });
  }
  if (read.ok) return stageOf(read.data);
  if (read.status === 401) return { kind: 'signed-out' };
  if (read.status === 0 || read.status === 429 || read.status >= 500) return { kind: 'silent' };

  // 404: unknown, or answered by another account. 410: expired. Nothing to do here any more.
  return { kind: 'gone' };
}

export default function Connect() {
  useLocale();
  const { request = '' } = useParams();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Kept above the stages: « Use another address » gives the form back with the address in it.
  const [email, setEmail] = useState('');

  const read = useCallback(() => {
    setStage({ kind: 'loading' });
    void resolve(request).then(setStage);
  }, [request]);

  // In development an effect runs twice: the reading is the same, and changes nothing.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    read();
  }, [read]);

  // The title of the tab, as the mockup names it. The root gives back the name of the product.
  useEffect(() => {
    const before = document.title;
    document.title = t('Connect this browser');

    return () => {
      document.title = before;
    };
  });

  return (
    <EntryPage width="wide">
      {stage.kind === 'loading' ? <p aria-busy="true" /> : null}
      {stage.kind === 'silent' ? (
        <>
          <div className="mb-2.5">
            <Title>{t('Connect this browser')}</Title>
          </div>
          <p role="alert" className="mb-6 text-lead text-muted">
            {t(DID_NOT_ANSWER)}
          </p>
          <div>
            <Button tone="outline" size="page" onClick={read}>
              {t('Try again')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'signed-out' ? (
        <SignedOut
          email={email}
          onEmail={setEmail}
          onSent={(sent) => setStage({ kind: 'sent', email: sent })}
          onLeave={() => keepConnect(request)}
        />
      ) : null}
      {stage.kind === 'sent' ? (
        <Sent email={stage.email} onBack={() => setStage({ kind: 'signed-out' })} onSignedIn={read} />
      ) : null}
      {stage.kind === 'ask' ? (
        <Ask
          request={request}
          asked={stage.request}
          onAnswered={setStage}
          onRead={read}
          onSignedOut={() => setStage({ kind: 'signed-out' })}
        />
      ) : null}
      {stage.kind === 'connected' ? <Connected request={stage.request} /> : null}
      {stage.kind === 'refused' ? (
        <>
          <div className="mb-2.5">
            <Title>{t('This browser is not connected')}</Title>
          </div>
          <p role="status" className="mb-6 text-lead text-muted">
            {t('The extension stays signed out. To connect it later, open its popup and sign in from there.')}
          </p>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Go to the console')}
            </Button>
          </div>
        </>
      ) : null}
      {stage.kind === 'gone' ? (
        <>
          <div className="mb-2.5">
            <Title>{t('This request no longer works')}</Title>
          </div>
          <Lead className="mb-6">
            {t(
              'A request works for fifteen minutes, and is answered once. Open the popup again, and sign in from there.',
            )}
          </Lead>
          <div>
            <Button tone="outline" size="page" to="/">
              {t('Go to the console')}
            </Button>
          </div>
        </>
      ) : null}
    </EntryPage>
  );
}

type AskProps = {
  request: string;
  asked: Asked;
  onAnswered: (stage: Stage) => void;
  onRead: () => void;
  onSignedOut: () => void;
};

/** The question: the word, who asks, and « Connect ». */
function Ask({ request, asked, onAnswered, onRead, onSignedOut }: AskProps) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const browser = short(asked.browser);
  const names = (asked.workspaces ?? []).map((each) => each.name);

  async function answer(approve: boolean) {
    // One answer at a time: a second press while the first is on its way sends nothing.
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const answered = await answerConnect(request, asked, approve);
    setBusy(false);
    if (answered.ok) return onAnswered(stageOf({ ...asked, ...answered.data }));
    // Answered in another tab or by the clock, another account signed in since the page read it, or a
    // word the worker does not take: the page reads what the request is now, for this session.
    if ([404, 409, 410, 422].includes(answered.status)) return onRead();
    if (answered.status === 401) return onSignedOut();
    setProblem(DID_NOT_ANSWER);
  }

  async function another() {
    setProblem(undefined);
    if (await signOut()) return onSignedOut();
    setProblem(msg('You are still signed in: Fruitback did not confirm the sign-out. Try again.'));
  }

  return (
    <>
      <div className="mb-2.5">
        <Title>{t('Connect this browser')}</Title>
      </div>
      <Lead className="mb-6">
        {t(
          'The Fruitback extension asks to sign in as you. It reads and leaves notes on the sites of your workspaces, and nothing else.',
        )}
      </Lead>
      <div className="mb-6">
        <VerifyWord word={asked.word}>{t('Check that the popup shows the same word')}</VerifyWord>
      </div>
      <div className="mb-7">
        <KeyValue
          rows={[
            { term: t('Account'), value: asked.account.email },
            { term: t('Browser'), value: asked.browser },
            {
              term: t('Workspaces'),
              value: names.length === 0 ? t('No workspace yet') : names.join(', '),
            },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Button inset={26} disabled={busy} onClick={() => void answer(true)}>
          {busy ? t('Connecting…') : t('Connect {browser}', { browser })}
        </Button>
        <LinkButton space="loose" disabled={busy} onClick={() => void answer(false)}>
          {t('Not now')}
        </LinkButton>
      </div>
      {problem === undefined ? null : (
        <div className="mt-3.5">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
      <p className="mt-6 text-hint text-muted">
        {t('You can disconnect it at any time from My account.')}{' '}
        {withStrong(msg('Not {email}?'), 'email', asked.account.email)}{' '}
        <LinkButton space="inline" onClick={() => void another()}>
          {t('Use another address')}
        </LinkButton>
      </p>
    </>
  );
}

/** Connected: where the extension now reads, or what to do when the account has no workspace. */
function Connected({ request }: { request: ConnectRequest }) {
  useLocale();
  const browser = short(request.browser);
  const names = (request.workspaces ?? []).map((each) => each.name);
  const list = new Intl.ListFormat(locale(), { type: 'disjunction' }).format(names);

  return (
    <>
      <div className="mb-6 ml-1">
        <SuccessMark />
      </div>
      <div className="mb-2.5">
        <Title>{t('{browser} is connected', { browser })}</Title>
      </div>
      {names.length === 0 ? (
        <>
          <p role="status" className="mb-6 text-lead text-muted">
            {t(
              'It reads the sites of your workspaces, and you have none yet. Set one up, and the popup finds its site.',
            )}
          </p>
          <div>
            <Button to="/setup">{t('Set up a workspace')}</Button>
          </div>
        </>
      ) : (
        <p role="status" className="text-lead text-muted">
          {t('Open the popup on any site of {workspaces}. You can close this tab.', { workspaces: list })}
        </p>
      )}
    </>
  );
}

type SignedOutProps = {
  email: string;
  onEmail: (email: string) => void;
  onSent: (email: string) => void;
  /** Before a provider: the front door comes back here after it (`connect-return.ts`). */
  onLeave: () => void;
};

/** Nobody signed in: the same ways in as the sign-in page, and back to the question after. */
function SignedOut({ email, onEmail, onSent, onLeave }: SignedOutProps) {
  useLocale();
  const { providers, closed } = useSignInWays();
  const browser = thisBrowser();

  return (
    <>
      <div className="mb-2.5">
        <Title>{t('Sign in to connect this browser')}</Title>
      </div>
      <Lead className="mb-6">
        {browser === undefined
          ? t('The Fruitback extension is waiting. Sign in, then check the word and connect it.')
          : t('The Fruitback extension in {browser} is waiting. Sign in, then check the word and connect it.', {
              browser,
            })}
      </Lead>
      {closed ? (
        <SignInClosed />
      ) : (
        <>
          <EmailForm action={msg('Email me a link')} email={email} onEmail={onEmail} onSent={onSent} />
          <ProviderButtons providers={providers} onLeave={onLeave} />
        </>
      )}
    </>
  );
}

/** The link is on its way: this page goes back to the question when it is opened (FRU-235). */
function Sent({ email, onBack, onSignedIn }: { email: string; onBack: () => void; onSignedIn: () => void }) {
  useLocale();
  useCarryOn(onSignedIn);
  const again = useSendAgain(email);

  return (
    <>
      <div className="mb-2.5">
        <Title>{t('Check your inbox')}</Title>
      </div>
      <p role="status" className="mb-2 text-lead">
        {withStrong(msg('A sign-in link is on its way to {email}.'), 'email', email)}
      </p>
      <p className="mb-7 text-body text-muted">
        {t(
          'Open it in this browser: this page comes back to the word to check. The link works once, for fifteen minutes.',
        )}
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
