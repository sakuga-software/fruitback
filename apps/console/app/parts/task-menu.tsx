import { type KeyboardEvent, type MouseEvent, type ReactNode, createContext, useContext, useState } from 'react';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { type StatusChoice, statusName } from '../note-status';
import { STAGE_NAMES, type Stage } from '../stages';
import { LinkButton, MenuTree, type TreeBranch } from '../ui';
import { Confirmation } from '../confirm';
import { SERVER_CAUSE, UNREACHABLE_CAUSE } from '../problems';
import { isReachable } from '../transport';
import { type IndexedNote, type TaskFields } from './notes-model';
import { TaskSelectionContext, isEditable } from './task-selection';

export type TaskLabel = { id: string; name: string; color: string };
export type TaskPerson = { id: string; name: string };
export type TaskChange = {
  assignee?: string | null;
  priority?: TaskFields['priority'] | null;
  dueOn?: string | null;
  /** Every label of one task: the page of a task writes them so. */
  labels?: string[];
  /** FRU-656: labels put on, and taken off, each task; its other labels stay. */
  addLabels?: string[];
  removeLabels?: string[];
  position?: number;
  archived?: boolean;
};

/** What the menu of a task does: each write answers a refusal to say, or `undefined` once saved. */
export type TaskActions = {
  setStatus: (status: string) => Promise<string | undefined>;
  change: (change: TaskChange) => Promise<string | undefined>;
  newLabel: () => void;
  /** Absent for several tasks: a link is of one note. */
  copyLink?: () => void;
  /** FRU-665: out of the lists, or back in them. */
  archive: (archived: boolean) => Promise<string | undefined>;
  /** FRU-665: deleted for good, once the person confirmed it. */
  remove: () => Promise<string | undefined>;
  /** FRU-665: one place up or down in its column of the board; absent at its end, or out of the board. */
  moveUp?: () => Promise<string | undefined>;
  moveDown?: () => Promise<string | undefined>;
};

type Priority = NonNullable<TaskFields['priority']>;
const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low'];
const NONE = 'none';
const NEW_LABEL = 'new-label';
const MEMBERS_LOADING = 'members-loading';
const MEMBERS_FAILED = 'members-failed';
const LABELS_LOADING = 'labels-loading';
const LABELS_FAILED = 'labels-failed';
const TRY_AGAIN = 'try-again';
const stageName = (stage: Stage) => t(STAGE_NAMES[stage]);

