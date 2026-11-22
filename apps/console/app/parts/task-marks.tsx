import { dayIn } from '../ago';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { type TaskFields } from './notes-model';

// Each sentence is written out, so the guard of the catalogue finds it.
const PRIORITY_WORDS = {
  low: () => t('Low'),
  medium: () => t('Medium'),
  high: () => t('High'),
  urgent: () => t('Urgent'),
} as const;

/**
 * The fields of a task the worker keeps (FRU-652), under its text in a row and on a card: the
 * priority, the day, who does it, and the labels. Nothing for a task with no field set.
 */
export function TaskMarks({ task, className = '' }: { task: TaskFields | undefined; className?: string }) {
  useLocale();
  if (task === undefined) return null;
  const { assignee, priority, dueOn, labels } = task;
  if (assignee === undefined && priority === undefined && dueOn === undefined && labels.length === 0) return null;
  // Noon of the day: the day stays the same in every zone of the browser.
  const due = dueOn === undefined ? undefined : dayIn(`${dueOn}T12:00:00`);

  return (
    <span
      className={`flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-hint text-muted ${className}`}
      data-task-marks=""
    >
      {priority === undefined ? null : (
        <span className={priority === 'urgent' ? 'font-semibold text-accent' : undefined}>
          {PRIORITY_WORDS[priority]()}
        </span>
      )}
      {due === undefined ? null : <span>{t('Due {day}', { day: due })}</span>}
      {assignee === undefined ? null : <span>{t('Assigned to {name}', { name: assignee.name || t('a member') })}</span>}
      {labels.map((label) => (
        <span key={label.id} className="inline-flex items-center gap-[6px]">
          <span aria-hidden="true" className="kit-swatch kit-swatch-small" style={{ background: label.color }} />
          {label.name}
        </span>
      ))}
    </span>
  );
}
