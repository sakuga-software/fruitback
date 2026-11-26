import { type NoteIssue, type TaskIssue, anchorSelectorPath } from '@fruitback/shared';
import { composes, elementsOf, typedInField } from '../keys';
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { type Connector, call } from '../api';
import { ago } from '../ago';
import { ConnectorMark } from '../connector-marks';
import { t } from '../i18n';
import { NoteIcon } from '../note-icons';
import { statusName } from '../note-status';
import { STAGE_NAMES, type Stage } from '../stages';
import {
  Button,
  Checks,
  Choice,
  Field,
  IconButton,
  IconLink,
  KeyValue,
  LoadFailed,
  Mark,
  Menu,
  Problem,
  StatusDot,
} from '../ui';
import { ReadProblem } from '../read-problem';
import { useLocale } from '../use-locale';
import { hostOf } from '../site-address';
import { browserOf } from '../browser-name';
import { type IndexedNote, type NotePlace } from './notes-model';
import { KINDS, connectorName } from './connector-parts';
import { TaskMenuContext } from './task-menu';
import { siteOfId } from '../note-id';

const NONE = 'none';
const stageName = (stage: Stage) => t(STAGE_NAMES[stage]);

/** A key the panel takes (FRU-687): not in a field, a list that is open, a menu, or another dialog. */
function keyOfPanel(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  // Through every Shadow root (FRU-726): a key of the widget's fields or dialogs is the widget's.
  const path = elementsOf(event);
  if (path.some((each) => ['listbox', 'menu', 'alertdialog'].includes(each.getAttribute('role') ?? ''))) return false;
  if (path.some((each) => each !== panel && each.getAttribute('role') === 'dialog')) return false;

  // Any input keeps its arrows, a group of radios included.
  return !typedInField(event) && !path.some((each) => each.tagName === 'INPUT');
}

/**
 * The page of a task (FRU-653), in a panel of 440 px beside the list (FRU-687): the list stays in
 * view, its row marked, and the arrows go to the note above or under it. Opened from the text of a
 * note, its address `?task=<id>`. It reads the whole note (`GET …/notes/<note>`): its text, its page,
 * its element and its replies. Its fields first, as lines of 32 px; the page in a picture; the replies;
 * and « Technical details » folded at the end, so that no selector is a press away from the list.
 *
 * Not modal: a press in the list leaves the panel open. Escape closes it, and the focus goes back to
 * the row. Under 1024 px it takes the whole width, over the list.
 */
