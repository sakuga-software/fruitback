import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  API,
  type Me,
  type Site,
  type Visibility,
  type Workspace,
  call,
  pairingLink,
  rememberWorkspaceName,
  requestLink,
  takeWorkspaceName,
} from '../api';
import { Button, Field, Mark, Problem, WideButton } from '../ui';

/**
 * « Create your workspace », the four steps of the setup (design/boards/2-onboarding.png).
 *
 * The steps are the design's. What this beta has not built yet is shown and disabled, with the reason
 * in words: Google sign-in, and the sources other than the workspace's own (FRU-102).
 */

const STEPS = [
  { title: 'Workspace', hint: 'Sign in, name it' },
  { title: 'Source', hint: 'Where feedback goes' },
  { title: 'Site', hint: 'The address you review' },
  { title: 'Install', hint: 'Script or extension' },
] as const;

const DOCS = 'https://fruitback.com';

/** On when the worker this console calls has a GitHub OAuth app (FRU-97). */
const GITHUB = import.meta.env.VITE_FRUITBACK_GITHUB === '1';

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

  const workspace = me.data.workspaces[0];
  if (workspace !== undefined) return step === 'site' ? { kind: 'site', workspace } : { kind: 'source', workspace };

  // The name typed before the link was sent: the workspace is made without asking again.
  const pending = takeWorkspaceName();
  if (pending === undefined) return { kind: 'name' };
  const created = await call<Workspace>('POST', '/console/workspaces', { name: pending });

  return created.ok ? { kind: 'source', workspace: created.data } : { kind: 'name' };
}

export default function Setup() {
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
            <span className="text-[15px] font-semibold">Fruitback</span>
            <span className="ml-3 text-[15px] text-muted">Set up</span>
          </div>
          <nav aria-label="How to run Fruitback" className="flex rounded-lg bg-chip p-1 text-sm font-semibold">
            <span aria-current="page" className="rounded-md bg-surface px-3.5 py-1.5 text-ink shadow-sm">
              Fruitback Cloud
            </span>
            <a href={`${DOCS}/self-hosting.html`} className="rounded-md px-3.5 py-1.5 text-muted hover:text-ink">
              Self-hosted
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1080px] gap-8 px-4 py-10 md:grid-cols-[220px_1fr]">
        <ol className="space-y-1.5" aria-label="Steps">
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
                  <span className="block text-sm font-semibold">{step.title}</span>
                  <span className="block text-xs text-muted">{step.hint}</span>
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
  if (stage.kind === 'loading') return <Frame step={1} title="Create your workspace" />;
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
        <span className="text-sm text-muted">Step {step} of 4</span>
        {action}
      </div>
    </form>
  );
}

/** What a refused sign-in link means for the person, and what to do. */
const SEND_PROBLEMS: Record<string, string> = {
  'invalid-email': 'That is not an e-mail address. Check it and send again.',
  'too-many-links': 'Several links went to this address already. Use the last one, or wait fifteen minutes.',
};

function SignIn({ onSent }: { onSent: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    if (name.trim() !== '') rememberWorkspaceName(name.trim());
    const sent = await requestLink(email, navigator.language);
    setBusy(false);
    if (sent.ok) return onSent(email.trim());

    setProblem(SEND_PROBLEMS[sent.error] ?? 'The link could not be sent just now. Try again in a minute.');
  }

  return (
    <Frame
      step={1}
      title="Create your workspace"
      lead="One workspace for your team, your sites and your sources. Hosted in Europe."
      onSubmit={submit}
      action={
        <Button type="submit" disabled={busy || email.trim() === ''}>
          {busy ? 'Sending…' : 'Continue'}
        </Button>
      }
    >
      <WideButton disabled title="Google sign-in comes after the beta">
        Continue with Google
      </WideButton>
      {GITHUB ? (
        <WideButton onClick={() => (window.location.href = `${API}/auth/github`)}>Continue with GitHub</WideButton>
      ) : (
        <WideButton disabled title="GitHub sign-in arrives with its OAuth app">
          Continue with GitHub
        </WideButton>
      )}
      <div className="flex items-center gap-3 py-1 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        or with an email link
        <span className="h-px flex-1 bg-line" />
      </div>
      <Field
        label="Work email"
        type="email"
        autoComplete="email"
        placeholder="you@studio.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <Field
        label="Workspace name"
        placeholder="Sakuga"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </Frame>
  );
}

function Sent({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <Frame
      step={1}
      title="Check your inbox"
      lead={`A sign-in link is on its way to ${email}. It works once, for fifteen minutes.`}
      action={
        <Button tone="outline" onClick={onBack}>
          Use another address
        </Button>
      }
    >
      <p className="text-sm text-muted">
        Open it in this browser. Nothing in it asks for a password, and ignoring it is safe.
      </p>
    </Frame>
  );
}

