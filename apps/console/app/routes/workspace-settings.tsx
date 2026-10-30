import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { LOGO_TYPES, type Workspace, call, removeWorkspaceLogo, renameWorkspace, setWorkspaceLogo } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { manages } from '../setup-stage';
import { Button, Field, FilePick, Problem, SubNav } from '../ui';
import { useLocale } from '../use-locale';
import { LOGO_NOT_REMOVED, LOGO_NOT_SAVED, LOGO_PROBLEMS, logoRefusal } from '../workspace-logo';
import { RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED } from './setup-account';
import { PageHead, WorkspaceMark, useWorkspace } from './workspace';

/**
 * The settings of a workspace (FRU-414): « Settings » in the rail for an owner or an admin (FRU-503),
 * and the name of the workspace at the top of the rail for every role. No board draws it: it is the
 * kit, as « My account » lays it out.
 *
 * It holds what the worker lets a workspace change today, for an owner or an admin: its name
 * (FRU-236) and its logo (FRU-428). Every member reads both. The owner deletes the workspace at the
 * end (FRU-503). What an agent needs is on the page « AI » of the settings (FRU-544,
 * `workspace-settings-ai.tsx`), the second link of `SettingsNav`.
 */
/** The pages of the settings (FRU-544): « General », here, and « AI », what an agent needs. */
export function SettingsNav({ workspace, current }: { workspace: Workspace; current: 'general' | 'ai' }) {
  useLocale();
  const base = `/w/${workspace.id}/settings`;

  return (
    <SubNav
      // Not « Workspace settings »: a name that holds « Workspace », the name of the rail, would be
      // found by a search of that name too.
      label={t('Pages of the settings')}
      entries={[
        { to: base, label: t('General'), current: current === 'general' },
        { to: `${base}/ai`, label: t('AI'), current: current === 'ai' },
      ]}
    />
  );
}

export default function WorkspaceSettings() {
  const { workspace } = useWorkspace();

  // A move to the settings of another workspace mounts the form again: nothing typed for one
  // workspace is saved as the name of another.
  return <Settings key={workspace.id} />;
}

function Settings() {
  useLocale();
  const { workspace, renamed } = useWorkspace();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [kept, setKept] = useState(false);
  const may = manages(workspace);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    setKept(false);
    if (name.trim() === workspace.name) return setKept(true);
    setBusy(true);
    const answer = await renameWorkspace(workspace, name);
    setBusy(false);
    // A refusal keeps the name as it was typed.
    if (!answer.ok) return setProblem(problemOf(answer, RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED));
    setName(answer.data.name);
    setKept(true);
    renamed(answer.data);
  }

  return (
    <>
      <PageHead
        title={t('Workspace settings')}
        lead={t('Settings that every member of {name} sees.', { name: workspace.name })}
      />
      <SettingsNav workspace={workspace} current="general" />
      <section aria-labelledby="workspace-name-title" className="flex max-w-[640px] flex-col gap-[14px]">
        <h2 id="workspace-name-title" className="text-section font-bold">
          {t('Name')}
        </h2>
        {may ? (
          <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-[10px]">
            <div className="min-w-0 flex-[999_1_260px]">
              <Field
                label={t('Workspace name')}
                value={name}
                maxLength={80}
                onChange={(event) => {
                  setName(event.target.value);
                  setKept(false);
                }}
              />
            </div>
            <Button type="submit" tone="outline" size="page" disabled={busy}>
              {busy ? t('Saving…') : t('Save')}
            </Button>
          </form>
        ) : (
          <Field
            label={t('Workspace name')}
            value={workspace.name}
            locked
            hint={t('Only an owner or an admin of the workspace renames it.')}
          />
        )}
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        <p role="status" className="text-small text-muted">
          {kept ? t('The name is saved.') : ''}
        </p>
      </section>
      <LogoSection workspace={workspace} may={may} />
      {workspace.role === 'owner' ? <DeleteSection workspace={workspace} /> : null}
    </>
  );
}

const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only the owner of the workspace deletes it.'),
};
const WORKSPACE_NOT_DELETED = msg('The workspace was not deleted. Try again.');

/**
 * The deletion of the workspace (FRU-503), last on its settings, for its owner alone. It was at the
 * foot of « My account », the page of the person. The call, `DELETE /console/workspaces/<id>`, and
 * the rule of the worker, the owner alone, are those of before. A second press deletes.
 */
