import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  type Account,
  type Me,
  type Site,
  type Visibility,
  type Workspace,
  call,
  myInvitations,
  renameWorkspace,
  saveLanguage,
} from '../api';
import { adoptLanguage, msg, t } from '../i18n';
import { InstallOptions } from '../install-options';
import { NAME_PROBLEMS, SITE_NOT_ADDED, SITE_PROBLEMS, WORKSPACE_NOT_CREATED, problemOf } from '../problems';
import {
  AnotherAddress,
  EmailForm,
  ProviderButtons,
  SignInClosed,
  providerProblem,
  useCarryOn,
  useSendAgain,
  useSignInWays,
  withStrong,
} from '../sign-in-form';
import { siteAddress } from '../site-address';
import {
  BrowserFrame,
  Button,
  Callout,
  EntryPage,
  Field,
  Lead,
  LinkButton,
  Pick,
  Problem,
  Step,
  type StepState,
  Steps,
  Title,
} from '../ui';
import { useLocale } from '../use-locale';
import { workspaceNameFrom } from '../workspace-name';

/**
 * The setup, on one screen (FRU-239, screen 01 of the mockup of 2026-10-13): « Your account »,
 * « Your site », « Put it on the site ». The three steps show together; one that is done is a
 * summary, and opens again.
 *
 * Nobody names a workspace here: it takes its name from the address of the person
 * (`workspace-name.ts`), and « Rename » changes it. The choice of a tracker is not a step any more:
 * it is in Connectors, after.
 */

// `InstallOptions` moved to its own module. The Sites screen still reads it from here.
export { InstallOptions };

const SITE = 'https://fruitback.com';

type Stage =
  | { kind: 'loading' }
  | { kind: 'email' }
  | { kind: 'sent'; email: string }
  /**
   * Signed in, and the workspace could not be made: the person tries again, with the name they like.
   * `problem`: what the worker said of the try that was made for them.
   */
  | { kind: 'unnamed'; account: Account; problem: string }
  /** The sites of the workspace could not be read. That is not « no site »: nothing is asked again. */
  | { kind: 'unread'; account: Account; workspace: Workspace }
  /** `replaces`: the site that « Change » opened again, with its values in the form. */
  | { kind: 'site'; account: Account; workspace: Workspace; replaces?: Added }
  | ({ kind: 'install'; account: Account; workspace: Workspace } & Added)
  /** An invitation waits for this person: they came to join a workspace, not to make one. */
  | { kind: 'invited' }
  /**
   * Signed in, with no workspace, and the invitations could not be read: none is made until they
   * are, as this person may have come to join one.
   */
  | { kind: 'unchecked'; account: Account }
  /**
   * A member or a guest of a workspace with no site: only an owner or an admin adds one. The Sites
   * screen says so, as the front door sends them there too.
   */
  | { kind: 'waiting'; workspace: Workspace };

/**
 * The site of the setup. `fresh`: it was added in this visit, so nothing was noted on it yet.
 * `left`: a site that « Change » replaced and did not remove, which the Sites screen still lists.
 */
type Added = { site: Site; fresh?: boolean; left?: Site };

/** The state of a step whose step before is in `before`: the one to do now, or one to come. */
function stepAfter(before: StepState): StepState {
  return before === 'done' ? 'current' : 'pending';
}

/** Who changes the name of a workspace and adds a site: `can` of the worker says the same. */
function manages(workspace: Workspace): boolean {
  return workspace.role === 'owner' || workspace.role === 'admin';
}

/**
 * The first workspace of a person, named after their address.
 *
 * WARNING: one at a time, in every tab of the browser. The tab that waited for the link and the tab
 * of the link can both arrive here in the same second, and each would make a workspace. The lock is
 * of the browser (`navigator.locks`); the tab that gets it second reads `/console/me` again and
 * finds the workspace of the first.
 */
async function firstWorkspace(account: Account, name?: string): Promise<Made> {
  const make = async (): Promise<Made> => {
    const again = await call<Me>('GET', '/console/me', undefined, { quiet: true });
    const made = again.ok ? again.data.workspaces[0] : undefined;
    if (made !== undefined) return { workspace: made };
    const created = await call<Workspace>('POST', '/console/workspaces', {
      name: name ?? workspaceNameFrom(account.email),
    });

    return created.ok
      ? { workspace: created.data }
      : { problem: problemOf(created, NAME_PROBLEMS, WORKSPACE_NOT_CREATED) };
  };
  // No lock outside a secure context (`http` on a host other than localhost): two tabs can then each
  // make one. docs/decisions/console.md says so.
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return make();

  return navigator.locks.request('fruitback:first-workspace', make);
}

