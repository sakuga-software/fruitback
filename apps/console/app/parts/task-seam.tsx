import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type Answer, type Member, ORGANIZATION, call } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { STATUS_NOT_SAVED, STATUS_PROBLEMS, type StatusChoice } from '../note-status';
import { type Stage } from '../stages';
import { Button, Dialog, Field, Problem, Radios } from '../ui';
import { LABEL_COLORS, type LabelColor } from '../label-colors';
import { useLocale } from '../use-locale';
import { type IndexedNote, placeBetween } from './notes-model';
import { type TaskActions, type TaskChange, type TaskLabel, type TaskMenuSeam, type TaskPerson } from './task-menu';

/** The sentence for a change of a task the worker did not save (FRU-654). */
export const TASK_PROBLEMS: Readonly<Record<string, string>> = {
  'not-allowed': msg('Only the person who left this note, or an owner or an admin, changes it.'),
  'not-member': msg('This person is no longer a member of the workspace. Reload the page.'),
  'unknown-label': msg('This label was removed since the list was read. Reload the page.'),
  'fields-not-taken': msg('This note changes in its tracker.'),
  'tasks-off': msg('This server keeps no task: nothing of a note changes here.'),
  'not-found': msg('This note is no longer in Fruitback. Reload the page.'),
};
export const TASK_NOT_SAVED = msg('The change was not saved. Try again.');
/** The sentence for a change of several tasks the worker did not save (FRU-656): none of them changed. */
export const TASKS_PROBLEMS: Readonly<Record<string, string>> = {
  'not-allowed': msg('One of these notes is not yours to change. Nothing changed.'),
  'not-member': msg('This person is no longer a member of the workspace. Reload the page.'),
  'unknown-label': msg('This label was removed since the list was read. Reload the page.'),
  'too-many-labels': msg('One of these notes would hold more than 20 labels. Nothing changed.'),
  'fields-not-taken': msg('One of these notes changes in its tracker. Nothing changed.'),
  'status-changed': msg('This status is not one of the site of every note any more. Reload the page.'),
  'status-hidden': msg('This status is hidden now, so no note goes in it. Choose another one.'),
  'tasks-off': msg('This server keeps no task: nothing of a note changes here.'),
  'not-found': msg('One of these notes is no longer in Fruitback. Reload the page.'),
};
export const TASKS_NOT_SAVED = msg('Nothing was saved. Try again.');
const LABEL_PROBLEMS: Readonly<Record<string, string>> = {
  'label-taken': msg('The workspace has a label of this name.'),
  'invalid-label': msg('Give the label a name of 40 characters at most.'),
};
const LABEL_NOT_SAVED = msg('The label was not saved. Try again.');
const LABEL_NOT_ON_TASK = msg('The label is added to the workspace, but not to this note: {why}');
const LABEL_NOT_ON_TASKS = msg('The label is added to the workspace, but not to these notes: {why}');

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

/**
 * « Move up » and « Move down » of a note of the board (FRU-665): the way of the keyboard to the place
 * that a drag inside its column gives. None at the end of the column it would go past.
 */
