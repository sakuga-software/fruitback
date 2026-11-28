import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  LOGO_TYPES,
  type Workspace,
  call,
  removeWorkspaceLogo,
  renameWorkspace,
  setWorkspaceLogo,
  workspaceAddress,
} from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { manages } from '../setup-stage';
import { SettingsIcon } from '../settings-icons';
import { Button, Dialog, Field, FilePick, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { LOGO_NOT_REMOVED, LOGO_NOT_SAVED, LOGO_PROBLEMS, logoRefusal } from '../workspace-logo';
import { MAX_SLUG, SLUG_PROBLEMS, slugOf, slugRefusal } from '../workspace-slug';
import { RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED } from '../parts/setup-account';
import { Row, SettingsCard } from '../parts/account-rows';
import { SettingsHead } from './settings-shell';
import { WorkspaceMark, useWorkspace } from './workspace';

/**
 * The page « General » of the settings of a workspace (FRU-693; before, FRU-414): « Settings » in the
 * rail for an owner or an admin (FRU-503), and the name of the workspace at the top of the rail for
 * every role. The mockup « Réglages General » of FRU-693 draws it in the shell of FRU-692.
 *
 * Two cards. « Identity »: the logo (FRU-428), the name (FRU-236) and the address of the workspace
 * in the console, its short name (FRU-715). Every member reads them; an owner or an admin changes
 * them. The name and the short name leave together by « Save » in the head, which stays disabled
 * while both are the ones kept, or by Enter in either field. The logo leaves as soon as it is chosen,
 * as before. « Danger zone », for the
 * owner alone: the deletion of the workspace (FRU-503), confirmed in a dialog by typing its name.
 * What an agent needs is on the page « AI » (FRU-544, `workspace-settings-ai.tsx`).
 */
export default function WorkspaceSettings() {
  const { workspace } = useWorkspace();

  // A move to the settings of another workspace mounts the form again: nothing typed for one
  // workspace is saved as the name of another.
  return <Settings key={workspace.id} />;
}

/**
 * The form of the name and the short name: Enter in either field sends both, and « Save » in the head
 * submits it by its id.
 */
const NAME_FORM = 'workspace-name-form';

function Settings() {
  useLocale();
  const { workspace, renamed } = useWorkspace();
  const [name, setName] = useState(workspace.name);
  // FRU-715: a worker of before keeps no short name: the row then shows the id, and no field.
  const [slug, setSlug] = useState(workspace.slug ?? '');
  const [busy, setBusy] = useState(false);
  // One rename on its way at a time, whatever the state drawn says yet: two Enter in a row, or Enter
  // then « Save », send one name (raised in review).
  const sending = useRef(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [slugProblem, setSlugProblem] = useState<string | undefined>();
  // What the last « Save » kept, said under the address: `undefined` for nothing said.
  const [kept, setKept] = useState<'name' | 'address' | 'both' | undefined>();
  const may = manages(workspace);
  // « Save » acts only on a change: the worker trims the name, so the console compares it trimmed.
  const slugChanged = workspace.slug !== undefined && slugOf(slug) !== workspace.slug;
  const changed = name.trim() !== workspace.name || slugChanged;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    setProblem(undefined);
    setSlugProblem(undefined);
    setKept(undefined);
    if (!changed) return setKept('name');
    // The form of the short name is said at once; the worker says the rest.
    const refused = slugChanged ? slugRefusal(slug) : undefined;
    if (refused !== undefined) return setSlugProblem(SLUG_PROBLEMS[refused]);
    sending.current = true;
    setBusy(true);
    const answer = await renameWorkspace(workspace, name, slugChanged ? slugOf(slug) : undefined);
    sending.current = false;
    setBusy(false);
    // A refusal keeps the name and the short name as they were typed. A refusal of the short name is
    // said under it: the worker kept neither.
    if (!answer.ok) {
      if (Object.hasOwn(SLUG_PROBLEMS, answer.error)) return setSlugProblem(SLUG_PROBLEMS[answer.error]);

      return setProblem(problemOf(answer, RENAME_PROBLEMS, WORKSPACE_NOT_RENAMED));
    }
    const nameChanged = answer.data.name !== workspace.name;
    setName(answer.data.name);
    if (answer.data.slug !== undefined) setSlug(answer.data.slug);
    if (!slugChanged) setKept('name');
    else setKept(nameChanged ? 'both' : 'address');
    renamed(answer.data);
  }

  return (
    <>
      <SettingsHead
        title={t('General')}
        lead={t('Every member of {name} sees these.', { name: workspace.name })}
        action={
          may ? (
            <Button size="panel" type="submit" form={NAME_FORM} disabled={busy || !changed}>
              {busy ? t('Saving…') : t('Save')}
            </Button>
          ) : undefined
        }
      />
      <div className="flex max-w-[880px] flex-col gap-[16px]">
        <IdentityCard
          workspace={workspace}
          may={may}
          name={name}
          onName={(typed) => {
            setName(typed);
            setKept(undefined);
          }}
          slug={slug}
          onSlug={(typed) => {
            setSlug(typed.toLowerCase());
            setSlugProblem(undefined);
            setKept(undefined);
          }}
          onSubmit={(event) => void submit(event)}
          problem={problem}
          slugProblem={slugProblem}
          kept={kept}
        />
        {workspace.role === 'owner' ? <DangerZone workspace={workspace} /> : null}
      </div>
    </>
  );
}

/** What « Save » says it kept. */
const KEPT_WORDS = {
  name: msg('The name is saved.'),
  address: msg('The address is saved.'),
  both: msg('The name and the address are saved.'),
} as const;

/** The classes of a box of 320 px at the end of a row, which takes the whole row under 640 px. */
const ROW_BOX = 'w-full min-w-0 min-[640px]:w-[320px] min-[640px]:flex-none';

/**
 * « Identity »: the logo, the name and the address of the workspace, one row each, the box of each at
 * the end of its row, 320 px wide (the mockup). Under 640 px the box goes under the words.
 */
function IdentityCard({
  workspace,
  may,
  name,
  onName,
  slug,
  onSlug,
  onSubmit,
  problem,
  slugProblem,
  kept,
}: {
  workspace: Workspace;
  may: boolean;
  name: string;
  onName: (name: string) => void;
  slug: string;
  onSlug: (slug: string) => void;
  onSubmit: (event: FormEvent) => void;
  problem: string | undefined;
  slugProblem: string | undefined;
  kept: 'name' | 'address' | 'both' | undefined;
}) {
  useLocale();
  const logo = useLogo(workspace);
  // The address of the workspace in this console (FRU-715): its short name after `/w/`.
  const host = typeof window === 'undefined' ? '' : window.location.host;

  return (
    <SettingsCard id="identity-title" icon="general" title={t('Identity')} busy={logo.busy !== undefined}>
      <ul className="flex flex-col">
        <Row
          icon={<WorkspaceMark workspace={workspace} size={40} />}
          title={t('Logo')}
          detail={
            may
              ? t('PNG, JPEG or WebP, up to 512 KB. Shown beside the workspace name.')
              : t('Only an owner or an admin of the workspace changes its logo.')
          }
          under={logo.under}
        >
          {may ? logo.actions : null}
        </Row>
        <li className="kit-settings-row border-t border-line px-[16px]">
          <form
            id={NAME_FORM}
            noValidate
            onSubmit={onSubmit}
            className="flex min-h-[56px] flex-wrap items-center gap-x-[12px] gap-y-[8px] py-[10px]"
          >
            <RowWords
              title={t('Workspace name')}
              detail={may ? undefined : t('Only an owner or an admin of the workspace renames it.')}
            />
            <div className={ROW_BOX}>
              <Field
                label={t('Workspace name')}
                labelHidden
                value={may ? name : workspace.name}
                maxLength={80}
                locked={!may}
                onChange={(event) => onName(event.target.value)}
              />
            </div>
          </form>
          {/* Under the words of the row, as the words start after the mark of 40 px of « Logo ». */}
          {problem === undefined ? null : (
            <div className="pb-[12px] min-[640px]:ps-[52px]">
              <Problem>{t(problem)}</Problem>
            </div>
          )}
          <p
            role="status"
            className={kept === undefined ? 'sr-only' : 'pb-[12px] text-hint text-muted min-[640px]:ps-[52px]'}
          >
            {kept === undefined ? '' : t(KEPT_WORDS[kept])}
          </p>
        </li>
        <li className="kit-settings-row border-t border-line px-[16px]">
          {may && workspace.slug !== undefined ? (
            <div className="flex min-h-[56px] flex-wrap items-center gap-x-[12px] gap-y-[8px] py-[10px]">
              <RowWords title={t('Workspace URL')} />
              <div className={ROW_BOX}>
                {/* In the form of the name, by its id: Enter here submits it, as « Save » does. */}
                <Field
                  label={t('Workspace URL')}
                  labelHidden
                  prefix={`${host}/w/`}
                  value={slug}
                  maxLength={MAX_SLUG}
                  autoComplete="off"
                  form={NAME_FORM}
                  onChange={(event) => onSlug(event.target.value)}
                  {...(slugProblem === undefined ? {} : { error: t(slugProblem) })}
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-[56px] flex-wrap items-center gap-x-[12px] gap-y-[8px] py-[10px]">
              <RowWords title={t('Workspace URL')} />
              <span
                className={`${ROW_BOX} flex min-h-control-lg items-center rounded-control border border-line px-[10px] py-[4px] text-small [overflow-wrap:anywhere]`}
              >
                <span>
                  <span className="text-muted">{`${host}/w/`}</span>
                  {workspaceAddress(workspace)}
                </span>
              </span>
            </div>
          )}
        </li>
      </ul>
    </SettingsCard>
  );
}

/**
 * The words at the start of a row whose box is a field: its name, and the line under it. They start
 * where the words of the row « Logo » start, after its mark of 40 px (the mockup).
 */
function RowWords({ title, detail }: { title: string; detail?: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-[1_1_200px] flex-col gap-[4px] min-[640px]:ps-[52px]">
      <span aria-hidden="true" className="text-small leading-auto font-semibold">
        {title}
      </span>
      {detail === undefined ? null : <span className="text-hint text-muted">{detail}</span>}
    </span>
  );
}

/**
 * The logo of the workspace (FRU-428), a row of « Identity »: the mark of the rail, larger. An owner
 * or an admin sends one, replaces it and removes it; the rail shows the change at once. Without one,
 * the initial shows.
 */
function useLogo(workspace: Workspace) {
  const { logoChanged } = useWorkspace();
  const [busy, setBusy] = useState<'sending' | 'removing' | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const has = typeof workspace.logo === 'string';
  let pickWords = has ? t('Replace') : t('Upload');
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

  const actions = (
    <span className="flex flex-wrap gap-[8px]">
      {has ? (
        <Button
          tone="outline"
          size="small"
          disabled={busy !== undefined}
          label={t('Remove the logo')}
          onClick={() => void remove()}
        >
          {busy === 'removing' ? t('Removing…') : t('Remove')}
        </Button>
      ) : null}
      <FilePick
        accept={LOGO_TYPES.join(',')}
        size="small"
        disabled={busy !== undefined}
        {...(busy === 'sending' ? {} : { label: has ? t('Replace the logo') : t('Upload a logo') })}
        onFile={(file) => void chosen(file)}
      >
        {pickWords}
      </FilePick>
    </span>
  );
  const under = (
    <>
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <p role="status" className={done === undefined ? 'sr-only' : 'text-hint text-muted'}>
        {done === undefined ? '' : t(done)}
      </p>
    </>
  );

  return { busy, actions, under };
}

const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only the owner of the workspace deletes it.'),
};
const WORKSPACE_NOT_DELETED = msg('The workspace was not deleted. Try again.');