function DeleteSection({ workspace }: { workspace: Workspace }) {
  useLocale();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [undeleted, setUndeleted] = useState<string | undefined>();

  async function destroy() {
    setUndeleted(undefined);
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    if (deleted.ok) return navigate('/', { replace: true });
    // The workspace is still there: say so beside the button (FRU-164).
    setUndeleted(problemOf(deleted, DELETION_PROBLEMS, WORKSPACE_NOT_DELETED));
  }

  return (
    <section
      aria-labelledby="delete-title"
      className="mt-[40px] flex max-w-[640px] flex-col gap-[12px] border-t border-line pt-[24px]"
    >
      <h2 id="delete-title" className="text-section font-bold">
        {t('Delete the workspace')}
      </h2>
      <p className="text-small text-muted">
        {t('Sites, members and pin positions go. Items already in your trackers stay there.')}
      </p>
      {undeleted === undefined ? null : <Problem>{t(undeleted)}</Problem>}
      <div>
        {confirming ? (
          <span className="flex flex-wrap gap-[8px]">
            <Button tone="quiet" autoFocus onClick={() => setConfirming(false)}>
              {t('Keep it')}
            </Button>
            <Button tone="danger" onClick={() => void destroy()}>
              {t('Delete {workspace}', { workspace: workspace.name })}
            </Button>
          </span>
        ) : (
          <Button tone="outline" inset={16} onClick={() => setConfirming(true)}>
            {t('Delete workspace')}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * The logo of the workspace (FRU-428): the mark of the rail, larger. An owner or an admin sends one,
 * replaces it and removes it; the rail shows the change at once. Without one, the initial shows.
 */
function LogoSection({ workspace, may }: { workspace: Workspace; may: boolean }) {
  useLocale();
  const { logoChanged } = useWorkspace();
  const [busy, setBusy] = useState<'sending' | 'removing' | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const has = typeof workspace.logo === 'string';
  let pickWords = has ? t('Replace the logo') : t('Upload a logo');
  if (busy === 'sending') pickWords = t('Uploading…');

  async function chosen(file: File) {
    if (busy !== undefined) return;
    setDone(undefined);
    const refused = logoRefusal(file);
    if (refused !== undefined) return setProblem(refused);
    setProblem(undefined);
    setBusy('sending');
    const answer = await setWorkspaceLogo(workspace, file);
    setBusy(undefined);
    if (!answer.ok) return setProblem(problemOf(answer, LOGO_PROBLEMS, LOGO_NOT_SAVED));
    logoChanged(answer.data.logo);
    setDone(msg('The logo is saved.'));
  }

  async function remove() {
    if (busy !== undefined) return;
    setProblem(undefined);
    setDone(undefined);
    setBusy('removing');
    const answer = await removeWorkspaceLogo(workspace);
    setBusy(undefined);
    if (!answer.ok) return setProblem(problemOf(answer, LOGO_PROBLEMS, LOGO_NOT_REMOVED));
    logoChanged(null);
    setDone(msg('The logo is removed.'));
  }

  return (
    <section
      aria-labelledby="workspace-logo-title"
      aria-busy={busy !== undefined}
      className="flex max-w-[640px] flex-col gap-[14px] pt-[32px]"
    >
      <h2 id="workspace-logo-title" className="text-section font-bold">
        {t('Logo')}
      </h2>
      <div className="flex flex-wrap items-center gap-[16px]">
        <WorkspaceMark workspace={workspace} size={64} />
        {may ? (
          <div className="flex flex-wrap gap-[10px]">
            <FilePick accept={LOGO_TYPES.join(',')} disabled={busy !== undefined} onFile={(file) => void chosen(file)}>
              {pickWords}
            </FilePick>
            {has ? (
              <Button tone="outline" size="page" disabled={busy !== undefined} onClick={() => void remove()}>
                {busy === 'removing' ? t('Removing…') : t('Remove the logo')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="text-small text-muted">
        {may
          ? t('PNG, JPEG or WebP, up to 512 KB. It shows beside the name of the workspace, in the rail.')
          : t('Only an owner or an admin of the workspace changes its logo.')}
      </p>
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <p role="status" className="text-small text-muted">
        {done === undefined ? '' : t(done)}
      </p>
    </section>
  );
}