type Made = { workspace: Workspace; problem?: undefined } | { workspace?: undefined; problem: string };

let resolving: Promise<Stage> | undefined;

/**
 * WARNING: one resolution at a time in this tab. It can make the first workspace, and two
 * resolutions in flight would ask for it twice.
 */
function resolveOnce(): Promise<Stage> {
  resolving ??= resolveStage().finally(() => {
    resolving = undefined;
  });

  return resolving;
}

/** Where the setup of this person is: read from the worker at each visit, so it resumes anywhere. */
async function resolveStage(): Promise<Stage> {
  // Quiet: a person who is not signed in gets the first step, not the notice of a session that ended.
  const me = await call<Me>('GET', '/console/me', undefined, { quiet: true });
  if (!me.ok) return { kind: 'email' };
  adoptLanguage(me.data.account, saveLanguage);
  const { account } = me.data;

  let workspace = me.data.workspaces[0];
  if (workspace === undefined) {
    // Somebody who was invited joins a workspace: none is made for them behind their back.
    // A worker with no invitations at all answers 404: nobody can have been invited there.
    const invitations = await myInvitations();
    if (!invitations.ok && invitations.status !== 404) return { kind: 'unchecked', account };
    if (invitations.ok && invitations.data.length > 0) return { kind: 'invited' };
    const made = await firstWorkspace(account);
    if (made.workspace === undefined) return { kind: 'unnamed', account, problem: made.problem };
    workspace = made.workspace;
  }

  return siteStage(account, workspace);
}

