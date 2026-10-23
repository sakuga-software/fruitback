import { type FormEvent, useState } from 'react';
import { renameWorkspace } from '../api';
import { t } from '../i18n';
import { problemOf } from '../problems';
import { manages } from '../setup-stage';
import { Button, Field, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED } from './setup-account';
import { PageHead, useWorkspace } from './workspace';

/**
 * The settings of a workspace (FRU-414), opened from the name of the workspace at the top of the
 * rail. No board draws it: it is the kit, as « My account » lays it out.
 *
 * It holds what the worker lets a workspace change today: its name (FRU-236), for an owner or an
 * admin. A logo is not here: a workspace has none in the worker, and no route keeps one.
 */
export default function WorkspaceSettings() {
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
      <section aria-labelledby="workspace-name-title" className="flex max-w-[640px] flex-col gap-[14px] pt-[12px]">
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
    </>
  );
}
