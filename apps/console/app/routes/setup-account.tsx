import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Account, type Workspace, renameWorkspace } from '../api';
import { msg, t } from '../i18n';
import { NAME_PROBLEMS, problemOf } from '../problems';
import { type Made, manages } from '../setup-stage';
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
import { Button, Callout, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { workspaceNameFrom } from '../workspace-name';

/** Step 1 of the setup, « Your account » (FRU-239): each of its states, as `setup.tsx` shows them. */

type AskProps = { email: string; onEmail: (email: string) => void; onSent: (email: string) => void };

/** Step 1, to do: the address a link goes to, or a provider. */
export function Ask({ email, onEmail, onSent }: AskProps) {
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
export function Sent({ email, onBack, onSignedIn }: { email: string; onBack: () => void; onSignedIn: () => void }) {
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
 * The workspace of a person who signed in, made again by hand. A try was made for them already, so
 * the form opens on what the worker answered to it (`tried`), and the button says « Try again ».
 */
export function Unnamed({
  account,
  tried,
  make,
  onCreated,
}: {
  account: Account;
  tried: string;
  /** Makes the workspace with this name: `firstWorkspace`, under its lock. */
  make: (name: string) => Promise<Made>;
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
    const made = await make(name);
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
export function Account({
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