export function TaskPanel({
  id,
  listed,
  base,
  source,
  origin,
  previous,
  next,
  onStep,
  onClose,
}: {
  id: string | undefined;
  /** The row of the list, when the note is on this page: its fields, its status and its rights. */
  listed: IndexedNote | undefined;
  base: string;
  /** The connector the note went to, when the connectors were read. */
  source: Connector | undefined;
  /** The origin of the site of the note, when the sites were read. */
  origin: string | undefined;
  /** The notes above and under it in the list, for the arrows. */
  previous: IndexedNote | undefined;
  next: IndexedNote | undefined;
  onStep: (note: IndexedNote) => void;
  onClose: () => void;
}) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
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

  // Opened, the panel takes the focus, so that the keyboard reads it at once.
  const open = id !== undefined;
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  // Escape closes; the arrows go to the note above or under it (FRU-687). On the document, before
  // the keys of the selection on the window: Escape closes the panel first, and clears nothing else.
  const keys = useRef({ previous, next, onStep, onClose });
  keys.current = { previous, next, onStep, onClose };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || composes(event)) return;
      // A control that has its list or its picker open takes Escape and the arrows first (raised in review).
      if (event.target instanceof Element && event.target.closest('[aria-expanded="true"]') !== null) return;
      // Escape closes the panel from a field of it too, as it closed the drawer of before.
      const field =
        event.target instanceof Element &&
        event.target.closest('input, textarea') !== null &&
        panel.current?.contains(event.target) === true;
      if (!keyOfPanel(event, panel.current) && !(field && event.key === 'Escape')) return;
      const { previous: above, next: under, onStep: step, onClose: close } = keys.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      // A closed list of the panel opens on an arrow and stops the key first: `defaultPrevented` above.
      if (event.key === 'ArrowUp' && above !== undefined) {
        event.preventDefault();
        step(above);
      } else if (event.key === 'ArrowDown' && under !== undefined) {
        event.preventDefault();
        step(under);
      }
    };
    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (id === undefined) return null;

  const read = answer !== undefined && answer.of === id ? answer.value : 'loading';
  const written = typeof read === 'object' && 'task' in read ? read : undefined;
  const issue = typeof read === 'object' && 'note' in read ? read : undefined;
  const replies = (written ?? issue)?.comments;
  const [firstLine = '', ...rest] = issue?.note.text.split('\n') ?? [];
  const title = written?.task.title ?? (issue === undefined ? undefined : firstLine) ?? listed?.excerpt ?? t('Note');
  const more = rest.join('\n').trim();
  // FRU-658: what « Copy » names. The reference of the list, else the one the read gives, when it is a
  // reference (`FB-12`) and not the id a guest reads in its place.
  const reference = listed?.ref ?? (written ?? issue)?.identifier;
  const copied = {
    id,
    site: listed?.site ?? { id: siteOfId(id) },
    ...(reference !== undefined && /^[A-Z][A-Z0-9]*-\d+$/u.test(reference) ? { ref: reference } : {}),
  };
  const place = listed?.place;
  let placeName: string | undefined;
  if (place !== undefined && place.kind !== 'fruitback' && place.kind !== 'removed')
    placeName = source === undefined ? t(KINDS[place.kind].name) : connectorName(source);
  const address = listed?.url ?? issue?.url;

  return (
    <section
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      // The panel takes the focus to be read, as a heading does: it is no control, and draws no ring.
      style={{ outline: 'none' }}
      data-task-panel=""
      className="fixed inset-y-0 right-0 z-[6] flex w-full flex-col border-l border-line bg-page shadow-frame min-[1024px]:w-[440px] min-[1024px]:shadow-none"
    >
      <header className="flex h-[44px] flex-none items-center gap-[6px] border-b border-line pr-[12px] pl-[20px]">
        <span className="flex min-w-0 items-center gap-[8px] text-small font-semibold text-ink tabular-nums">
          <PlaceMark place={place} />
          <span className="truncate" data-task-reference="">
            {(written ?? issue)?.identifier ?? listed?.ref ?? ''}
          </span>
        </span>
        {address === undefined ? null : (
          <IconLink label={t('Open in {place}', { place: placeName ?? t('the tracker') })} href={address} tip={address}>
            <NoteIcon name="open" />
          </IconLink>
        )}
        <span className="ml-auto flex items-center gap-[2px]">
          <IconButton
            label={t('Previous note')}
            size="small"
            disabled={previous === undefined}
            onClick={() => previous !== undefined && onStep(previous)}
          >
            <NoteIcon name="up" />
          </IconButton>
          <IconButton
            label={t('Next note')}
            size="small"
            disabled={next === undefined}
            onClick={() => next !== undefined && onStep(next)}
          >
            <NoteIcon name="down" />
          </IconButton>
          {seam?.copy === undefined ? null : (
            <Menu
              trigger="icon"
              triggerLabel={t('More of this note')}
              triggerClassName="size-control-sm"
              items={[
                { id: 'link', label: t('Copy the link') },
                ...(copied.ref === undefined ? [] : [{ id: 'identifier', label: t('Copy the ID') }]),
                { id: 'markdown', label: t('Copy as Markdown') },
              ]}
              onAction={(action) => {
                if (action === 'link') seam.copy?.link([copied]);
                else if (action === 'identifier') seam.copy?.identifier([copied]);
                else seam.copy?.markdown([copied]);
              }}
            >
              <NoteIcon name="more" />
            </Menu>
          )}
          <IconButton label={t('Close')} size="small" onClick={onClose}>
            <NoteIcon name="close" />
          </IconButton>
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[20px] py-[16px]">
        <h2
          id={titleId}
          className="text-conclusion font-semibold [overflow-wrap:anywhere] text-ink"
          {...(issue !== undefined && more === '' ? { 'data-task-text': '' } : {})}
        >
          {title}
        </h2>
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
        {written === undefined ? null : <TaskText text={written.task.text} />}
        {issue === undefined || more === '' ? null : (
          <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere] text-ink" data-task-text="">
            {more}
          </p>
        )}

        {read === 'loading' || read === 'failed' || read === 'gone' ? null : (
          <>
            <dl className="flex flex-col text-small" data-task-properties="">
              <Property term={t('Status')}>
                {listed !== undefined && seam !== undefined && listed.task !== undefined ? (
                  <StatusField note={listed} onProblem={setProblem} />
                ) : (
                  <span className="inline-flex items-center gap-[8px] font-medium">
                    <StatusDot status={(written ?? issue)?.stage ?? listed?.stage ?? 'new'} size={10} />
                    {(written ?? issue)?.stateName ?? stageName(listed?.stage ?? 'new')}
                  </span>
                )}
              </Property>
              {place === undefined ? null : (
                <Property term={t('Sent to')}>
                  <span className="inline-flex min-w-0 items-center gap-[6px] font-medium">
                    <PlaceMark place={place} />
                    <span className="truncate">{sentTo(place, placeName)}</span>
                  </span>
                </Property>
              )}
              {listed?.task === undefined || seam === undefined ? null : (
                <TaskFields note={listed} onProblem={setProblem} />
              )}
              {listed === undefined ? null : (
                <Property term={t('Left by')}>
                  <span className="truncate font-medium">
                    {authorWords(listed)} · {ago(listed.createdAt)}
                  </span>
                </Property>
              )}
              {issue === undefined ? null : (
                <Property term={t('Page')}>
                  <a
                    href={issue.note.page.url}
                    target="_blank"
                    rel="noreferrer"
                    title={issue.note.page.url}
                    className="truncate font-medium text-ink no-underline hover:underline hover:decoration-1 hover:underline-offset-[3px]"
                  >
                    {hostOf(origin ?? issue.note.page.url)}
                    {issue.note.page.path === '/' ? '' : issue.note.page.path}
                  </a>
                </Property>
              )}
            </dl>
            {listed?.task === undefined || seam === undefined ? null : (
              <TaskLabels note={listed} onProblem={setProblem} />
            )}
            {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
            {written === undefined ? null : (
              <p className="text-small text-muted">{t('Written by hand: no page and no pin.')}</p>
            )}
            {issue === undefined ? null : <Preview issue={issue} />}
            <Activity comments={replies} synced={placeName} />
            {issue === undefined ? null : <Technical issue={issue} />}
          </>
        )}
      </div>
    </section>
  );
}