/** The step of a person who has a workspace: its first site, or the form that adds one. */
async function siteStage(account: Account, workspace: Workspace): Promise<Stage> {
  const listed = await call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`);
  if (!listed.ok) return { kind: 'unread', account, workspace };
  const site = listed.data.sites[0];
  if (site !== undefined) return { kind: 'install', account, workspace, site };

  return manages(workspace) ? { kind: 'site', account, workspace } : { kind: 'waiting', workspace };
}

export default function Setup() {
  useLocale();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Kept above the stages: « Use another address » gives the form back with the address in it.
  const [email, setEmail] = useState('');

  useEffect(() => {
    let live = true;
    void resolveOnce().then((resolved) => {
      if (live) setStage(resolved);
    });

    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (stage.kind === 'invited') void navigate('/invitations', { replace: true });
    if (stage.kind === 'waiting') void navigate(`/w/${stage.workspace.id}/sites`, { replace: true });
  }, [stage, navigate]);

  // The title of the tab, as the mockup names it. The cleanup gives back the name of the product.
  useEffect(() => {
    const before = document.title;
    document.title = t('Set up Fruitback');

    return () => {
      document.title = before;
    };
  });

  const account = 'account' in stage ? stage.account : undefined;
  const workspace = 'workspace' in stage ? stage.workspace : undefined;
  // The first step is to do until somebody is signed in and has a workspace; the last one is the
  // current one once a site is there.
  const signedIn = account !== undefined && stage.kind !== 'unnamed';
  const installing = stage.kind === 'install';
  const first: StepState = signedIn ? 'done' : 'current';
  const second: StepState = installing ? 'done' : stepAfter(first);
  const third: StepState = installing ? 'current' : 'pending';
  const prefix = t('Current step:');

  return (
    <EntryPage
      width="full"
      aside={
        <p>
          {t('Running your own server?')}{' '}
          <a
            href={`${SITE}/self-hosting.html`}
            className="text-ink underline decoration-1 underline-offset-3 hover:text-accent-strong"
          >
            {t('Self-hosting guide')}
          </a>
        </p>
      }
    >
      <section aria-labelledby="setup-title" className="max-w-135 min-w-0 flex-1 basis-100">
        <div id="setup-title" className="mb-2">
          <Title size="setup">{t('Set up Fruitback')}</Title>
        </div>
        <Lead className="mb-9">{t('Three steps to your first note on a live page. Hosted in Europe.')}</Lead>

        <Steps>
          <Step state={first} number={1} title={t('Your account')} currentPrefix={prefix}>
            {stage.kind === 'loading' ? <p aria-busy="true" /> : null}
            {stage.kind === 'email' ? (
              <Ask email={email} onEmail={setEmail} onSent={(sent) => setStage({ kind: 'sent', email: sent })} />
            ) : null}
            {stage.kind === 'sent' ? (
              <Sent
                email={stage.email}
                onBack={() => setStage({ kind: 'email' })}
                // Signed in from another tab: the same resolution as a visit.
                onSignedIn={() => void resolveOnce().then(setStage)}
              />
            ) : null}
            {stage.kind === 'unchecked' ? (
              <div className="mt-3 flex flex-col items-start gap-3">
                <p role="alert" className="text-body text-muted">
                  {t('Fruitback did not answer. Try again.')}
                </p>
                <Button tone="outline" onClick={() => void resolveOnce().then(setStage)}>
                  {t('Try again')}
                </Button>
              </div>
            ) : null}
            {stage.kind === 'unnamed' ? (
              <Unnamed
                account={stage.account}
                tried={stage.problem}
                onCreated={(made) => void siteStage(stage.account, made).then(setStage)}
              />
            ) : null}
            {account !== undefined && workspace !== undefined ? (
              <Account
                account={account}
                workspace={workspace}
                onRenamed={(renamed) => setStage((now) => ('workspace' in now ? { ...now, workspace: renamed } : now))}
              />
            ) : null}
          </Step>

          <Step state={second} number={2} title={t('Your site')} currentPrefix={prefix}>
            {second === 'pending' ? (
              <p className="mt-0.5 text-small text-muted">{t('The address you review.')}</p>
            ) : null}
            {stage.kind === 'unread' ? (
              <div className="mt-3 flex flex-col items-start gap-3">
                <p role="alert" className="text-body text-muted">
                  {t('Fruitback did not answer. Your sites are not lost.')}
                </p>
                <Button tone="outline" onClick={() => void siteStage(stage.account, stage.workspace).then(setStage)}>
                  {t('Try again')}
                </Button>
              </div>
            ) : null}
            {stage.kind === 'site' ? (
              <SiteForm
                workspace={stage.workspace}
                replaces={stage.replaces}
                onDone={(added) =>
                  setStage({ kind: 'install', account: stage.account, workspace: stage.workspace, ...added })
                }
              />
            ) : null}
            {stage.kind === 'install' ? (
              <SiteSummary
                workspace={stage.workspace}
                site={stage.site}
                left={stage.left}
                onChange={() =>
                  setStage({
                    kind: 'site',
                    account: stage.account,
                    workspace: stage.workspace,
                    replaces: { site: stage.site, ...(stage.fresh === true ? { fresh: true } : {}) },
                  })
                }
              />
            ) : null}
          </Step>

          <Step state={third} number={3} title={t('Put it on the site')} currentPrefix={prefix}>
            {stage.kind === 'install' ? (
              // No `items-start` here: the script would take the width of its longest line, and the page
              // would scroll sideways. It scrolls in its own box.
              <div className="mt-3 flex min-w-0 flex-col gap-5">
                <InstallOptions workspace={stage.workspace} site={stage.site} />
                <div>
                  <Button to={`/w/${stage.workspace.id}/sites`}>{t('Finish')}</Button>
                </div>
              </div>
            ) : (
              <p className="mt-0.5 text-small text-muted">{t('The extension, or a script tag.')}</p>
            )}
          </Step>
        </Steps>
      </section>

      <section aria-label={t('Preview of your site')} className="min-w-0 flex-999 basis-130">
        <BrowserFrame
          address={stage.kind === 'install' ? new URL(stage.site.origin).host : t('your site')}
          // Once the site is added the sentence would be false, and the picture of it comes with the
          // last step (FRU-242): the frame stays, with its drop.
          empty={stage.kind === 'install' ? '' : t('Your site shows here once you add it, with its pins.')}
          caption={t('A preview of your site. Pins show the same way on the real page.')}
        />
      </section>
    </EntryPage>
  );
}

type AskProps = { email: string; onEmail: (email: string) => void; onSent: (email: string) => void };

/** Step 1, to do: the address a link goes to, or a provider. */
function Ask({ email, onEmail, onSent }: AskProps) {
  useLocale();
  const [search] = useSearchParams();
  const { providers, closed } = useSignInWays();

  return (
    <div className="mt-3 flex flex-col gap-4">
      <p className="text-body text-muted">{t('We send you a sign-in link. No password to make up.')}</p>
      {closed ? (
        <SignInClosed />
      ) : (
        <>
          <EmailForm
            action={msg('Email me a link')}
            email={email}
            onEmail={onEmail}
            onSent={onSent}
            problem={providerProblem(search.get('error'))}
            layout="row"
          />
          <p className="text-hint text-muted">
            {t('Your workspace takes the name of your domain. Rename it whenever you like.')}
          </p>
          <ProviderButtons providers={providers} layout="grid" />
        </>
      )}
    </div>
  );
}

/** Step 1, the link is on its way: this page goes on by itself when it is opened (FRU-235). */
function Sent({ email, onBack, onSignedIn }: { email: string; onBack: () => void; onSignedIn: () => void }) {
  useLocale();
  useCarryOn(onSignedIn);
  const again = useSendAgain(email);

  return (
    <Callout status className="mt-3">
      <p className="text-body leading-auto font-semibold">{t('Check your inbox')}</p>
      <p className="text-body">
        {withStrong(
          msg('A sign-in link is on its way to {email}. Open it in this browser: this page carries on by itself.'),
          'email',
          email,
        )}
      </p>
      <p className="text-hint text-muted">
        {t('The link works once, for fifteen minutes. Nothing in it asks for a password.')}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Button tone="outline" disabled={again.disabled} onClick={again.send}>
          {again.label}
        </Button>
        <AnotherAddress space="normal" onBack={onBack} />
      </div>
      {again.problem === undefined ? null : <Problem>{t(again.problem)}</Problem>}
    </Callout>
  );
}

/**
 * Signed in, and the worker did not make the workspace: the name it would have taken is in a field,
 * and the person sends it again, as it is or changed.
 */
/**
 * The workspace of a person who signed in, made again by hand. A try was made for them already, so
 * the form opens on what the worker answered to it (`tried`), and the button says « Try again ».
 */
function Unnamed({
  account,
  tried,
  onCreated,
}: {
  account: Account;
  tried: string;
  onCreated: (workspace: Workspace) => void;
}) {
  useLocale();
  const [name, setName] = useState(workspaceNameFrom(account.email));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(tried);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const made = await firstWorkspace(account, name);
    setBusy(false);
    if (made.workspace !== undefined) return onCreated(made.workspace);
    setProblem(made.problem);
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-4">
      <p className="text-body text-muted">{withStrong(msg('Signed in as {email}'), 'email', account.email)}</p>
      <Field
        label={t('Workspace name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div>
        <Button type="submit" disabled={busy}>
          {t('Try again')}
        </Button>
      </div>
    </form>
  );
}

const WORKSPACE_NOT_RENAMED = msg('The workspace was not renamed. Try again.');
/** What the worker refuses when a workspace is renamed: the rule of its name, and who may. */
const RENAME_PROBLEMS: Readonly<Record<string, string>> = {
  ...NAME_PROBLEMS,
  forbidden: msg('Only an owner or an admin of the workspace renames it.'),
};

/** Step 1, done: who is signed in, and the workspace, which « Rename » renames in place. */
function Account({
  account,
  workspace,
  onRenamed,
}: {
  account: Account;
  workspace: Workspace;
  onRenamed: (workspace: Workspace) => void;
}) {
  useLocale();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // Set once the form closed: « Rename » then takes focus again, where the keyboard left it.
  const [back, setBack] = useState(false);

  function close() {
    setRenaming(false);
    setProblem(undefined);
    setBack(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === workspace.name) return close();
    setBusy(true);
    setProblem(undefined);
    const renamed = await renameWorkspace(workspace, name);
    setBusy(false);
    // A refusal keeps the form open, with the name as it was typed.
    if (!renamed.ok) return setProblem(problemOf(renamed, RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED));
    onRenamed(renamed.data);
    close();
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1 text-body">
      <p className="text-muted wrap-anywhere">
        {withStrong(msg('Signed in as {email}'), 'email', account.email, 'text-ink')}
      </p>
      {renaming ? (
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            setName(workspace.name);
            close();
          }}
          className="mt-2 flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2.5">
            <div className="min-w-0 flex-1 basis-60">
              <Field
                label={t('Workspace name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus
              />
            </div>
            <Button type="submit" disabled={busy}>
              {t('Save')}
            </Button>
            <LinkButton
              space="loose"
              onClick={() => {
                setName(workspace.name);
                close();
              }}
            >
              {t('Cancel')}
            </LinkButton>
          </div>
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        </form>
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted">
          {withStrong(msg('Workspace {name}'), 'name', workspace.name, 'text-ink')}
          {manages(workspace) ? (
            <LinkButton space="flush" autoFocus={back} onClick={() => setRenaming(true)}>
              {t('Rename')}
            </LinkButton>
          ) : null}
        </p>
      )}
    </div>
  );
}

type SiteFormProps = {
  workspace: Workspace;
  /** The site this form changes: its values are in the form, and « Cancel » keeps it. */
  replaces?: Added | undefined;
  onDone: (added: Added) => void;
};

/**
 * Step 2: the address of the site, and who sees its notes.
 *
 * WARNING: the worker has no route that changes a site, and a site that is removed takes its notes
 * with it. So « Change » adds the site again with the new values, and removes the one it replaces
 * only when that one was added in this visit: nothing was noted on it yet. A site of a visit before
 * stays, the summary says so, and the Sites screen removes it with its two presses (FRU-165).
 */
function SiteForm({ workspace, replaces, onDone }: SiteFormProps) {
  useLocale();
  const before = replaces?.site;
  const [url, setUrl] = useState(before === undefined ? '' : new URL(before.origin).host);
  const [visibility, setVisibility] = useState<Visibility>(before?.visibility ?? 'members');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // The same reading as the Sites screen: a host with no scheme is https (FRU-167).
    const address = siteAddress(url);
    if (address === undefined) return setProblem(SITE_PROBLEMS['invalid-url'] ?? SITE_NOT_ADDED);
    // Nothing changed: the site stays as it is, and nothing is asked of the worker.
    if (replaces !== undefined && new URL(address).origin === before?.origin && visibility === before.visibility) {
      return onDone(replaces);
    }
    setBusy(true);
    const base = `/console/workspaces/${workspace.id}/sites`;
    const added = await call<Site>('POST', base, { url: address, visibility });
    if (!added.ok) {
      setBusy(false);

      // No failure clears the field: the address stays as it was typed.
      return setProblem(problemOf(added, SITE_PROBLEMS, SITE_NOT_ADDED));
    }
    const removed =
      before !== undefined && replaces?.fresh === true && (await call('DELETE', `${base}/${before.id}`)).ok;
    setBusy(false);
    onDone({ site: added.data, fresh: true, ...(before === undefined || removed ? {} : { left: before }) });
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-5">
      <Field
        label={t('Site address')}
        inputMode="url"
        autoComplete="url"
        placeholder="staging.acme.dev"
        // A pattern such as *.preview.acme.dev is not said here: a preview is covered by a domain
        // that is proven (FRU-103), and the worker takes no pattern as an address.
        hint={t('Any page of it will do.')}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Pick
        label={t('Who sees the notes?')}
        value={visibility}
        onChange={setVisibility}
        options={[
          {
            value: 'members',
            label: t('Members of {workspace}', { workspace: workspace.name }),
            detail: t("Visitors of the site see nothing. Right for staging and for a client's site."),
          },
          {
            value: 'everyone',
            label: t('Everyone who visits'),
            detail: t('A public way to report a problem on a live site.'),
          },
        ]}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Button type="submit" disabled={busy}>
          {replaces === undefined ? t('Add site') : t('Save')}
        </Button>
        {replaces === undefined ? null : (
          <LinkButton space="loose" onClick={() => onDone(replaces)}>
            {t('Cancel')}
          </LinkButton>
        )}
      </div>
    </form>
  );
}

/** Step 2, done: the site, who sees its notes, and « Change ». */
function SiteSummary({
  workspace,
  site,
  left,
  onChange,
}: {
  workspace: Workspace;
  site: Site;
  left: Site | undefined;
  onChange: () => void;
}) {
  useLocale();

  return (
    <div className="mt-1.5 flex flex-col gap-1 text-body">
      {/* A long host takes the lines it needs: the page does not scroll sideways (FRU-159). */}
      <p className="font-semibold wrap-anywhere">{new URL(site.origin).host}</p>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted">
        {site.visibility === 'members'
          ? t('Members of {workspace} see the notes', { workspace: workspace.name })
          : t('Everyone who visits sees the notes')}
        {manages(workspace) ? (
          <LinkButton space="flush" onClick={onChange}>
            {t('Change')}
          </LinkButton>
        ) : null}
      </p>
      {left === undefined ? null : (
        <p role="status" className="text-hint text-muted">
          {t('{site} is still in your sites, with its notes. Remove it in Sites if you no longer review it.', {
            site: new URL(left.origin).host,
          })}
        </p>
      )}
    </div>
  );
}
