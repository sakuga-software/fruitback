import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type Answer, type Member, ORGANIZATION, call } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { STATUS_NOT_SAVED, STATUS_PROBLEMS, type StatusChoice } from '../note-status';
import { type Stage } from '../stages';
import { Button, Dialog, Field, Problem, Radios } from '../ui';
import { LABEL_COLORS, type LabelColor } from '../label-colors';
import { useLocale } from '../use-locale';
import { type IndexedNote } from './notes-model';
import { type TaskChange, type TaskLabel, type TaskMenuSeam, type TaskPerson } from './task-menu';

/** The sentence for a change of a task the worker did not save (FRU-654). */
export const TASK_PROBLEMS: Readonly<Record<string, string>> = {
  'not-allowed': msg('Only the person who left this note, or an owner or an admin, changes it.'),
  'not-member': msg('This person is no longer a member of the workspace. Reload the page.'),
  'unknown-label': msg('This label was removed since the list was read. Reload the page.'),
  'fields-not-taken': msg('This note changes in its tracker.'),
  'tasks-off': msg('This server keeps no task: nothing of a note changes here.'),
  'not-found': msg('This note is no longer in Fruitback. Reload the page.'),
};
const TASK_NOT_SAVED = msg('The change was not saved. Try again.');
const LABEL_PROBLEMS: Readonly<Record<string, string>> = {
  'label-taken': msg('The workspace has a label of this name.'),
  'invalid-label': msg('Give the label a name of 40 characters at most.'),
};
const LABEL_NOT_SAVED = msg('The label was not saved. Try again.');

function colourName(color: LabelColor): string {
  switch (color) {
    case 'red':
      return t('Red');
    case 'orange':
      return t('Orange');
    case 'yellow':
      return t('Yellow');
    case 'emerald':
      return t('Green');
    case 'teal':
      return t('Teal');
    case 'blue':
      return t('Blue');
    case 'purple':
      return t('Purple');
    case 'grey':
      return t('Grey');
  }
}

/** The link of the widget that opens the note on its page (FRU-253). */
function linkOf(note: IndexedNote): string {
  const opened = note.note ?? note.ref;

  return opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
}

/**
 * What the screen of the notes gives the menus of its tasks (FRU-654): the members, the labels of the
 * workspace, and the writes, each followed by a read of the list. And the dialog of a new label,
 * which puts the label on the task it was asked from.
 */
export function useTaskSeam({
  workspace,
  base,
  manages,
  statusesOf,
  choose,
  read,
}: {
  workspace: string;
  base: string;
  manages: boolean;
  statusesOf: (note: IndexedNote) => readonly StatusChoice[] | undefined;
  choose: (note: IndexedNote, status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  read: () => Promise<void>;
}): { seam: TaskMenuSeam; dialog: ReactNode } {
  const [people, setPeople] = useState<TaskPerson[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [labelFor, setLabelFor] = useState<IndexedNote | undefined>();

  const readLabels = useCallback(async () => {
    const answer = await call<{ labels: TaskLabel[] }>('GET', `${base}/labels`);
    if (answer.ok) setLabels(answer.data.labels);
  }, [base]);

  useEffect(() => {
    void readLabels();
    const query = new URLSearchParams({ organizationId: workspace, limit: '200', offset: '0' });
    void call<{ members: Member[] }>('GET', `${ORGANIZATION}/list-members?${query}`).then((answer) => {
      if (!answer.ok) return;
      setPeople(
        answer.data.members
          .filter((member) => member.role !== 'guest')
          .map((member) => ({ id: member.user.id, name: member.user.name || member.user.email }))
          .sort((one, other) => one.name.localeCompare(other.name)),
      );
    });
  }, [workspace, readLabels]);

  const change = async (note: IndexedNote, body: TaskChange): Promise<string | undefined> => {
    const answer = await call('POST', `${base}/notes/${encodeURIComponent(note.id)}/task`, body);
    if (!answer.ok) return problemOf(answer, TASK_PROBLEMS, TASK_NOT_SAVED);
    await read();

    return undefined;
  };

  const seam: TaskMenuSeam = {
    people,
    labels,
    canAddLabel: manages,
    statusesOf,
    actionsOf: (note) => ({
      setStatus: async (status) => {
        const answer = await choose(note, status);
        if (!answer.ok) return problemOf(answer, STATUS_PROBLEMS, STATUS_NOT_SAVED);
        await read();

        return undefined;
      },
      change: (body) => change(note, body),
      newLabel: () => setLabelFor(note),
      copyLink: () => void navigator.clipboard?.writeText(linkOf(note)),
    }),
  };

  const dialog = (
    <NewLabel
      open={labelFor !== undefined}
      onClose={() => setLabelFor(undefined)}
      create={async (label) => {
        const answer = await call<{ label: TaskLabel }>('POST', `${base}/labels`, label);
        if (!answer.ok) return problemOf(answer, LABEL_PROBLEMS, LABEL_NOT_SAVED);
        await readLabels();
        const note = labelFor;
        setLabelFor(undefined);
        if (note?.task !== undefined) {
          await change(note, { labels: [...note.task.labels.map((one) => one.id), answer.data.label.id] });
        }

        return undefined;
      }}
    />
  );

  return { seam, dialog };
}

/** The dialog of a new label: a name and one of eight colours. What is typed stays when it closes. */
function NewLabel({
  open,
  onClose,
  create,
}: {
  open: boolean;
  onClose: () => void;
  create: (label: { name: string; color: string }) => Promise<string | undefined>;
}) {
  useLocale();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_COLORS.red);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function save() {
    setSaving(true);
    setProblem(undefined);
    const refused = await create({ name: name.trim(), color });
    setSaving(false);
    if (refused !== undefined) return setProblem(refused);
    setName('');
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('New label')} closeLabel={t('Close')} size="sm">
      <form
        className="flex flex-col gap-[16px]"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && !saving) void save();
        }}
      >
        <Field label={t('Name')} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <Radios
          label={t('Colour')}
          value={color}
          onChange={setColor}
          options={(Object.keys(LABEL_COLORS) as LabelColor[]).map((each) => ({
            value: LABEL_COLORS[each],
            label: colourName(each),
            swatch: LABEL_COLORS[each],
          }))}
        />
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        <div className="flex justify-end">
          <Button type="submit" disabled={name.trim() === '' || saving}>
            {saving ? t('Saving…') : t('Add the label')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
