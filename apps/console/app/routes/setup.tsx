import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  API,
  providerStart,
  type Me,
  type Site,
  type Visibility,
  type Workspace,
  call,
  pairingLink,
  rememberWorkspaceName,
  requestLink,
  saveLanguage,
  takeWorkspaceName,
} from '../api';
import { NAME_PROBLEMS, SITE_NOT_ADDED, SITE_PROBLEMS, WORKSPACE_NOT_CREATED, copyText, problemOf } from '../problems';
import { Button, Field, Mark, Pick, Problem, WideButton } from '../ui';
import { adoptLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import {
  LINK_NOT_SENT,
  SEND_PROBLEMS,
  SignInClosed,
  providerProblem,
  useCarryOn,
  useSignInWays,
} from '../sign-in-form';
import { siteAddress } from '../site-address';

/**
 * « Create your workspace », the four steps of the setup (design/boards/2-onboarding.png).
 *
 * The steps are the design's. What this beta has not built yet is shown and disabled, with the reason
 * in words: Google sign-in, and the sources other than the workspace's own (FRU-102).
 */

const STEPS = [
  { title: msg('Workspace'), hint: msg('Sign in, name it') },
  { title: msg('Source'), hint: msg('Where feedback goes') },
  { title: msg('Site'), hint: msg('The address you review') },
  { title: msg('Install'), hint: msg('Script or extension') },
] as const;

const DOCS = 'https://fruitback.com';

type Stage =
  | { kind: 'loading' }
  | { kind: 'sign-in' }
  | { kind: 'sent'; email: string }
  | { kind: 'name' }
  | { kind: 'source'; workspace: Workspace }
  | { kind: 'site'; workspace: Workspace }
  | { kind: 'install'; workspace: Workspace; site: Site };

function stepOf(stage: Stage): number {
  if (stage.kind === 'source') return 2;
  if (stage.kind === 'site') return 3;
  if (stage.kind === 'install') return 4;

  return 1;
}

let resolving: Promise<Stage> | undefined;

/**
 * WARNING: one resolution at a time. It can create the workspace named before the link was sent, and
 * two resolutions in flight would create it twice, or let the second ask for a name the first took.
 */
function resolveOnce(step: string | null): Promise<Stage> {
  resolving ??= resolveStage(step).finally(() => {
    resolving = undefined;
  });

  return resolving;
}

async function resolveStage(step: string | null): Promise<Stage> {
  // Quiet: a person who is not signed in gets the sign-in screen, not the notice of a session that ended.
  const me = await call<Me>('GET', '/console/me', undefined, { quiet: true });
  if (!me.ok) return { kind: 'sign-in' };
  adoptLanguage(me.data.account, saveLanguage);

  const workspace = me.data.workspaces[0];
  if (workspace !== undefined) return step === 'site' ? { kind: 'site', workspace } : { kind: 'source', workspace };

  // The name typed before the link was sent: the workspace is made without asking again.
  const pending = takeWorkspaceName();
  if (pending === undefined) return { kind: 'name' };
  const created = await call<Workspace>('POST', '/console/workspaces', { name: pending });

  return created.ok ? { kind: 'source', workspace: created.data } : { kind: 'name' };
}

export default function Setup() {
  useLocale();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [search] = useSearchParams();

  useEffect(() => {
    let live = true;
    void resolveOnce(search.get('step')).then((resolved) => {
      if (live) setStage(resolved);
    });

    return () => {
      live = false;
    };
  }, [search]);

  return (
    <div className="min-h-screen bg-setup">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-[1080px] items-center justify-between px-4">
          {/* On a phone each label stays on one line (FRU-160): « Set up » is left to the screen
              reader, which the card's title repeats, and the tabs are tighter. Under 360 px the name
              goes too, and the mark stays. */}
          <div className="flex items-center gap-2.5 whitespace-nowrap">
            <Mark />
            <span className="text-[15px] font-semibold max-[359px]:sr-only">{t('Fruitback')}</span>
            <span className="ml-3 text-[15px] text-muted max-sm:sr-only">{t('Set up')}</span>
          </div>
          <nav
            aria-label={t('How to run Fruitback')}
            className="flex rounded-lg bg-chip p-1 text-[13px] font-semibold whitespace-nowrap sm:text-sm"
          >
            <span aria-current="page" className="rounded-md bg-surface px-2.5 py-1.5 text-ink shadow-sm sm:px-3.5">
              {t('Fruitback Cloud')}
            </span>
            <a
              href={`${DOCS}/self-hosting.html`}
              className="rounded-md px-2.5 py-1.5 text-muted hover:text-ink sm:px-3.5"
            >
              {t('Self-hosted')}
            </a>
          </nav>
        </div>
      </header>

      {/* Under md the steps are a row of numbers, with the title of the current one, so the card and its
          action come up the screen (FRU-160). */}
      <main className="mx-auto grid max-w-[1080px] gap-4 px-4 py-6 md:grid-cols-[220px_1fr] md:gap-8 md:py-10">
        <ol className="flex items-center gap-2 md:block md:space-y-1.5" aria-label={t('Steps')}>
          {STEPS.map((step, index) => {
            const number = index + 1;
            const current = number === stepOf(stage);

            return (
              <li
                key={step.title}
                aria-current={current ? 'step' : undefined}
                className={`flex items-center gap-3 rounded-xl md:px-3 md:py-2.5 ${
                  current ? 'min-w-0 flex-1 md:border md:border-line md:bg-surface' : ''
                }`}
              >
                <span
                  className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                    current ? 'bg-accent text-white' : 'border border-control text-muted'
                  }`}
                >
                  {number}
                </span>
                <span className={current ? 'min-w-0' : 'max-md:sr-only'}>
                  <span className="block text-sm font-semibold">{t(step.title)}</span>
                  <span className="block text-xs text-muted max-md:sr-only">{t(step.hint)}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <StageCard stage={stage} onStage={setStage} />
      </main>
    </div>
  );
}

function StageCard({ stage, onStage }: { stage: Stage; onStage: (stage: Stage) => void }) {
  useLocale();
  if (stage.kind === 'loading') return <Frame step={1} title={t('Create your workspace')} />;
  if (stage.kind === 'sign-in') return <SignIn onSent={(email) => onStage({ kind: 'sent', email })} />;

  if (stage.kind === 'sent') {
    return (
      <Sent
        email={stage.email}
        onBack={() => onStage({ kind: 'sign-in' })}
        // Signed in from another tab: the same resolution as a visit, which makes the workspace
        // named before the link was sent.
        onSignedIn={() => void resolveOnce(null).then(onStage)}
      />
    );
  }
  if (stage.kind === 'name') return <NameIt onCreated={(workspace) => onStage({ kind: 'source', workspace })} />;
  if (stage.kind === 'source') return <Source onNext={() => onStage({ kind: 'site', workspace: stage.workspace })} />;
  if (stage.kind === 'site') {
    return (
      <SiteStep
        workspace={stage.workspace}
        onAdded={(site) => onStage({ kind: 'install', workspace: stage.workspace, site })}
      />
    );
  }

  return <Install workspace={stage.workspace} site={stage.site} />;
}

/** The card of a step, with the footer of the board: the step number and the one action. */
function Frame({
  step,
  title,
  lead,
  children,
  action,
  onSubmit,
}: {
  step: number;
  title: string;
  lead?: string;
  children?: ReactNode;
  action?: ReactNode;
  onSubmit?: (event: FormEvent) => void;
}) {
  useLocale();
  return (
    <form
      onSubmit={onSubmit ?? ((event) => event.preventDefault())}
      className="flex min-w-0 flex-col rounded-[14px] border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(28,25,23,0.25)] md:min-h-[540px]"
    >
      <div className="flex-1 px-5 pt-6 pb-6 md:px-7 md:pt-8">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">{title}</h1>
        {lead === undefined ? null : <p className="mt-2 text-[15px] text-muted">{lead}</p>}
        <div className="mt-6 max-w-[420px] space-y-4">{children}</div>
      </div>
      <div className="flex items-center justify-end gap-4 border-t border-line px-5 py-4 md:px-7">
        <span className="text-sm text-muted">{t('Step {step} of {total}', { step, total: 4 })}</span>
        {action}
      </div>
    </form>
  );
}

function SignIn({ onSent }: { onSent: (email: string) => void }) {
  useLocale();
  const [search] = useSearchParams();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(providerProblem(search.get('error')));
  const { providers, closed } = useSignInWays();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    if (name.trim() !== '') rememberWorkspaceName(name.trim());
    const sent = await requestLink(email, locale());
    setBusy(false);
    if (sent.ok) return onSent(email.trim());

    setProblem(SEND_PROBLEMS[sent.error] ?? LINK_NOT_SENT);
  }

  if (closed) {
    return (
      <Frame
        step={1}
        title={t('Create your workspace')}
        lead={t('One workspace for your team, your sites and your sources. Hosted in Europe.')}
      >
        <SignInClosed />
      </Frame>
    );
  }

  return (
    <Frame
      step={1}
      title={t('Create your workspace')}
      lead={t('One workspace for your team, your sites and your sources. Hosted in Europe.')}
      onSubmit={submit}
      action={
        <Button type="submit" disabled={busy || email.trim() === ''}>
          {busy ? t('Sending…') : t('Continue')}
        </Button>
      }
    >
      {providers.google ? (
        <WideButton onClick={() => (window.location.href = providerStart('google'))}>
          {t('Continue with Google')}
        </WideButton>
      ) : (
        <WideButton disabled note={t('Google sign-in is not set up on this Fruitback')}>
          {t('Continue with Google')}
        </WideButton>
      )}
      {providers.github ? (
        <WideButton onClick={() => (window.location.href = providerStart('github'))}>
          {t('Continue with GitHub')}
        </WideButton>
      ) : (
        <WideButton disabled note={t('GitHub sign-in is not set up on this Fruitback')}>
          {t('Continue with GitHub')}
        </WideButton>
      )}
      <div className="flex items-center gap-3 py-1 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        {t('or with an email link')}
        <span className="h-px flex-1 bg-line" />
      </div>
      <Field
        label={t('Work email')}
        type="email"
        autoComplete="email"
        placeholder="you@studio.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <Field
        label={t('Workspace name')}
        placeholder="Sakuga"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </Frame>
  );
}

function Sent({ email, onBack, onSignedIn }: { email: string; onBack: () => void; onSignedIn: () => void }) {
  useLocale();
  // The link is opened in another tab: this one goes on to the next step by itself (FRU-235).
  useCarryOn(onSignedIn);

  return (
    <Frame
      step={1}
      title={t('Check your inbox')}
      lead={t('A sign-in link is on its way to {email}. It works once, for fifteen minutes.', { email })}
      action={
        <Button tone="outline" onClick={onBack}>
          {t('Use another address')}
        </Button>
      }
    >
      <p className="text-sm text-muted">
        {t('Open it in this browser. Nothing in it asks for a password, and ignoring it is safe.')}
      </p>
    </Frame>
  );
}

function NameIt({ onCreated }: { onCreated: (workspace: Workspace) => void }) {
  useLocale();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await call<Workspace>('POST', '/console/workspaces', { name });
    if (created.ok) return onCreated(created.data);
    setProblem(problemOf(created, NAME_PROBLEMS, WORKSPACE_NOT_CREATED));
  }

  return (
    <Frame
      step={1}
      title={t('Name your workspace')}
      lead={t('You are signed in. One more word, and the workspace exists.')}
      onSubmit={submit}
      action={
        <Button type="submit" disabled={name.trim() === ''}>
          {t('Continue')}
        </Button>
      }
    >
      <Field
        label={t('Workspace name')}
        placeholder="Sakuga"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </Frame>
  );
}

/**
 * Where the notes go, as it is at the end of the set-up (FRU-166). The step chooses nothing: Fruitback
 * keeps the notes, and the sources that the Connectors screen connects say so, rather than « After the
 * beta ». When the step connects a source itself, it becomes a choice again.
 */
const SOURCES = [
  {
    key: 'fruitback',
    name: 'Fruitback',
    detail: msg('Notes stay in this workspace. Nothing to connect.'),
    state: msg('Selected'),
  },
  {
    key: 'linear',
    name: 'Linear',
    detail: msg('An issue per note, in the team you choose.'),
    state: msg('In Connectors, after the set-up'),
  },
  {
    key: 'rest',
    name: msg('REST API'),
    detail: msg('POST each note to your own endpoint.'),
    state: msg('In Connectors, after the set-up'),
  },
  {
    key: 'github',
    name: 'GitHub Issues',
    detail: msg('An issue per note, in one repository.'),
    state: msg('After the beta'),
  },
] as const;

function Source({ onNext }: { onNext: () => void }) {
  useLocale();
  return (
    <Frame
      step={2}
      title={t('Where should feedback go?')}
      lead={t(
        'For now the notes stay in this workspace. Linear and a REST API connect after the set-up, in Connectors.',
      )}
      action={<Button onClick={onNext}>{t('Continue')}</Button>}
    >
      {/* A list to read, not a choice: nothing here is chosen, so it is no radio group (FRU-166). */}
      <ul aria-label={t('Sources')} className="space-y-2">
        {SOURCES.map((source) => (
          <li
            key={source.key}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border px-4 py-3 ${
              source.key === 'fruitback' ? 'border-ink' : 'border-line text-muted'
            }`}
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-chip text-xs font-bold text-ink"
            >
              {source.key === 'rest' ? '{}' : source.name.charAt(0)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{t(source.name)}</span>
              <span className="block text-xs">{t(source.detail)}</span>
            </span>
            {/* On a phone the state has its own line, under the words: beside them it squeezed them (FRU-166). */}
            <span className="w-full pl-11 text-xs font-semibold sm:w-auto sm:pl-0">{t(source.state)}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

function SiteStep({ workspace, onAdded }: { workspace: Workspace; onAdded: (site: Site) => void }) {
  useLocale();
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('members');
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // The same reading as the Sites screen: a host with no scheme is https (FRU-167).
    const address = siteAddress(url);
    if (address === undefined) return setProblem(SITE_PROBLEMS['invalid-url'] ?? SITE_NOT_ADDED);
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url: address, visibility });
    if (added.ok) return onAdded(added.data);
    setProblem(problemOf(added, SITE_PROBLEMS, SITE_NOT_ADDED));
  }

  return (
    <Frame
      step={3}
      title={t('Which site do you review?')}
      lead={t('Paste its address. Any page of it will do.')}
      onSubmit={submit}
      action={
        <Button type="submit" disabled={url.trim() === ''}>
          {t('Continue')}
        </Button>
      }
    >
      <Field
        label={t('Site address')}
        inputMode="url"
        autoComplete="url"
        placeholder="https://staging.acme.dev"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Pick
        label={t('Who sees the feedback?')}
        value={visibility}
        onChange={setVisibility}
        options={[
          {
            value: 'members',
            label: t('The members of {workspace}', { workspace: workspace.name }),
            detail: t('Visitors of the site see no note.'),
          },
          {
            value: 'everyone',
            label: t('Everyone who visits the site'),
            detail: t('For a public « report a problem ».'),
          },
        ]}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </Frame>
  );
}

/** The script tag a site embeds, pointing at this console's copy of the widget. */
export function snippetFor(site: Site): string {
  return [
    '<script',
    `  src="${window.location.origin}/fruitback.iife.js"`,
    `  data-fruitback-endpoint="${API}"`,
    `  data-fruitback-client="${site.id}"`,
    '  defer',
    '></script>',
  ].join('\n');
}

function Install({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const navigate = useNavigate();

  return (
    <Frame
      step={4}
      title={t('Install it')}
      lead={t('Two ways to put Fruitback on {site}. Use one, or both.', { site: new URL(site.origin).host })}
      action={<Button onClick={() => navigate(`/w/${workspace.id}/sites`)}>{t('Finish')}</Button>}
    >
      <InstallOptions workspace={workspace} site={site} />
    </Frame>
  );
}

// Every role connects a browser, so no code of the worker has a sentence of its own here.
const CONNECT_PROBLEMS: Readonly<Record<string, string>> = {};
const BROWSER_NOT_CONNECTED = msg('This browser was not connected. Try again.');

export function InstallOptions({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const [link, setLink] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const snippet = snippetFor(site);

  async function connect() {
    // Open the tab in the click, before the await: a browser blocks a window opened after one.
    // The tab loses its `opener` before it loads the pairing page.
    const tab = window.open('', '_blank');
    setProblem(undefined);
    const minted = await call<{ code: string }>('POST', `/console/workspaces/${workspace.id}/connect`, {});
    if (!minted.ok) {
      // The tab that just opened closes: the reason is said under the button (FRU-164).
      tab?.close();
      return setProblem(problemOf(minted, CONNECT_PROBLEMS, BROWSER_NOT_CONNECTED));
    }
    const target = pairingLink(minted.data.code);
    setLink(target);
    if (tab !== null) {
      tab.opener = null;
      tab.location.href = target;
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">{t('Script')}</h2>
        <p className="mb-2 text-xs text-muted">{t('Paste it before the closing body tag of the site.')}</p>
        <pre className="overflow-x-auto rounded-md bg-chip p-3 font-mono text-xs leading-5">{snippet}</pre>
        <Button
          tone="outline"
          className="mt-2"
          onClick={() => void copyText(snippet).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
        >
          {copied === 'yes' ? t('Copied') : t('Copy the script')}
        </Button>
        {copied === 'refused' ? (
          <p role="alert" className="mt-2 text-xs text-muted">
            {t('The browser refused the copy. Select the script above and copy it by hand.')}
          </p>
        ) : null}
      </div>
      <div>
        <h2 className="text-sm font-semibold">{t('Extension')}</h2>
        <p className="mb-2 text-xs text-muted">
          {t(
            'Nothing to change on the site. Connect this browser, then click the Fruitback icon on the page that opens.',
          )}
        </p>
        <Button tone="outline" onClick={() => void connect()}>
          {t('Connect this browser')}
        </Button>
        {problem === undefined ? null : (
          <div className="mt-2">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
        {link === undefined ? null : (
          <p className="mt-2 text-xs text-muted">
            {t('A page opened in a new tab. If it did not, open')}{' '}
            <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
              {t('this link')}
            </a>
            {t(': it works once, for fifteen minutes.')}
          </p>
        )}
      </div>
    </div>
  );
}
