import { type ReactNode, useEffect, useState } from 'react';
import { type SiteChoice, call } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { type StatusChoice, statusName } from '../note-status';
import { STAGE_NAMES, type Stage } from '../stages';
import { Button, Checks, Choice, Dialog, Field, Problem, TextBox } from '../ui';
import { useLocale } from '../use-locale';
import type { TaskLabel, TaskPerson } from './task-menu';

/** The longest title and text the worker takes (`TASK_TITLE_MAX_LENGTH`, `NOTE_MAX_LENGTH`). */
const TITLE_LENGTH = 200;
const TEXT_LENGTH = 5_000;
const NONE = 'none';

/** The sentence for a task the worker did not write (FRU-657). */
const CREATE_PROBLEMS: Readonly<Record<string, string>> = {
  'tasks-off': msg('This server keeps no task: write the task in the tracker of the site.'),
  'not-found': msg('This site is no longer here. Reload the page.'),
  'status-changed': msg('This status was removed since the list was read. Reload the page.'),
  'status-hidden': msg('This status is hidden on its site. Choose another one.'),
  'not-member': msg('This person is no longer a member of the workspace. Reload the page.'),
  'unknown-label': msg('This label was removed since the list was read. Reload the page.'),
};
const NOT_CREATED = msg('The task was not created. Try again.');

/** Where « New task » was pressed: the head of the list, or the column of a status of the board. */
export type NewTaskAsk = { site?: string; status?: string };

type Draft = {
  title: string;
  text: string;
  site: string;
  status: string;
  assignee: string;
  priority: string;
  dueOn: string;
  labels: string[];
};

const EMPTY: Draft = {
  title: '',
  text: '',
  site: '',
  status: '',
  assignee: NONE,
  priority: NONE,
  dueOn: '',
  labels: [],
};

/**
 * « New task » (FRU-657): a dialog that writes a task by hand, with no page and no pin, in a site of
 * the workspace. A title, and the rest if the person likes: a text, the site, a status and the fields
 * of a task. `POST …/notes` writes it; the list is read again, and the task opens in its panel.
 *
 * **What is typed stays until the task is written**: a refusal, Escape or « Cancel » keep the draft,
 * and the next « New task » finds it. The column it is asked from gives its status, the filter of the
 * list or the only site gives the site.
 */
