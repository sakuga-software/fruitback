import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  API,
  type Me,
  type Providers,
  type Site,
  type Visibility,
  type Workspace,
  call,
  pairingLink,
  rememberWorkspaceName,
  requestLink,
  saveLanguage,
  signInProviders,
  takeWorkspaceName,
} from '../api';
import { Button, Field, Mark, Pick, Problem, WideButton } from '../ui';
import { adoptLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

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

/**
 * The providers before the worker says which it has (FRU-135). The build argument of FRU-97 still
 * turns GitHub on at once, so its button does not wait for an answer where it was already shown.
 */
const PROVIDERS_AT_FIRST: Providers = { github: import.meta.env.VITE_FRUITBACK_GITHUB === '1', google: false };

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
  const me = await call<Me>('GET', '/console/me');
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
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[15px] font-semibold">{t('Fruitback')}</span>
            <span className="ml-3 text-[15px] text-muted">{t('Set up')}</span>
          </div>
          <nav aria-label={t('How to run Fruitback')} className="flex rounded-lg bg-chip p-1 text-sm font-semibold">
            <span aria-current="page" className="rounded-md bg-surface px-3.5 py-1.5 text-ink shadow-sm">
              {t('Fruitback Cloud')}
            </span>
            <a href={`${DOCS}/self-hosting.html`} className="rounded-md px-3.5 py-1.5 text-muted hover:text-ink">
              {t('Self-hosted')}
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1080px] gap-8 px-4 py-10 md:grid-cols-[220px_1fr]">
        <ol className="space-y-1.5" aria-label={t('Steps')}>
          {STEPS.map((step, index) => {
            const number = index + 1;
            const current = number === stepOf(stage);

            return (
              <li
                key={step.title}
                aria-current={current ? 'step' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${current ? 'border border-line bg-surface' : ''}`}
              >
                <span
                  className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                    current ? 'bg-accent text-white' : 'border border-faint text-muted'
                  }`}
                >
                  {number}
                </span>
                <span>
                  <span className="block text-sm font-semibold">{t(step.title)}</span>
                  <span className="block text-xs text-muted">{t(step.hint)}</span>
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

  if (stage.kind === 'sent') return <Sent email={stage.email} onBack={() => onStage({ kind: 'sign-in' })} />;
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
      className="flex min-h-[540px] flex-col rounded-[14px] border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(28,25,23,0.25)]"
    >
      <div className="flex-1 px-7 pt-8 pb-6">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">{title}</h1>
        {lead === undefined ? null : <p className="mt-2 text-[15px] text-muted">{lead}</p>}
        <div className="mt-6 max-w-[420px] space-y-4">{children}</div>
      </div>
      <div className="flex items-center justify-end gap-4 border-t border-line px-7 py-4">
        <span className="text-sm text-muted">{t('Step {step} of {total}', { step, total: 4 })}</span>
        {action}
      </div>
    </form>
  );
}

/** What a refused sign-in link means for the person, and what to do. */
const SEND_PROBLEMS: Record<string, string> = {
  'invalid-email': msg('That is not an e-mail address. Check it and send again.'),
  'too-many-links': msg('Several links went to this address already. Use the last one, or wait fifteen minutes.'),
};

/** What the worker says when a sign-in with a provider comes back without a session (FRU-97, FRU-135). */
const PROVIDER_PROBLEMS: Record<string, string> = {
  'google-declined': msg('Google did not sign you in: the access was declined. Try again, or use an email link.'),
  'google-unverified': msg('Google has no verified address for this account. Use an email link.'),
  'google-failed': msg('The sign-in with Google did not finish. Try again, or use an email link.'),
  'github-declined': msg('GitHub did not sign you in: the access was declined. Try again, or use an email link.'),
  'github-unverified': msg(
    'GitHub has no verified primary address for this account. Verify it on GitHub, or use an email link.',
  ),
  'github-failed': msg('The sign-in with GitHub did not finish. Try again, or use an email link.'),
};

function SignIn({ onSent }: { onSent: (email: string) => void }) {
  useLocale();
  const [search] = useSearchParams();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(PROVIDER_PROBLEMS[search.get('error') ?? '']);
  const [providers, setProviders] = useState(PROVIDERS_AT_FIRST);

  useEffect(() => {
    let asked = true;
    void signInProviders().then((has) => {
      // A worker that does not answer keeps what the build said: no button is taken away by an outage.
      if (asked) setProviders((before) => ({ github: before.github || has.github, google: has.google }));
    });

    return () => {
      asked = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    if (name.trim() !== '') rememberWorkspaceName(name.trim());
    const sent = await requestLink(email, locale());
    setBusy(false);
    if (sent.ok) return onSent(email.trim());

    setProblem(SEND_PROBLEMS[sent.error] ?? msg('The link could not be sent just now. Try again in a minute.'));
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
        <WideButton onClick={() => (window.location.href = `${API}/auth/google`)}>
          {t('Continue with Google')}
        </WideButton>
      ) : (
        <WideButton disabled note={t('Google sign-in is not set up on this Fruitback')}>
          {t('Continue with Google')}
        </WideButton>
      )}
      {providers.github ? (
        <WideButton onClick={() => (window.location.href = `${API}/auth/github`)}>
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

function Sent({ email, onBack }: { email: string; onBack: () => void }) {
  useLocale();
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
    setProblem(msg('A workspace needs a name of one line, up to 80 characters.'));
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

const SOURCES = [
  {
    key: 'fruitback',
    name: 'Fruitback',
    detail: msg('Notes stay in this workspace. Nothing to connect.'),
    ready: true,
  },
  { key: 'linear', name: 'Linear', detail: msg('An issue per note, in the team you choose.'), ready: false },
  { key: 'github', name: 'GitHub Issues', detail: msg('An issue per note, in one repository.'), ready: false },
] as const;

function Source({ onNext }: { onNext: () => void }) {
  useLocale();
  return (
    <Frame
      step={2}
      title={t('Where should feedback go?')}
      lead={t('Connect a source once. Every site of the workspace can then send its feedback there.')}
      action={<Button onClick={onNext}>{t('Continue')}</Button>}
    >
      <div role="radiogroup" aria-label={t('Source')} className="space-y-2">
        {SOURCES.map((source) => (
          <div
            key={source.key}
            role="radio"
            aria-checked={source.ready}
            aria-disabled={!source.ready}
            className={`flex items-center gap-3 rounded-[10px] border px-4 py-3 ${
              source.ready ? 'border-ink' : 'border-line text-muted'
            }`}
          >
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-chip text-xs font-bold text-ink">
              {source.name.charAt(0)}
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-ink">{source.name}</span>
              <span className="block text-xs">{t(source.detail)}</span>
            </span>
            <span className="text-xs font-semibold">{source.ready ? t('Selected') : t('After the beta')}</span>
          </div>
        ))}
      </div>
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
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url, visibility });
    if (added.ok) return onAdded(added.data);
    setProblem(msg('Paste the full address of the site, starting with https://.'));
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
        type="url"
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

export function InstallOptions({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | undefined>();
  const snippet = snippetFor(site);

  async function connect() {
    // Open the tab in the click, before the await: a browser blocks a window opened after one.
    // The tab loses its `opener` before it loads the pairing page.
    const tab = window.open('', '_blank');
    const minted = await call<{ code: string }>('POST', `/console/workspaces/${workspace.id}/connect`, {});
    if (!minted.ok) {
      tab?.close();
      return;
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
          onClick={() =>
            void navigator.clipboard.writeText(snippet).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? t('Copied') : t('Copy the script')}
        </Button>
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