/** A day `YYYY-MM-DD` of the calendar of the browser, `days` after today. */
export function dayFromToday(days: number, now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function priorityWord(priority: Priority): string {
  switch (priority) {
    case 'urgent':
      return t('Urgent');
    case 'high':
      return t('High');
    case 'medium':
      return t('Medium');
    case 'low':
      return t('Low');
  }
}

/** The value every task has, or `undefined` when they differ. */
function sameOf<Value>(values: readonly Value[]): Value | undefined {
  const [first] = values;

  return values.every((value) => value === first) ? first : undefined;
}

/**
 * The submenus of tasks the worker keeps, that this person may change (FRU-654): their status, their
 * assignee, their priority, their day and their labels. One task, or the tasks of a selection
 * (FRU-656): a value is checked when every task has it, a status is offered when the site of every
 * task has it, and a label checked is taken off every task, one not checked put on every one. A
 * change is saved at once; its refusal goes to `settle`.
 */
export function branchesOf(
  notes: readonly IndexedNote[],
  seam: TaskMenuSeam,
  actions: TaskActions,
  settle: (done: Promise<string | undefined>) => void,
): TreeBranch[] {
  const tasks = notes.flatMap((note) => (note.task === undefined ? [] : [note.task]));
  const [first, ...rest] = notes.map((note) => seam.statusesOf(note)?.filter((status) => status.hidden !== true) ?? []);
  const statuses = (first ?? []).filter((status) => rest.every((each) => each.some((one) => one.key === status.key)));
  const status = sameOf(notes.map((note) => note.status));
  const assignee = sameOf(tasks.map((task) => task.assignee?.id ?? NONE));
  const priority = sameOf(tasks.map((task) => task.priority ?? NONE));

  return [
    ...(statuses.length === 0
      ? []
      : [
          {
            id: 'status',
            label: t('Status'),
            choice: 'single' as const,
            checked: status === undefined ? [] : [status],
            items: statuses.map((each) => ({ id: each.key, label: statusName(each, stageName) })),
            onAction: (key: string) => settle(actions.setStatus(key)),
          },
        ]),
    assigneeBranch(seam, assignee === undefined ? [] : [assignee], (chosen) =>
      settle(actions.change({ assignee: chosen })),
    ),
    {
      id: 'priority',
      label: t('Priority'),
      choice: 'single',
      checked: priority === undefined ? [] : [priority],
      items: [
        ...PRIORITIES.map((each) => ({ id: each, label: priorityWord(each) })),
        { id: NONE, label: t('No priority') },
      ],
      onAction: (key) => settle(actions.change({ priority: key === NONE ? null : (key as Priority) })),
    },
    {
      id: 'due',
      label: t('Due day'),
      items: [
        { id: '0', label: t('Today') },
        { id: '1', label: t('Tomorrow') },
        { id: '7', label: t('In a week') },
        { id: NONE, label: t('No due day') },
      ],
      onAction: (key) => settle(actions.change({ dueOn: key === NONE ? null : dayFromToday(Number(key)) })),
    },
    labelsBranch(seam, tasks, actions, settle),
  ];
}

/**
 * The submenu « Labels » (FRU-675): the labels of the workspace, once they are read, and « New
 * label… » for an owner or an admin. A read that failed says so, with « Try again », and never
 * « No label yet »: the workspace may hold labels. « New label… » waits for the read too, as a new
 * label could take the name of one that is not shown.
 */
function labelsBranch(
  seam: TaskMenuSeam,
  tasks: readonly TaskFields[],
  actions: TaskActions,
  settle: (done: Promise<string | undefined>) => void,
): TreeBranch {
  if (seam.labelsRead === 'failed') {
    return {
      id: 'labels',
      label: t('Labels'),
      items: [
        {
          id: LABELS_FAILED,
          label: t('The labels did not load.'),
          detail: t(isReachable() ? SERVER_CAUSE : UNREACHABLE_CAUSE),
          disabled: true,
        },
        { id: TRY_AGAIN, label: t('Try again') },
      ],
      onAction: (key) => {
        if (key === TRY_AGAIN) seam.readLabels();
      },
    };
  }

  const chosen = seam.labels
    .map((label) => label.id)
    .filter((id) => tasks.every((task) => task.labels.some((label) => label.id === id)));

  return {
    id: 'labels',
    label: t('Labels'),
    choice: 'multiple',
    checked: chosen,
    items:
      seam.labelsRead === 'loading'
        ? [{ id: LABELS_LOADING, label: t('Loading…'), disabled: true }]
        : [
            ...seam.labels.map((label) => ({ id: label.id, label: label.name, swatch: label.color })),
            ...(seam.canAddLabel ? [{ id: NEW_LABEL, label: t('New label…'), closes: true }] : []),
            ...(seam.labels.length === 0 && !seam.canAddLabel
              ? [{ id: NONE, label: t('No label yet'), detail: t('An owner or an admin adds them.'), disabled: true }]
              : []),
          ],
    onAction: (key) => {
      if (key === NEW_LABEL) return actions.newLabel();
      settle(actions.change(chosen.includes(key) ? { removeLabels: [key] } : { addLabels: [key] }));
    },
  };
}

/**
 * The submenu « Assignee » (FRU-673): « Nobody » and the members, once they are read. A read that
 * failed says so, with « Try again », and never shows a menu with nobody in it.
 */
function assigneeBranch(
  seam: TaskMenuSeam,
  checked: readonly string[],
  give: (assignee: string | null) => void,
): TreeBranch {
  if (seam.peopleRead === 'failed') {
    return {
      id: 'assignee',
      label: t('Assignee'),
      items: [
        {
          id: MEMBERS_FAILED,
          label: t('The members did not load.'),
          detail: t(isReachable() ? SERVER_CAUSE : UNREACHABLE_CAUSE),
          disabled: true,
        },
        { id: TRY_AGAIN, label: t('Try again') },
      ],
      onAction: (key) => {
        if (key === TRY_AGAIN) seam.readPeople();
      },
    };
  }

  return {
    id: 'assignee',
    label: t('Assignee'),
    choice: 'single',
    checked,
    items: [
      { id: NONE, label: t('Nobody') },
      ...(seam.peopleRead === 'loading'
        ? [{ id: MEMBERS_LOADING, label: t('Loading…'), disabled: true }]
        : seam.people.map((person) => ({ id: person.id, label: person.name }))),
    ],
    onAction: (key) => give(key === NONE ? null : key),
  };
}

/** What the screen of the notes gives every menu of a task: the people, the labels, the writes. */
export type TaskMenuSeam = {
  /** The members a task can be given to: none until they are read (`peopleRead`). */
  people: readonly TaskPerson[];
  /** FRU-673: whether the members were read. `failed`: the menus say so, with « Try again ». */
  peopleRead: 'loading' | 'failed' | 'read';
  /** FRU-673: reads the members again, for « Try again ». */
  readPeople: () => void;
  /** The labels of the workspace: none until they are read (`labelsRead`). */
  labels: readonly TaskLabel[];
  /** FRU-675: whether the labels were read. `failed`: the menus say so, with « Try again ». */
  labelsRead: 'loading' | 'failed' | 'read';
  /** FRU-675: reads the labels again, for « Try again ». */
  readLabels: () => void;
  canAddLabel: boolean;
  statusesOf: (note: IndexedNote) => readonly StatusChoice[] | undefined;
  actionsOf: (note: IndexedNote) => TaskActions;
  /** FRU-656: the writes of several tasks at once, in one call each; of one task, its own. */
  actionsOfAll: (notes: readonly IndexedNote[]) => TaskActions;
  /** FRU-653: opens the page of a task, from its text. Absent: the text opens nothing. */
  openTask?: (note: IndexedNote) => void;
};

/** The text of a note in a row or a card: a link to the page of its task, when there is one (FRU-653). */
export function NoteText({ note, children }: { note: IndexedNote; children: ReactNode }) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  if (seam?.openTask === undefined) return <>{children}</>;
  const open = seam.openTask;

  return (
    // The text it shows is its name: a name of its own would not be the words a person sees (WCAG 2.5.3).
    <LinkButton onClick={() => open(note)}>{children}</LinkButton>
  );
}