/** The mark of where a note went: the pin of Fruitback, the logo of a tracker, nothing for a place gone. */
function PlaceMark({ place }: { place: NotePlace | undefined }) {
  if (place === undefined || place.kind === 'removed') return null;
  if (place.kind === 'fruitback') return <Mark size={14} />;

  return <ConnectorMark kind={place.kind} />;
}

/** Where a note went, in words: « Fruitback », « Linear · Acme web », or a place gone. */
function sentTo(place: NotePlace, name: string | undefined): string {
  if (place.kind === 'fruitback') return t('Fruitback');
  if (place.kind === 'removed') return t('A connector that was removed');

  return placeLine(name, place.label);
}

/** The text of a task written by hand, or « No text. ». */
function TaskText({ text }: { text: string | undefined }) {
  useLocale();
  if (text === undefined)
    return (
      <p className="text-body text-muted" data-task-text="">
        {t('No text.')}
      </p>
    );

  return (
    <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere] text-ink" data-task-text="">
      {text}
    </p>
  );
}

/** « Linear · Acme web »: the name of the place and the team or the address it took. */
function placeLine(name: string | undefined, label: string | undefined): string {
  const after = label?.split(' · ').slice(1).join(' · ');

  return [name, after === '' ? undefined : after].filter((part) => part !== undefined).join(' · ');
}

/** Who left a note, in words: a visitor, or the name of a person of the workspace. */
function authorWords(note: IndexedNote): string {
  const { author } = note;
  if (author.kind === 'verified' || author.kind === 'anonymous') return t('Visitor');

  return author.name ?? t('Somebody of the workspace');
}

