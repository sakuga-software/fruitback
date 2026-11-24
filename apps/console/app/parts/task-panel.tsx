import { type NoteIssue, type TaskIssue, anchorSelectorPath } from '@fruitback/shared';
import { useContext, useEffect, useState } from 'react';
import { call } from '../api';
import { ago } from '../ago';
import { t } from '../i18n';
import { NoteIcon } from '../note-icons';
import { statusName } from '../note-status';
import { STAGE_NAMES, type Stage } from '../stages';
import { Button, Checks, Choice, Drawer, Field, IconLink, KeyValue, LoadFailed, Problem } from '../ui';
import { ReadProblem } from '../read-problem';
import { useLocale } from '../use-locale';
import { type IndexedNote } from './notes-model';
import { TaskMenuContext } from './task-menu';
import { siteOfId } from '../note-id';

const NONE = 'none';
const stageName = (stage: Stage) => t(STAGE_NAMES[stage]);

/**
 * The page of a task (FRU-653): a panel over the list, opened from the text of a note, its address
 * `?task=<id>`. It reads the whole note (`GET …/notes/<note>`): its text, its page, its element and
 * its replies. A task Fruitback keeps, that this person may change, shows its fields as controls, which
 * save at once, as the menu does; any other note shows them as words.
 */
export function TaskPanel({
  id,
  listed,
  base,
  onClose,
}: {
  id: string | undefined;
  /** The row of the list, when the note is on this page: its fields, its status and its rights. */
  listed: IndexedNote | undefined;
  base: string;
  onClose: () => void;
}) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  // Each answer names the note it is of: a panel opened on another note shows no answer of the one before.
  const [answer, setAnswer] = useState<{ of: string; value: NoteIssue | TaskIssue | 'failed' | 'gone' } | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  // « Try again » asks again: the read follows this count, as it follows the note.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (id === undefined) return;
    let current = true;
    setAnswer(undefined);
    setProblem(undefined);
    // FRU-657: a task written by hand reads as `{ task }`, a note of a page as `{ note }`.
    void call<{ note: NoteIssue } | { task: TaskIssue }>('GET', `${base}/notes/${encodeURIComponent(id)}`).then(
      (got) => {
        if (!current) return;
        if (got.ok) setAnswer({ of: id, value: 'task' in got.data ? got.data.task : got.data.note });
        else setAnswer({ of: id, value: got.status === 404 ? 'gone' : 'failed' });
      },
    );

    return () => {
      current = false;
    };
  }, [id, base, attempt]);

  const read = answer !== undefined && answer.of === id ? answer.value : 'loading';
  const written = typeof read === 'object' && 'task' in read ? read : undefined;
  const issue = typeof read === 'object' && 'note' in read ? read : undefined;
  const replies = (written ?? issue)?.comments;
  const title = written?.task.title ?? issue?.note.text.split('\n')[0] ?? listed?.excerpt ?? t('Note');
  // FRU-658: what « Copy » names. The reference of the list, else the one the read gives, when it is a
  // reference (`FB-12`) and not the id a guest reads in its place.
  const reference = listed?.ref ?? (written ?? issue)?.identifier;
  const copied =
    id === undefined
      ? undefined
      : {
          id,
          site: listed?.site ?? { id: siteOfId(id) },
          ...(reference !== undefined && /^[A-Z][A-Z0-9]*-\d+$/u.test(reference) ? { ref: reference } : {}),
        };

  return (
    <Drawer
      open={id !== undefined}
      onClose={onClose}
      title={title}
      closeLabel={t('Close')}
      head={
        (written ?? issue) === undefined ? null : (
          <div className="flex flex-col gap-[8px]">
            <p className="text-hint text-muted tabular-nums" data-task-reference="">
              {(written ?? issue)?.identifier}
            </p>
            {seam?.copy === undefined || copied === undefined ? null : (
              <div className="flex flex-wrap gap-[8px]" data-task-copy="">
                <Button tone="outline" size="small" onClick={() => seam.copy?.link([copied])}>
                  {t('Copy the link')}
                </Button>
                {copied.ref === undefined ? null : (
                  <Button tone="outline" size="small" onClick={() => seam.copy?.identifier([copied])}>
                    {t('Copy the ID')}
                  </Button>
                )}
                <Button tone="outline" size="small" onClick={() => seam.copy?.markdown([copied])}>
                  {t('Copy as Markdown')}
                </Button>
              </div>
            )}
          </div>
        )
      }
    >
      {read === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {read === 'gone' ? <p className="text-body text-muted">{t('This note is no longer here.')}</p> : null}
      {read === 'failed' ? (
        <LoadFailed
          title={t('The note did not load')}
          detail={t('Fruitback hit an error. Try again in a moment.')}
          retry={t('Try again')}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : null}
      {written === undefined ? null : (
        <>
          {written.task.text === undefined ? (
            <p className="text-body text-muted" data-task-text="">
              {t('No text.')}
            </p>
          ) : (
            <p className="text-body text-ink whitespace-pre-wrap [overflow-wrap:anywhere]" data-task-text="">
              {written.task.text}
            </p>
          )}
          {listed === undefined || seam === undefined ? null : <TaskFieldsForm note={listed} onProblem={setProblem} />}
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          <p className="text-small text-muted">{t('Written by hand: no page and no pin.')}</p>
          <Replies comments={replies} />
        </>
      )}
      {issue === undefined ? null : (
        <>
          <p className="text-body text-ink whitespace-pre-wrap [overflow-wrap:anywhere]" data-task-text="">
            {issue.note.text}
          </p>
          {listed === undefined || seam === undefined ? null : <TaskFieldsForm note={listed} onProblem={setProblem} />}
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          <section className="flex flex-col gap-[8px]">
            <h3 className="text-small font-semibold">{t('On the page')}</h3>
            <span className="inline-flex items-center gap-[8px]">
              <span className="min-w-0 truncate text-small">{issue.note.page.url}</span>
              <IconLink
                label={t('Show on the page')}
                href={`${issue.note.page.url}#fruitback-note=${encodeURIComponent(issue.note.id)}`}
                tip={issue.note.page.url}
              >
                <NoteIcon name="open" />
              </IconLink>
            </span>
            <KeyValue
              rows={[
                { term: t('Element'), value: <code>{anchorSelectorPath(issue.note.anchor)}</code> },
                ...(issue.note.source?.component === undefined
                  ? []
                  : [{ term: t('Component'), value: <code>{issue.note.source.component}</code> }]),
                ...(issue.note.source?.file === undefined
                  ? []
                  : [
                      {
                        term: t('File'),
                        value: (
                          <code>
                            {issue.note.source.file}
                            {issue.note.source.line === undefined ? '' : `:${issue.note.source.line}`}
                          </code>
                        ),
                      },
                    ]),
                {
                  term: t('Screen'),
                  value: `${issue.note.viewport.width} × ${issue.note.viewport.height}`,
                },
              ]}
            />
          </section>
          <Replies comments={replies} />
        </>
      )}
    </Drawer>
  );
}

/** The replies of a note or a task, oldest first. */
function Replies({ comments }: { comments: NoteIssue['comments'] }) {
  useLocale();

  return (
    <section className="flex flex-col gap-[12px]" data-task-replies="">
      <h3 className="text-small font-semibold">
        {t('Replies')} <span className="font-normal text-muted">{comments?.length ?? 0}</span>
      </h3>
      {(comments ?? []).length === 0 ? (
        <p className="text-small text-muted">{t('No reply yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-[12px]">
          {(comments ?? []).map((comment) => (
            <li key={comment.id} className="flex flex-col gap-[2px]">
              <span className="text-hint text-muted">
                {comment.author ?? t('Somebody of the workspace')} · {ago(comment.createdAt)}
              </span>
              <span className="text-small whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The fields of a task, as controls that save at once, or as words for whoever may not change them. */
function TaskFieldsForm({ note, onProblem }: { note: IndexedNote; onProblem: (problem: string | undefined) => void }) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  if (seam === undefined || note.task === undefined) return null;
  const task = note.task;
  const editable = note.canSetStatus === true;
  const actions = seam.actionsOf(note);
  const settle = async (done: Promise<string | undefined>) => {
    onProblem(undefined);
    onProblem(await done);
  };
  const statuses = seam.statusesOf(note)?.filter((status) => status.hidden !== true) ?? [];

  return (
    <section className="flex flex-col gap-[16px]" data-task-fields="">
      {statuses.length === 0 || note.status === undefined ? null : (
        <Choice
          label={t('Status')}
          value={note.status}
          disabled={!editable}
          onChange={(status) => void settle(actions.setStatus(status))}
          options={statuses.map((status) => ({ value: status.key, label: statusName(status, stageName) }))}
        />
      )}
      <Choice
        label={t('Assignee')}
        value={task.assignee?.id ?? NONE}
        disabled={!editable}
        onChange={(assignee) => void settle(actions.change({ assignee: assignee === NONE ? null : assignee }))}
        options={[
          { value: NONE, label: t('Nobody') },
          ...seam.people.map((person) => ({ value: person.id, label: person.name })),
          // The assignee of a task stays offered, even when the list of the members no longer has them.
          ...(task.assignee === undefined || seam.people.some((person) => person.id === task.assignee?.id)
            ? []
            : [{ value: task.assignee.id, label: task.assignee.name || t('a member') }]),
        ]}
      />
      {/* FRU-673: the members did not load, so the field offers none of them: it says so. */}
      {editable && seam.peopleRead === 'failed' ? (
        <div className="flex flex-col items-start gap-[8px]" data-task-people-failed="">
          <Problem>
            {t('The members did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={seam.readPeople}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      <Choice
        label={t('Priority')}
        value={task.priority ?? NONE}
        disabled={!editable}
        onChange={(priority) =>
          void settle(
            actions.change({
              priority: priority === NONE ? null : (priority as NonNullable<typeof task.priority>),
            }),
          )
        }
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
        value={task.dueOn ?? ''}
        disabled={!editable}
        onChange={(event) => {
          const day = event.target.value;
          void settle(actions.change({ dueOn: day === '' ? null : day }));
        }}
      />
      {/* FRU-675: the labels did not load, so the field has none to offer: it says so, to whoever reads it. */}
      {seam.labelsRead === 'failed' ? (
        <div className="flex flex-col items-start gap-[8px]" data-task-labels-failed="">
          <Problem>
            {t('The labels did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={seam.readLabels}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {seam.labels.length === 0 ? null : (
        <Checks
          label={t('Labels')}
          value={task.labels.map((label) => label.id)}
          onChange={(labels) => {
            if (editable) void settle(actions.change({ labels }));
          }}
          options={seam.labels.map((label) => ({ value: label.id, label: label.name, disabled: !editable }))}
        />
      )}
    </section>
  );
}