export const TaskMenuContext = createContext<TaskMenuSeam | undefined>(undefined);

/** The words of « Delete… » asked again (FRU-665), for one note or several (FRU-656). */
export function deleteWords(count: number): { confirmLabel: string; consequence: string } {
  return count === 1
    ? {
        confirmLabel: t('Delete this note'),
        consequence: t('The note, its replies and its labels go for good. Nobody can bring them back.'),
      }
    : {
        confirmLabel: t('Delete {count} notes', { count }),
        consequence: t('The {count} notes, their replies and their labels go for good. Nobody can bring them back.', {
          count,
        }),
      };
}

/**
 * The menu of one task, for a row or a card (FRU-654): its button, its last refusal, and the handlers
 * that open it on a right click (`contextmenu`, which a long press of Android sends too) and on the
 * key of the menu or Shift+F10. A right click on a link keeps the menu of the browser. Every note
 * offers its link; a note the worker keeps, that this person may change, offers its fields too.
 *
 * FRU-656: on a task of a selection of several, the menu acts on the tasks of the selection this
 * person may change, all at once; one note's own items (its place, its link) are not offered there.
 */
export function useTaskMenu(note: IndexedNote): {
  menu: ReactNode;
  problem: string | undefined;
  /** FRU-665: « Delete… » asks again under the note, with the words of `Confirmation`. */
  confirm: ReactNode;
  onContextMenu: (event: MouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
} {
  useLocale();
  const seam = useContext(TaskMenuContext);
  const selection = useContext(TaskSelectionContext);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  if (seam === undefined) {
    return { menu: null, problem: undefined, confirm: null, onContextMenu: () => {}, onKeyDown: () => {} };
  }
  const editable = isEditable(note);
  const group =
    selection !== undefined && selection.has(note.id) && selection.notes.length > 1
      ? selection.notes.filter(isEditable)
      : [];
  // A selection where this person may change nothing: the menu of the note alone.
  const several = group.length > 0;
  const targets = several ? group : [note];
  const given = several ? seam.actionsOfAll(group) : seam.actionsOf(note);
  // The dialog of a new label opens over the screen: the menu closes first, or it would stay above it.
  const actions = {
    ...given,
    newLabel: () => {
      setOpen(false);
      given.newLabel();
    },
  };
  const settle = (done: Promise<string | undefined>) => {
    setProblem(undefined);
    void done.then(setProblem);
  };
  const archived = targets.every((each) => each.task?.archived === true);
  const changes = several || editable;

  return {
    menu: (
      <MenuTree
        triggerLabel={
          several
            ? t('Actions of the {count} selected notes', { count: selection?.notes.length ?? 0 })
            : t('Actions of this note')
        }
        open={open}
        onOpenChange={setOpen}
        branches={changes ? branchesOf(targets, seam, actions, settle) : []}
        items={[
          ...(!several && editable && actions.moveUp !== undefined ? [{ id: 'up', label: t('Move up') }] : []),
          ...(!several && editable && actions.moveDown !== undefined ? [{ id: 'down', label: t('Move down') }] : []),
          ...(changes ? [{ id: 'archive', label: archived ? t('Bring back') : t('Archive') }] : []),
          ...(several ? [] : [{ id: 'copy', label: t('Copy the link to the note') }]),
          ...(changes ? [{ id: 'delete', label: t('Delete…'), danger: true }] : []),
        ]}
        onAction={(id) => {
          if (id === 'copy') actions.copyLink?.();
          if (id === 'up' && actions.moveUp !== undefined) settle(actions.moveUp());
          if (id === 'down' && actions.moveDown !== undefined) settle(actions.moveDown());
          if (id === 'archive') settle(actions.archive(!archived));
          if (id === 'delete') setDeleting(true);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </MenuTree>
    ),
    problem,
    confirm: deleting ? (
      <Confirmation
        {...deleteWords(targets.length)}
        onKeep={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          settle(actions.remove());
        }}
      />
    ) : null,
    onContextMenu: (event) => {
      if (event.target instanceof Element && event.target.closest('a, input, textarea') !== null) return;
      event.preventDefault();
      setOpen(true);
    },
    onKeyDown: (event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      setOpen(true);
    },
  };
}