/**
 * « Danger zone » (FRU-693), last on the page, for the owner alone: the deletion of the workspace
 * (FRU-503). « Delete… » opens a dialog that says what goes, and deletes only once the name of the
 * workspace is typed in it. The call, `DELETE /console/workspaces/<id>`, and the rule of the worker,
 * the owner alone (`delete-workspace`), are those of before.
 */
function DangerZone({ workspace }: { workspace: Workspace }) {
  useLocale();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [undeleted, setUndeleted] = useState<string | undefined>();
  // The name as the rail shows it, typed again: the case counts, the spaces around do not.
  const named = typed.trim() === workspace.name;

  function close() {
    // A deletion on its way ends in the dialog: a refusal is said there, a success leaves the page.
    if (deleting) return;
    setOpen(false);
    setTyped('');
    setUndeleted(undefined);
  }

  async function destroy(event: FormEvent) {
    event.preventDefault();
    if (!named || deleting) return;
    setUndeleted(undefined);
    setDeleting(true);
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    setDeleting(false);
    if (deleted.ok) return navigate('/', { replace: true });
    // The workspace is still there: say so in the dialog, which stays open (FRU-164).
    setUndeleted(problemOf(deleted, DELETION_PROBLEMS, WORKSPACE_NOT_DELETED));
  }

  return (
    <SettingsCard id="danger-title" title={t('Danger zone')} danger>
      <ul className="flex flex-col">
        <Row
          icon={
            <span className="inline-flex flex-none text-accent-strong">
              <SettingsIcon name="trash" />
            </span>
          }
          title={t('Delete the workspace')}
          detail={t('Sites, members and pin positions go. Items in your trackers stay there.')}
        >
          <Button tone="danger-outline" size="small" label={t('Delete the workspace')} onClick={() => setOpen(true)}>
            {t('Delete…')}
          </Button>
        </Row>
      </ul>
      <Dialog
        open={open}
        onClose={close}
        locked={deleting}
        title={t('Delete {workspace}?', { workspace: workspace.name })}
        closeLabel={t('Close')}
        size="sm"
      >
        <form noValidate onSubmit={(event) => void destroy(event)} className="flex flex-col gap-[12px]">
          <p className="text-small text-muted">
            {t(
              'Its sites, its members and the positions of its pins go, for every member, and cannot come back. Items already in your trackers stay there.',
            )}
          </p>
          <Field
            label={t('Type {workspace} to confirm', { workspace: workspace.name })}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
          {undeleted === undefined ? null : <Problem>{t(undeleted)}</Problem>}
          <div className="flex flex-wrap justify-end gap-[8px]">
            <Button tone="outline" size="small" disabled={deleting} onClick={close}>
              {t('Keep it')}
            </Button>
            <Button tone="danger" type="submit" disabled={!named || deleting}>
              {deleting ? t('Deleting…') : t('Delete {workspace}', { workspace: workspace.name })}
            </Button>
          </div>
        </form>
      </Dialog>
    </SettingsCard>
  );
}
