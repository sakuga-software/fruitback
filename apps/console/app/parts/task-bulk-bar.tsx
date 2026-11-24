import { useContext, useEffect, useRef, useState } from 'react';
import { Confirmation } from '../confirm';
import { t } from '../i18n';
import { NoteIcon } from '../note-icons';
import { BranchMenu, Button, IconButton, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { TaskMenuContext, branchesOf, deleteWords } from './task-menu';
import { TaskSelectionContext, isEditable, selectedWords } from './task-selection';

/** « 3 notes changed. », once the worker saved a change of the bar. */
function changedWords(count: number): string {
  return count === 1 ? t('1 note changed.') : t('{count} notes changed.', { count });
}

function deletedWords(count: number): string {
  return count === 1 ? t('1 note deleted.') : t('{count} notes deleted.', { count });
}

/**
 * The bar of a selection (FRU-656, `design/task-bulk`): under the list, held at the foot of the screen
 * while the list is there, from the first selected task. It says how many tasks are selected, offers
 * the rest of the page, and changes every selected task this person may change at once: the five
 * submenus of the menu of a task (FRU-654) as buttons, then « Archive » and « Delete… », which asks
 * again. One change is one call, and the worker changes every task or none. A task this person may not
 * change stays selected, and is said: a copy of the selection needs no right to change.
 */
export function TaskBulkBar() {
  useLocale();
  const selection = useContext(TaskSelectionContext);
  const seam = useContext(TaskMenuContext);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLSpanElement>(null);
  // Another selection: nothing said of the one before, and no question of it left open.
  const chosen = selection?.notes.map((note) => note.id).join(' ') ?? '';
  useEffect(() => {
    setProblem(undefined);
    setDeleting(false);
  }, [chosen]);
  if (selection === undefined || seam === undefined || selection.notes.length === 0) return null;

  const { notes } = selection;
  const editable = notes.filter(isEditable);
  const others = notes.length - editable.length;
  const actions = seam.actionsOfAll(editable);
  const settle = (done: Promise<string | undefined>, words: string) => {
    setProblem(undefined);
    setBusy(true);
    selection.say(undefined);
    void done.then((refused) => {
      setBusy(false);
      if (refused === undefined) selection.say(words);
      else setProblem(refused);
    });
  };
  const branches =
    editable.length === 0
      ? []
      : branchesOf(editable, seam, actions, (done) => settle(done, changedWords(editable.length)));
  const archived = editable.length > 0 && editable.every((note) => note.task?.archived === true);
  let unchangeable: string | undefined;
  if (editable.length === 0) {
    unchangeable = t(
      'None of these notes is yours to change: only the person who left a note, or an owner or an admin, changes it.',
    );
  } else if (others === 1) {
    unchangeable = t('1 of them is not yours to change: it stays as it is.');
  } else if (others > 1) {
    unchangeable = t('{count} of them are not yours to change: they stay as they are.', { count: others });
  }

  return (
    <section
      aria-label={t('The selected notes')}
      aria-busy={busy}
      className="kit-selection-bar mt-[16px] flex flex-col gap-[8px] px-[14px] py-[10px]"
    >
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[8px]">
        <span className="flex flex-col items-start">
          <span className="text-small font-semibold">{selectedWords(notes.length)}</span>
          {notes.length < selection.selectable.length ? (
            <LinkButton onClick={() => selection.all(true)}>
              {t('Select the {count} of this page', { count: selection.selectable.length })}
            </LinkButton>
          ) : null}
        </span>
        {editable.length === 0 ? null : (
          <span className="flex flex-wrap items-center gap-[6px]">
            {branches.map((branch) => (
              <BranchMenu key={branch.id} branch={branch} disabled={busy} />
            ))}
            <Button
              tone="outline"
              size="small"
              disabled={busy}
              onClick={() => settle(actions.archive(!archived), changedWords(editable.length))}
            >
              {archived ? t('Bring back') : t('Archive')}
            </Button>
            <span ref={deleteButton}>
              <Button
                tone="outline"
                size="small"
                disabled={busy}
                className="text-accent-strong"
                onClick={() => setDeleting(true)}
              >
                {t('Delete…')}
              </Button>
            </span>
          </span>
        )}
        <span className="ml-auto">
          <IconButton label={t('Clear the selection')} onClick={() => selection.clear()}>
            <NoteIcon name="close" />
          </IconButton>
        </span>
      </div>
      {unchangeable === undefined ? null : <p className="text-hint text-muted">{unchangeable}</p>}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      {selection.said === undefined ? null : <p className="text-hint font-semibold text-done">{selection.said}</p>}
      {deleting ? (
        <Confirmation
          {...deleteWords(editable.length)}
          {...(editable.length > 1 ? { keepLabel: t('Keep them') } : {})}
          onKeep={() => {
            setDeleting(false);
            deleteButton.current?.querySelector('button')?.focus();
          }}
          onConfirm={() => {
            setDeleting(false);
            settle(actions.remove(), deletedWords(editable.length));
          }}
        />
      ) : null}
    </section>
  );
}