function movesOf(
  note: IndexedNote,
  column: readonly IndexedNote[] | undefined,
  save: (position: number) => Promise<string | undefined>,
): { moveUp?: () => Promise<string | undefined>; moveDown?: () => Promise<string | undefined> } {
  const at = column?.findIndex((each) => each.id === note.id) ?? -1;
  if (column === undefined || at < 0) return {};

  return {
    ...(at > 0 ? { moveUp: () => save(placeBetween(column[at - 2], column[at - 1])) } : {}),
    ...(at < column.length - 1 ? { moveDown: () => save(placeBetween(column[at + 1], column[at + 2])) } : {}),
  };
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
  columnOf,
}: {
  workspace: string;
  base: string;
  manages: boolean;
  statusesOf: (note: IndexedNote) => readonly StatusChoice[] | undefined;
  choose: (note: IndexedNote, status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  read: () => Promise<void>;
  /** FRU-665: the notes of the column of the board a note is in, in their order. Absent: no board. */
  columnOf?: (note: IndexedNote) => readonly IndexedNote[] | undefined;
}): { seam: TaskMenuSeam; dialog: ReactNode } {
  const [people, setPeople] = useState<TaskPerson[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  // The tasks a new label goes on: the one of a menu, or the selection (FRU-656).
  const [labelFor, setLabelFor] = useState<readonly IndexedNote[] | undefined>();

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
    // The route of one task writes all its labels: a label put on or taken off is the set it makes.
    const { addLabels, removeLabels, ...rest } = body;
    const sent =
      addLabels === undefined && removeLabels === undefined
        ? rest
        : {
            ...rest,
            labels: [
              ...(note.task?.labels ?? []).map((label) => label.id).filter((id) => removeLabels?.includes(id) !== true),
              ...(addLabels ?? []).filter((id) => note.task?.labels.some((label) => label.id === id) !== true),
            ],
          };
    const answer = await call('POST', `${base}/notes/${encodeURIComponent(note.id)}/task`, sent);
    if (!answer.ok) return problemOf(answer, TASK_PROBLEMS, TASK_NOT_SAVED);
    await read();

    return undefined;
  };

  /** FRU-656: one call for several tasks; the worker changes all of them or none. */
  const several = async (notes: readonly IndexedNote[], path: string, body: object): Promise<string | undefined> => {
    const answer = await call('POST', `${base}${path}`, { notes: notes.map((note) => note.id), ...body });
    if (!answer.ok) return problemOf(answer, TASKS_PROBLEMS, TASKS_NOT_SAVED);
    await read();

    return undefined;
  };
  const changeAll = (
    notes: readonly IndexedNote[],
    body: Omit<TaskChange, 'labels' | 'position'> & { status?: string },
  ) => several(notes, '/tasks', { change: body });

  const actionsOf = (note: IndexedNote): TaskActions => ({
    setStatus: async (status) => {
      const answer = await choose(note, status);
      if (!answer.ok) return problemOf(answer, STATUS_PROBLEMS, STATUS_NOT_SAVED);
      await read();

      return undefined;
    },
    change: (body) => change(note, body),
    newLabel: () => setLabelFor([note]),
    copyLink: () => void navigator.clipboard?.writeText(linkOf(note)),
    archive: (archived) => change(note, { archived }),
    remove: async () => {
      const answer = await call('DELETE', `${base}/notes/${encodeURIComponent(note.id)}/task`);
      if (!answer.ok) return problemOf(answer, TASK_PROBLEMS, TASK_NOT_SAVED);
      await read();

      return undefined;
    },
    ...movesOf(note, columnOf?.(note), (position) => change(note, { position })),
  });

  const seam: TaskMenuSeam = {
    people,
    labels,
    canAddLabel: manages,
    statusesOf,
    actionsOf,
    actionsOfAll: (notes) => {
      const [only] = notes;
      if (notes.length === 1 && only !== undefined) return actionsOf(only);

      return {
        setStatus: (status) => changeAll(notes, { status }),
        change: ({ labels: _labels, position: _position, ...body }) => changeAll(notes, body),
        newLabel: () => setLabelFor(notes),
        archive: (archived) => changeAll(notes, { archived }),
        remove: () => several(notes, '/tasks/delete', {}),
      };
    },
  };

  const dialog = (
    <NewLabel
      open={labelFor !== undefined}
      onClose={() => setLabelFor(undefined)}
      create={async (label) => {
        const answer = await call<{ label: TaskLabel }>('POST', `${base}/labels`, label);
        if (!answer.ok) return { created: false, refused: t(problemOf(answer, LABEL_PROBLEMS, LABEL_NOT_SAVED)) };
        await readLabels();
        const notes = labelFor ?? [];
        const [only] = notes;
        if (notes.length > 0) {
          // The label exists now: a refusal to put it on the tasks stays in the dialog, which keeps open.
          const put = { addLabels: [answer.data.label.id] };
          const refused =
            notes.length === 1 && only !== undefined ? await change(only, put) : await changeAll(notes, put);
          const words = notes.length === 1 ? LABEL_NOT_ON_TASK : LABEL_NOT_ON_TASKS;
          if (refused !== undefined) return { created: true, refused: t(words, { why: t(refused) }) };
        }
        setLabelFor(undefined);

        return { created: true };
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
  create: (label: { name: string; color: string }) => Promise<{ created: boolean; refused?: string }>;
}) {
  useLocale();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_COLORS.red);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function save() {
    setSaving(true);
    setProblem(undefined);
    const { created, refused } = await create({ name: name.trim(), color });
    setSaving(false);
    // A label made is not made again: its name goes, even when the task did not take it.
    if (created) setName('');
    if (refused !== undefined) setProblem(refused);
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
        {/* `create` answers the sentence in the language of the screen. */}
        {problem === undefined ? null : <Problem>{problem}</Problem>}
        <div className="flex justify-end">
          <Button type="submit" disabled={name.trim() === '' || saving}>
            {saving ? t('Saving…') : t('Add the label')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
