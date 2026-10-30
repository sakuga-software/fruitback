import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { type AuthorizeRequest, MAX_AGENT_KEY_SITES, answerAuthorize, authorizeRequest, signOut } from '../api';
import { dayOf } from '../ago';
import { daysOf, endOf } from '../agent-keys';
import { refusalOf } from '../authorize-answer';
import { keepAuthorize } from '../connect-return';
import { msg, t } from '../i18n';
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
import { siteName } from '../site-address';
import { Button, Callout, Checks, EntryPage, Field, Lead, LinkButton, Pick, Problem, Title, Toggle } from '../ui';
import { useLocale } from '../use-locale';

/**
 * « Connect an agent » (FRU-467, the board `design/mcp-oauth/`): a client of OAuth, as a connector of
 * claude.ai, asked the worker for a token to `/mcp`, and the worker sent the browser here, at
 * `/authorize/<request>`, once it checked the client, its address of return and its PKCE.
 *
 * WARNING: the page never allows a client without a press on « Allow ». Who asks is said by the host
 * its code goes back to, in large: the name of the client is its own words, and anybody can register
 * one named « Claude ». Every choice is the one of an agent key (FRU-461), with the same defaults, and
 * never more rights than the client asked. A sign-in on this page leads back to the question.
 */
type Stage =
  | { kind: 'loading' }
  /** The worker did not answer. Nothing was decided: the same reading again. */
  | { kind: 'silent' }
  | { kind: 'signed-out' }
  | { kind: 'sent'; email: string }
  | { kind: 'ask'; asked: AuthorizeRequest }
  /** Answered: the browser leaves for the client. */
  | { kind: 'leaving'; host: string; allowed: boolean; detail?: string }
  /** Unknown, ended, or answered already. */
  | { kind: 'gone' };

async function resolve(request: string): Promise<Stage> {
  const read = await authorizeRequest(request);
  if (read.ok) return { kind: 'ask', asked: read.data };
  if (read.status === 401) return { kind: 'signed-out' };
  if (read.status === 0 || read.status === 429 || read.status >= 500) return { kind: 'silent' };

  return { kind: 'gone' };
}

