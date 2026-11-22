import { type KeyboardEvent, type MouseEvent, type ReactNode, createContext, useContext, useState } from 'react';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { type StatusChoice, statusName } from '../note-status';
import { STAGE_NAMES, type Stage } from '../stages';
import { MenuTree, type TreeBranch } from '../ui';
import { type IndexedNote, type TaskFields } from './notes-model';

export type TaskLabel = { id: string; name: string; color: string };
export type TaskPerson = { id: string; name: string };
export type TaskChange = {
  assignee?: string | null;
  priority?: TaskFields['priority'] | null;
  dueOn?: string | null;
  labels?: string[];
};

/** What the menu of a task does: each write answers a refusal to say, or `undefined` once saved. */
export type TaskActions = {
  setStatus: (status: string) => Promise<string | undefined>;
  change: (change: TaskChange) => Promise<string | undefined>;
  newLabel: () => void;
  copyLink: () => void;
};

type Priority = NonNullable<TaskFields['priority']>;
const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low'];
const NONE = 'none';
const NEW_LABEL = 'new-label';
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

/**
 * The submenus of a task the worker keeps, that this person may change (FRU-654): its status, its
 * assignee, its priority, its day and its labels, each with its current value checked. A change is
 * saved at once; its refusal goes to `settle`.
 */
function branchesOf(
  note: IndexedNote,
  task: TaskFields,
  seam: TaskMenuSeam,
  actions: TaskActions,
  settle: (done: Promise<string | undefined>) => void,
): TreeBranch[] {
  const statuses = seam.statusesOf(note)?.filter((status) => status.hidden !== true) ?? [];
  const chosen = task.labels.map((label) => label.id);
  const labelItems = [
    ...seam.labels.map((label) => ({ id: label.id, label: label.name, swatch: label.color })),
    ...(seam.canAddLabel ? [{ id: NEW_LABEL, label: t('New label…') }] : []),
    ...(seam.labels.length === 0 && !seam.canAddLabel
      ? [{ id: NONE, label: t('No label yet'), detail: t('An owner or an admin adds them.'), disabled: true }]
      : []),
  ];

  return [
    ...(statuses.length === 0
      ? []
      : [
          {
            id: 'status',
            label: t('Status'),
            choice: 'single' as const,
            checked: note.status === undefined ? [] : [note.status],
            items: statuses.map((status) => ({ id: status.key, label: statusName(status, stageName) })),
            onAction: (key: string) => settle(actions.setStatus(key)),
          },
        ]),
    {
      id: 'assignee',
      label: t('Assignee'),
      choice: 'single',
      checked: [task.assignee?.id ?? NONE],
      items: [
        { id: NONE, label: t('Nobody') },
        ...seam.people.map((person) => ({ id: person.id, label: person.name })),
      ],
      onAction: (key) => settle(actions.change({ assignee: key === NONE ? null : key })),
    },
    {
      id: 'priority',
      label: t('Priority'),
      choice: 'single',
      checked: [task.priority ?? NONE],
      items: [
        ...PRIORITIES.map((priority) => ({ id: priority, label: priorityWord(priority) })),
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
    {
      id: 'labels',
      label: t('Labels'),
      choice: 'multiple',
      checked: chosen,
      items: labelItems,
      onAction: (key) => {
        if (key === NEW_LABEL) return actions.newLabel();
        const next = new Set(chosen);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        settle(actions.change({ labels: [...next] }));
      },
    },
  ];
}

/** What the screen of the notes gives every menu of a task: the people, the labels, the writes. */
export type TaskMenuSeam = {
  people: readonly TaskPerson[];
  labels: readonly TaskLabel[];
  canAddLabel: boolean;
  statusesOf: (note: IndexedNote) => readonly StatusChoice[] | undefined;
  actionsOf: (note: IndexedNote) => TaskActions;
};

export const TaskMenuContext = createContext<TaskMenuSeam | undefined>(undefined);

/**
 * The menu of one task, for a row or a card (FRU-654): its button, its last refusal, and the handlers
 * that open it on a right click (`contextmenu`, which a long press of Android sends too) and on the
 * key of the menu or Shift+F10. A right click on a link keeps the menu of the browser. Every note
 * offers its link; a note the worker keeps, that this person may change, offers its fields too.
 */
export function useTaskMenu(note: IndexedNote): {
  menu: ReactNode;
  problem: string | undefined;
  onContextMenu: (event: MouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
} {
  useLocale();
  const seam = useContext(TaskMenuContext);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  if (seam === undefined) return { menu: null, problem: undefined, onContextMenu: () => {}, onKeyDown: () => {} };
  const given = seam.actionsOf(note);
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
  const editable = note.canSetStatus === true && note.task !== undefined;

  return {
    menu: (
      <MenuTree
        triggerLabel={t('Actions of this note')}
        open={open}
        onOpenChange={setOpen}
        branches={editable && note.task !== undefined ? branchesOf(note, note.task, seam, actions, settle) : []}
        items={[{ id: 'copy', label: t('Copy the link to the note') }]}
        onAction={(id) => {
          if (id === 'copy') actions.copyLink();
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