/** A line of 32 px of the fields: its name in 96 px, then its value or its control. */
function Property({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[32px] items-center">
      <dt className="w-[96px] flex-none text-muted">{term}</dt>
      <dd className="m-0 flex min-w-0 flex-1 items-center text-ink">{children}</dd>
    </div>
  );
}

/**
 * The page of the note, in a picture (FRU-687): the capture with the element framed, when the note
 * has one that loads; else a frame that says there is none, and the address. No selector: « Technical
 * details » holds it. « Open on the page » opens the page at its pin.
 */
function Preview({ issue }: { issue: NoteIssue }) {
  useLocale();
  const shot = issue.note.screenshot?.url;
  const [broken, setBroken] = useState(false);
  const bounds = issue.note.anchor.bounds;
  const shown = shot !== undefined && !broken;

  return (
    <figure
      className="relative m-0 h-[150px] overflow-hidden rounded-control border border-line bg-subtle"
      data-task-preview={shown ? 'capture' : 'none'}
    >
      {shown ? (
        <>
          <img
            src={shot}
            alt={t('The page when the note was left')}
            referrerPolicy="no-referrer"
            decoding="async"
            onError={() => setBroken(true)}
            className="absolute inset-0 size-full object-cover object-left-top"
          />
          <span
            aria-hidden="true"
            className="absolute rounded-inner outline-2 outline-offset-2 outline-status-progress"
            style={{
              left: `${bounds.xPct}%`,
              top: `${bounds.yPct}%`,
              width: `${bounds.wPct}%`,
              height: `${bounds.hPct}%`,
            }}
          />
        </>
      ) : (
        <figcaption className="flex h-full flex-col items-center justify-center gap-[8px] px-[16px] text-center text-small text-muted">
          <Mark size={20} />
          <span>{t('No capture of this page.')}</span>
          <span className="max-w-full truncate text-hint">{issue.note.page.url}</span>
        </figcaption>
      )}
      <a
        href={`${issue.note.page.url}#fruitback-note=${encodeURIComponent(issue.note.id)}`}
        target="_blank"
        rel="noreferrer"
        className="absolute right-[8px] bottom-[8px] inline-flex h-control-sm items-center gap-[6px] rounded-control bg-ink/85 px-[8px] text-hint font-medium text-page no-underline hover:bg-ink [&_svg]:size-[12px]"
      >
        <NoteIcon name="open" />
        {t('Open on the page')}
      </a>
    </figure>
  );
}

