import { type FormEvent, useEffect, useState } from 'react';
import { msg, t } from '../i18n';
import { VIEW_NAME_MAX } from '../saved-views';
import { Button, Dialog, DialogFoot, Field, Problem } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The name of a view of the person (FRU-723): « Save view » from the bar of filters of the notes, and
 * « Rename » from the menu of its entry in the bar. `onSave` answers the sentence of a refusal, or
 * nothing once the worker kept it: the dialog then closes. A refusal keeps what was typed.
 */
export function ViewNameDialog({
  open,
  title,
  saveLabel,
  initial = '',
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  /** The button that sends: « Save view », « Rename ». */
  saveLabel: string;
  initial?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<string | undefined>;
}) {
  useLocale();
  const [typed, setTyped] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // Each opening starts from the name of the view, with no sentence of a refusal before it. Only an
  // opening: a name that changes while the dialog is open never takes the place of what was typed.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTyped(initial);
      setProblem(undefined);
    }
  }
  const name = typed.trim();

  async function send(event: FormEvent) {
    event.preventDefault();
    if (name === '' || busy) return;
    setBusy(true);
    const refused = await onSave(name);
    setBusy(false);
    if (refused === undefined) onClose();
    else setProblem(refused);
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} closeLabel={t('Close')} size="form" framed>
      <form onSubmit={(event) => void send(event)} aria-label={title} className="flex flex-col">
        <div className="flex flex-col gap-[16px] px-[20px] py-[16px]">
          <Field
            label={t('Name')}
            autoFocus
            maxLength={VIEW_NAME_MAX}
            placeholder={t('Urgent bugs')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            hint={t('Only you see your views, in each browser where you sign in.')}
          />
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        </div>
        <DialogFoot>
          <span className="ml-auto" />
          <Button tone="outline" size="panel" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" size="panel" disabled={busy || name === ''}>
            {busy ? t('Saving…') : saveLabel}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}

/**
 * The second time of « Delete » from the menu of the entry of a view (FRU-723): what goes, « Cancel »
 * and the button that names the view. Only the view goes: its notes stay where they are.
 */
export function DeleteViewDialog({
  open,
  name,
  onClose,
  onDelete,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
  onDelete: () => Promise<boolean>;
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (open) setFailed(false);
  }, [open]);

  async function remove() {
    setBusy(true);
    const deleted = await onDelete();
    setBusy(false);
    if (deleted) onClose();
    else setFailed(true);
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Delete the view')} closeLabel={t('Close')} size="form" framed>
      <div className="flex flex-col gap-[12px] px-[20px] py-[16px] text-(length:--text-body)">
        <p>{t('The view « {name} » goes from your bar. Its notes stay where they are.', { name })}</p>
        {failed ? <Problem>{t('The view was not deleted. Try again.')}</Problem> : null}
      </div>
      <DialogFoot>
        <span className="ml-auto" />
        <Button tone="outline" size="panel" autoFocus onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button tone="danger" size="panel" disabled={busy} onClick={() => void remove()}>
          {t('Delete « {name} »', { name })}
        </Button>
      </DialogFoot>
    </Dialog>
  );
}

/**
 * Why a view was not kept, as a sentence of the screen: the limit, a filter the person cannot keep,
 * or the rest.
 */
export function viewProblem(answer: { status: number; error: string }): string {
  if (answer.error === 'too-many-views') return msg('You keep 20 views already. Delete one, then save this one.');
  if (answer.status === 403) return msg('This view has a filter that you cannot keep.');
  if (answer.error === 'invalid-name') return msg('Give the view a name of one line, 60 characters at most.');

  return msg('The view was not saved. Try again.');
}