export function useTaskCreate({
  base,
  sites,
  siteInView,
  statusesOf,
  people,
  labels,
  onCreated,
}: {
  base: string;
  sites: readonly SiteChoice[];
  /** The site of the filter, or the only one. */
  siteInView: string | undefined;
  /** The statuses of the worker's store of a site, when the list read them. */
  statusesOf: (site: string) => readonly StatusChoice[] | undefined;
  people: readonly TaskPerson[];
  labels: readonly TaskLabel[];
  /** The id of the task written, for the list to read again and open. */
  onCreated: (id: string) => void;
}): { open: (ask?: NewTaskAsk) => void; isOpen: boolean; dialog: ReactNode } {
  useLocale();
  const [isOpen, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [titleMissing, setTitleMissing] = useState(false);

  // A site that is no longer offered leaves the draft: the choice shows the first one.
  const site = sites.some((one) => one.id === draft.site) ? draft.site : (siteInView ?? sites[0]?.id ?? '');
  const statuses = (statusesOf(site) ?? []).filter((status) => status.hidden !== true);
  // The status asked, when the site has it or the list did not read its statuses (a column of a
  // stage asks for its built-in status); else the first status of the site, or none.
  const status =
    draft.status !== '' && (statuses.length === 0 || statuses.some((one) => one.key === draft.status))
      ? draft.status
      : (statuses[0]?.key ?? '');
  useEffect(() => {
    if (!isOpen) setTitleMissing(false);
  }, [isOpen]);

  const set = <Field extends keyof Draft>(field: Field, value: Draft[Field]) =>
    setDraft((was) => ({ ...was, [field]: value }));

  const open = (ask: NewTaskAsk = {}) => {
    setProblem(undefined);
    setDraft((was) => ({
      ...was,
      ...(ask.site === undefined ? {} : { site: ask.site }),
      ...(ask.status === undefined ? {} : { status: ask.status }),
    }));
    setOpen(true);
  };

  async function save() {
    const title = draft.title.replace(/\s+/gu, ' ').trim();
    if (title === '') {
      setTitleMissing(true);
      return;
    }
    setSaving(true);
    setProblem(undefined);
    const answer = await call<{ id: string; identifier: string }>('POST', `${base}/notes`, {
      site,
      title,
      ...(draft.text.trim() === '' ? {} : { text: draft.text }),
      ...(status === '' ? {} : { status }),
      ...(draft.assignee === NONE ? {} : { assignee: draft.assignee }),
      ...(draft.priority === NONE ? {} : { priority: draft.priority }),
      ...(draft.dueOn === '' ? {} : { dueOn: draft.dueOn }),
      ...(draft.labels.length === 0 ? {} : { labels: draft.labels }),
    });
    setSaving(false);
    if (!answer.ok) {
      setProblem(problemOf(answer, CREATE_PROBLEMS, NOT_CREATED));
      return;
    }
    // Written: the draft goes, the site and the status stay for the next task.
    setDraft((was) => ({ ...EMPTY, site: was.site, status: was.status }));
    setOpen(false);
    onCreated(answer.data.id);
  }

  const stageName = (stage: Stage) => t(STAGE_NAMES[stage]);
  const dialog = (
    <Dialog open={isOpen} onClose={() => setOpen(false)} title={t('New task')} closeLabel={t('Close')} size="md">
      <form
        className="flex flex-col gap-[16px]"
        data-task-create=""
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void save();
        }}
      >
        <Field
          label={t('Title')}
          value={draft.title}
          onChange={(event) => {
            set('title', event.target.value);
            setTitleMissing(false);
          }}
          maxLength={TITLE_LENGTH}
          required
          autoFocus
          {...(titleMissing ? { error: t('Give the task a title.') } : {})}
        />
        <TextBox
          label={t('Text')}
          hint={t('Optional. What to do, for a person or an agent.')}
          value={draft.text}
          onChange={(text) => set('text', text)}
          maxLength={TEXT_LENGTH}
        />
        {sites.length < 2 ? null : (
          <Choice
            label={t('Site')}
            value={site}
            onChange={(chosen) => set('site', chosen)}
            options={sites.map((one) => ({ value: one.id, label: one.origin }))}
          />
        )}
        <div className="grid gap-[16px] sm:grid-cols-2">
          {statuses.length === 0 ? null : (
            <Choice
              label={t('Status')}
              value={status}
              onChange={(chosen) => set('status', chosen)}
              options={statuses.map((one) => ({
                value: one.key,
                label: statusName(one, stageName),
                drop: { status: one.stage, ...(one.color === undefined ? {} : { color: one.color }) },
              }))}
            />
          )}
          <Choice
            label={t('Assignee')}
            value={draft.assignee}
            onChange={(chosen) => set('assignee', chosen)}
            options={[
              { value: NONE, label: t('Nobody') },
              ...people.map((person) => ({ value: person.id, label: person.name })),
            ]}
          />
          <Choice
            label={t('Priority')}
            value={draft.priority}
            onChange={(chosen) => set('priority', chosen)}
            options={[
              { value: 'urgent', label: t('Urgent') },
              { value: 'high', label: t('High') },
              { value: 'medium', label: t('Medium') },
              { value: 'low', label: t('Low') },
              { value: NONE, label: t('No priority') },
            ]}
          />
          <Field
            label={t('Due day')}
            type="date"
            value={draft.dueOn}
            onChange={(event) => set('dueOn', event.target.value)}
          />
        </div>
        {labels.length === 0 ? null : (
          <Checks
            label={t('Labels')}
            value={draft.labels}
            onChange={(chosen) => set('labels', chosen)}
            options={labels.map((label) => ({ value: label.id, label: label.name }))}
          />
        )}
        <p className="text-hint text-muted">{t('A task has no page and no pin. It is kept in Fruitback.')}</p>
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        <div className="flex flex-wrap justify-end gap-[12px]">
          <Button tone="outline" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={saving || site === ''}>
            {saving ? t('Creating…') : t('Create the task')}
          </Button>
        </div>
      </form>
    </Dialog>
  );

  return { open, isOpen, dialog };
}

/**
 * The key « C » opens « New task » (FRU-657), as in Linear: a key alone, with no modifier, out of a
 * field, and when no dialog, menu or panel is open. Answers whether it took the key.
 */
export function isNewTaskKey(event: KeyboardEvent): boolean {
  if (event.key !== 'c' && event.key !== 'C') return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) {
    return false;
  }
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]') !== null
  ) {
    return false;
  }

  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') === null;
}