export default function Authorize() {
  useLocale();
  const { request = '' } = useParams();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
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

  useEffect(() => {
    const before = document.title;
    document.title = t('Connect an agent');

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
            <Title>{t('Connect an agent')}</Title>
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
          onLeave={() => keepAuthorize(request)}
        />
      ) : null}
      {stage.kind === 'sent' ? (
        <Sent email={stage.email} onBack={() => setStage({ kind: 'signed-out' })} onSignedIn={read} />
      ) : null}
      {stage.kind === 'ask' ? (
        <Ask
          request={request}
          asked={stage.asked}
          onLeaving={setStage}
          onGone={() => setStage({ kind: 'gone' })}
          onSignedOut={() => setStage({ kind: 'signed-out' })}
        />
      ) : null}
      {stage.kind === 'leaving' ? (
        <>
          <div className="mb-2.5">
            <Title>
              {stage.allowed
                ? t('{host} is connected', { host: stage.host })
                : t('{host} is not connected', { host: stage.host })}
            </Title>
          </div>
          <p role="status" className="mb-3 text-lead text-muted">
            {t('Going back to {host}…', { host: stage.host })}
          </p>
          {stage.detail === undefined ? null : <p className="text-hint text-muted">{stage.detail}</p>}
        </>
      ) : null}
      {stage.kind === 'gone' ? (
        <>
          <div className="mb-2.5">
            <Title>{t('This request no longer works')}</Title>
          </div>
          <Lead className="mb-6">
            {t('A request works for ten minutes, and is answered once. Start again from the app that asked.')}
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
  asked: AuthorizeRequest;
  onLeaving: (stage: Stage) => void;
  onGone: () => void;
  onSignedOut: () => void;
};

/** The question: who asks, the workspace, its sites, the rights, the days, and « Allow » or « Deny ». */
function Ask({ request, asked, onLeaving, onGone, onSignedOut }: AskProps) {
  useLocale();
  const { host, name } = asked.client;
  const first = asked.workspaces[0];
  const [workspace, setWorkspace] = useState(first?.id ?? '');
  const [chosen, setChosen] = useState<string[]>([]);
  const [rights, setRights] = useState<'read' | 'write'>('read');
  const [days, setDays] = useState(String(asked.defaultDays));
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [errors, setErrors] = useState<{ sites?: string; days?: string }>({});
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const sitesRef = useRef<HTMLDivElement>(null);
  const daysRef = useRef<HTMLInputElement>(null);
  const sites = asked.workspaces.find((each) => each.id === workspace)?.sites ?? [];
  const writes = asked.scopes.includes('write');
  const lives = daysOf(days);
  const full = chosen.length >= MAX_AGENT_KEY_SITES;

  async function answer(choice: Parameters<typeof answerAuthorize>[2]) {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const answered = await answerAuthorize(request, asked.account.id, choice);
    if (answered.ok) {
      const ends = choice === undefined ? undefined : dayOf(endOf(choice.days, Date.now()));
      onLeaving({
        kind: 'leaving',
        host,
        allowed: choice !== undefined,
        ...(ends === undefined
          ? {}
          : { detail: t('It ends on {day}. Revoke it at any time in Workspace settings › Agents.', { day: ends }) }),
      });
      // The worker gave the address: the one the client registered, with the code or the refusal.
      window.location.assign(answered.data.redirect);
      return;
    }
    setBusy(false);
    const refusal = refusalOf(answered);
    if (refusal.is === 'signed-out') return onSignedOut();
    if (refusal.is === 'gone') return onGone();
    setProblem(refusal.problem);
  }

  function allow(event: FormEvent) {
    event.preventDefault();
    const found = {
      ...(chosen.length === 0 ? { sites: t('Tick at least one site.') } : {}),
      ...(lives === undefined ? { days: t('Choose from 1 to 365 days.') } : {}),
    };
    setErrors(found);
    if (found.sites !== undefined) return sitesRef.current?.querySelector('input')?.focus();
    if (lives === undefined) return daysRef.current?.focus();
    void answer({ workspace, sites: chosen, rights: writes ? rights : 'read', days: lives, verifiedOnly });
  }

  async function another() {
    setProblem(undefined);
    if (await signOut()) return onSignedOut();
    setProblem(msg('You are still signed in: Fruitback did not confirm the sign-out. Try again.'));
  }

  return (
    <>
      <div className="mb-2.5">
        <Title>{t('Connect an agent')}</Title>
      </div>
      <div className="mb-[14px] flex flex-col gap-[2px] rounded-box border border-line bg-subtle px-[16px] py-[14px]">
        <span data-client-host className="text-section font-bold [overflow-wrap:anywhere]">
          {host}
        </span>
        <span className="text-hint text-muted [overflow-wrap:anywhere]">{t('Calls itself « {name} »', { name })}</span>
      </div>
      <p className="mb-4 text-lead text-ink-soft">
        {withStrong(
          msg(
            '{host} asks to read the notes of your sites through the MCP server of Fruitback, as an agent of your team.',
          ),
          'host',
          host,
        )}
      </p>
      <p className="mb-6 text-small text-ink-soft">
        {withStrong(msg('Signed in as {email}.'), 'email', asked.account.email)}{' '}
        <LinkButton space="inline" onClick={() => void another()}>
          {t('Not you?')}
        </LinkButton>
      </p>
      {asked.workspaces.length === 0 ? (
        <>
          <Callout className="mb-6">
            <p className="text-body">
              {t('Only an owner or an admin of a workspace can connect an agent. Ask one of them to connect it.')}
            </p>
          </Callout>
          {problem === undefined ? null : (
            <div className="mb-3.5">
              <Problem>{t(problem)}</Problem>
            </div>
          )}
          <Button tone="outline" size="page" disabled={busy} onClick={() => void answer(undefined)}>
            {t('Deny')}
          </Button>
        </>
      ) : (
        <form noValidate onSubmit={allow} className="flex flex-col gap-[20px]">
          <Pick
            label={t('Workspace')}
            value={workspace}
            onChange={(next) => {
              setWorkspace(next);
              setChosen([]);
            }}
            options={asked.workspaces.map((each) => ({
              value: each.id,
              label: each.name,
              detail: t('The agent reaches this workspace, never another.'),
            }))}
          />
          <Checks
            label={t('Sites it reads')}
            value={chosen}
            onChange={setChosen}
            groupRef={sitesRef}
            options={sites.map((site) => ({
              value: site.id,
              label: siteName(site.origin),
              detail: site.visibility === 'everyone' ? t('Everyone reads its notes') : t('Members read its notes'),
              disabled: full && !chosen.includes(site.id),
            }))}
            {...(errors.sites === undefined ? {} : { error: errors.sites })}
          />
          {writes ? (
            <Pick
              label={t('What it can do')}
              value={rights}
              onChange={setRights}
              options={[
                { value: 'read', label: t('Read'), detail: t('The notes, their replies and their status.') },
                {
                  value: 'write',
                  label: t('Read and write'),
                  detail: t('It also replies in a thread, and sets a status. Its replies say « Agent ».'),
                },
              ]}
            />
          ) : (
            <p className="text-small text-ink-soft">
              {t('{host} asked to read only: the notes, their replies and their status.', { host })}
            </p>
          )}
          <div className="max-w-[240px]">
            <Field
              label={t('Ends after, in days')}
              value={days}
              inputMode="numeric"
              inputRef={daysRef}
              onChange={(event) => setDays(event.target.value)}
              {...(errors.days === undefined
                ? { hint: t('From 1 to 365 days, as an agent key.') }
                : { error: errors.days })}
            />
          </div>
          <div className="rounded-box border border-line px-[16px] py-[12px]">
            <Toggle
              strong
              label={t('Only the notes of known people')}
              hint={t(
                'On a site that everyone reads, the agent does not read the notes of visitors: anybody can write one.',
              )}
              value={verifiedOnly}
              onChange={setVerifiedOnly}
            />
          </div>
          <p className="text-hint text-muted">
            {t('You can revoke it at any time in Workspace settings › Agents. It stops at once.')}
          </p>
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          <div className="flex flex-col gap-[10px]">
            <Button type="submit" size="page" disabled={busy}>
              {busy ? t('Allowing…') : t('Allow {host}', { host })}
            </Button>
            <Button tone="outline" size="page" disabled={busy} onClick={() => void answer(undefined)}>
              {t('Deny')}
            </Button>
          </div>
          <p className="text-hint text-muted [overflow-wrap:anywhere]">
            {t('You go back to {address}', { address: asked.redirectUri })}
          </p>
        </form>
      )}
    </>
  );
}

type SignedOutProps = {
  email: string;
  onEmail: (email: string) => void;
  onSent: (email: string) => void;
  onLeave: () => void;
};

/** Nobody signed in: the ways in of the sign-in page, and back to the question after. */
function SignedOut({ email, onEmail, onSent, onLeave }: SignedOutProps) {
  useLocale();
  const { providers, closed } = useSignInWays();

  return (
    <>
      <div className="mb-2.5">
        <Title>{t('Connect an agent')}</Title>
      </div>
      <Lead className="mb-6">
        {t('An app asks to connect to Fruitback as an agent of your team. Sign in to answer it.')}
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

/** The link is on its way: this page goes back to the question when it is opened. */
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
        {t('Open it in this browser: this page comes back to the question. The link works once, for fifteen minutes.')}
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