function NameIt({ onCreated }: { onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await call<Workspace>('POST', '/console/workspaces', { name });
    if (created.ok) return onCreated(created.data);
    setProblem('A workspace needs a name of one line, up to 80 characters.');
  }

  return (
    <Frame
      step={1}
      title="Name your workspace"
      lead="You are signed in. One more word, and the workspace exists."
      onSubmit={submit}
      action={
        <Button type="submit" disabled={name.trim() === ''}>
          Continue
        </Button>
      }
    >
      <Field
        label="Workspace name"
        placeholder="Sakuga"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </Frame>
  );
}

const SOURCES = [
  { key: 'fruitback', name: 'Fruitback', detail: 'Notes stay in this workspace. Nothing to connect.', ready: true },
  { key: 'linear', name: 'Linear', detail: 'An issue per note, in the team you choose.', ready: false },
  { key: 'github', name: 'GitHub Issues', detail: 'An issue per note, in one repository.', ready: false },
] as const;

function Source({ onNext }: { onNext: () => void }) {
  return (
    <Frame
      step={2}
      title="Where should feedback go?"
      lead="Connect a source once. Every site of the workspace can then send its feedback there."
      action={<Button onClick={onNext}>Continue</Button>}
    >
      <div role="radiogroup" aria-label="Source" className="space-y-2">
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
              <span className="block text-xs">{source.detail}</span>
            </span>
            <span className="text-xs font-semibold">{source.ready ? 'Selected' : 'After the beta'}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function SiteStep({ workspace, onAdded }: { workspace: Workspace; onAdded: (site: Site) => void }) {
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('members');
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url, visibility });
    if (added.ok) return onAdded(added.data);
    setProblem('Paste the full address of the site, starting with https://.');
  }

  return (
    <Frame
      step={3}
      title="Which site do you review?"
      lead="Paste its address. Any page of it will do."
      onSubmit={submit}
      action={
        <Button type="submit" disabled={url.trim() === ''}>
          Continue
        </Button>
      }
    >
      <Field
        label="Site address"
        type="url"
        placeholder="https://staging.acme.dev"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <fieldset>
        <legend className="mb-1.5 text-xs text-muted">Who sees the feedback?</legend>
        {(
          [
            ['members', `The members of ${workspace.name}`, 'Visitors of the site see no note.'],
            ['everyone', 'Everyone who visits the site', 'For a public « report a problem ».'],
          ] as const
        ).map(([value, label, detail]) => (
          <label
            key={value}
            className="mb-2 flex cursor-pointer items-start gap-3 rounded-[10px] border border-line px-4 py-3 has-[:checked]:border-ink"
          >
            <input
              type="radio"
              name="visibility"
              value={value}
              checked={visibility === value}
              onChange={() => setVisibility(value)}
              className="mt-1 accent-[#dd2c27]"
            />
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-muted">{detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
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
  const navigate = useNavigate();

  return (
    <Frame
      step={4}
      title="Install it"
      lead={`Two ways to put Fruitback on ${new URL(site.origin).host}. Use one, or both.`}
      action={<Button onClick={() => navigate(`/w/${workspace.id}/sites`)}>Finish</Button>}
    >
      <InstallOptions workspace={workspace} site={site} />
    </Frame>
  );
}

export function InstallOptions({ workspace, site }: { workspace: Workspace; site: Site }) {
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | undefined>();
  const snippet = snippetFor(site);

  async function connect() {
    const minted = await call<{ code: string }>('POST', `/console/workspaces/${workspace.id}/connect`, {});
    if (!minted.ok) return;
    const target = pairingLink(minted.data.code);
    setLink(target);
    window.open(target, '_blank', 'noopener');
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">Script</h2>
        <p className="mb-2 text-xs text-muted">Paste it before the closing body tag of the site.</p>
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
          {copied ? 'Copied' : 'Copy the script'}
        </Button>
      </div>
      <div>
        <h2 className="text-sm font-semibold">Extension</h2>
        <p className="mb-2 text-xs text-muted">
          Nothing to change on the site. Connect this browser, then click the Fruitback icon on the page that opens.
        </p>
        <Button tone="outline" onClick={() => void connect()}>
          Connect this browser
        </Button>
        {link === undefined ? null : (
          <p className="mt-2 text-xs text-muted">
            A page opened in a new tab. If it did not, open{' '}
            <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
              this link
            </a>
            : it works once, for fifteen minutes.
          </p>
        )}
      </div>
    </div>
  );
}