/** The replies of a note or a task, oldest first, each under its round (FRU-687). */
function Activity({ comments, synced }: { comments: NoteIssue['comments']; synced: string | undefined }) {
  useLocale();
  const list = comments ?? [];

  return (
    <section className="flex flex-col gap-[12px]" data-task-replies="">
      <h3 className="flex items-center gap-[8px] text-small font-semibold">
        {t('Activity')}
        <span className="font-normal text-muted tabular-nums">{list.length}</span>
        {synced === undefined ? null : (
          <span className="ml-auto text-hint font-normal text-muted">
            {t('Synced with {place}', { place: synced })}
          </span>
        )}
      </h3>
      {list.length === 0 ? (
        <p className="text-small text-muted">{t('No reply yet.')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[14px] p-0">
          {list.map((comment) => {
            const who = comment.author ?? t('Somebody of the workspace');

            return (
              <li key={comment.id} className="flex gap-[8px]">
                <span
                  aria-hidden="true"
                  className="inline-flex size-[20px] flex-none items-center justify-center rounded-full bg-avatar text-[9px] leading-none font-semibold text-page"
                >
                  {who.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="text-hint">
                    <span className="font-semibold text-ink">{who}</span>{' '}
                    <span className="text-muted">{ago(comment.createdAt)}</span>
                  </span>
                  <span className="text-small whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What a developer reads (FRU-687): the element, the component, the file, the screen and the browser,
 * folded at the end of the panel. Its summary says the screen and the browser.
 */
function Technical({ issue }: { issue: NoteIssue }) {
  useLocale();
  const { note } = issue;
  const screen = `${note.viewport.width} × ${note.viewport.height}`;
  const browser = browserOf(note.env?.userAgent);

  return (
    <details className="group border-t border-line pt-[8px]" data-task-technical="">
      <summary className="flex h-control-md cursor-pointer list-none items-center gap-[6px] rounded-control text-hint text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[12px] flex-none group-open:rotate-90">
          <path
            d="M9 6l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {t('Technical details')}
        <span className="ml-auto tabular-nums">{browser === undefined ? screen : `${screen} · ${browser}`}</span>
      </summary>
      <KeyValue
        rows={[
          { term: t('Element'), value: <code>{anchorSelectorPath(note.anchor)}</code> },
          ...(note.source?.component === undefined
            ? []
            : [{ term: t('Component'), value: <code>{note.source.component}</code> }]),
          ...(note.source?.file === undefined
            ? []
            : [
                {
                  term: t('File'),
                  value: (
                    <code>
                      {note.source.file}
                      {note.source.line === undefined ? '' : `:${note.source.line}`}
                    </code>
                  ),
                },
              ]),
          { term: t('Screen'), value: screen },
          ...(browser === undefined ? [] : [{ term: t('Browser'), value: browser }]),
        ]}
      />
    </details>
  );
}

/** The status of a task, as a list for whoever may change it. */
function StatusField({ note, onProblem }: { note: IndexedNote; onProblem: (problem: string | undefined) => void }) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  if (seam === undefined) return null;
  const statuses = seam.statusesOf(note)?.filter((status) => status.hidden !== true) ?? [];
  if (statuses.length === 0 || note.status === undefined)
    return (
      <span className="inline-flex items-center gap-[8px] font-medium">
        <StatusDot status={note.stage} size={10} />
        {stageName(note.stage)}
      </span>
    );
  const actions = seam.actionsOf(note);

  return (
    <span className="w-[220px]">
      <Choice
        label={t('Status')}
        labelHidden
        compact
        value={note.status}
        disabled={note.canSetStatus !== true}
        onChange={(status) => {
          onProblem(undefined);
          void actions.setStatus(status).then(onProblem);
        }}
        options={statuses.map((status) => ({ value: status.key, label: statusName(status, stageName) }))}
      />
    </span>
  );
}

/**
 * The fields of a task, as lines of controls that save at once, or as words for whoever may not change
 * them: who does it, its priority and its day.
 */
function TaskFields({ note, onProblem }: { note: IndexedNote; onProblem: (problem: string | undefined) => void }) {
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

  return (
    <>
      <Property term={t('Assignee')}>
        <span className="flex w-[220px] flex-col gap-[8px]" data-task-fields="">
          <Choice
            label={t('Assignee')}
            labelHidden
            compact
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
        </span>
      </Property>
      {/* FRU-673: the members did not load, so the field offers none of them: it says so. */}
      {editable && seam.peopleRead === 'failed' ? (
        <div className="flex flex-col items-start gap-[8px] py-[8px]" data-task-people-failed="">
          <Problem>
            {t('The members did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={seam.readPeople}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      <Property term={t('Priority')}>
        <span className="w-[220px]">
          <Choice
            label={t('Priority')}
            labelHidden
            compact
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
        </span>
      </Property>
      <Property term={t('Due day')}>
        <span className="w-[220px]">
          <Field
            label={t('Due day')}
            labelHidden
            compact
            type="date"
            value={task.dueOn ?? ''}
            disabled={!editable}
            onChange={(event) => {
              const day = event.target.value;
              void settle(actions.change({ dueOn: day === '' ? null : day }));
            }}
          />
        </span>
      </Property>
    </>
  );
}

/** The labels of a task, under its fields: a list of boxes does not hold in a line. */
function TaskLabels({ note, onProblem }: { note: IndexedNote; onProblem: (problem: string | undefined) => void }) {
  useLocale();
  const seam = useContext(TaskMenuContext);
  if (seam === undefined || note.task === undefined) return null;
  const task = note.task;
  const editable = note.canSetStatus === true;
  const actions = seam.actionsOf(note);

  return (
    <>
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
            if (!editable) return;
            onProblem(undefined);
            void actions.change({ labels }).then(onProblem);
          }}
          options={seam.labels.map((label) => ({ value: label.id, label: label.name, disabled: !editable }))}
        />
      )}
    </>
  );
}
