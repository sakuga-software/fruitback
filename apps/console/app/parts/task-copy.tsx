import {
  type FeedbackWords,
  type NoteIssue,
  type NoteStatus,
  type TaskIssue,
  feedbackText,
  isTaskIssue,
  tasksText,
} from '@fruitback/shared';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { composes, typedInField } from '../keys';
import { t } from '../i18n';
import type { StatusChoice } from '../note-status';
import { STAGE_NAMES } from '../stages';
import type { IndexedNote } from './notes-model';

/** What « Copy » needs of a note: its id in the console, its site, and its reference when the list gives it. */
export type CopiedNote = Pick<IndexedNote, 'id' | 'site'> & {
  ref?: string;
  /** A note the list does not hold (a panel opened by its link): its reference is read, not given. */
  unlisted?: true;
};

/** The three copies of a task (FRU-658), for one note or several, in the order given. */
export type TaskCopy = {
  /** The address of each note in the console, which opens its panel. */
  link: (notes: readonly CopiedNote[]) => void;
  /** What Fruitback or the tracker calls each note: `FB-123`. Only the notes with a reference. */
  identifier: (notes: readonly CopiedNote[]) => void;
  /** The whole notes as Markdown, in the format of `notes_as_text`, for an agent. */
  markdown: (notes: readonly CopiedNote[]) => void;
};

/** The words of the Markdown, in the language of the console: the contract holds none. */
function wordsOf(): FeedbackWords {
  return {
    title: (url) => t('Notes on {url}', { url }),
    empty: t('No note on this page.'),
    element: (element) => t('Element: {element}', { element }),
    component: (component) => t('Component: {component}', { component }),
    by: (name) => t('By: {name}', { name }),
    written: (date) => t('Written: {date}', { date }),
    approximate: t('Position: approximate, found by its place on the page'),
    detached: t('Position: element not found on this page'),
    picture: (url) => t('Picture: {url}', { url }),
    noNote: t('No note.'),
    team: t('Team'),
    reply: (author) => t('Reply from {author}', { author }),
    status: (issue, status) => status?.name || issue.stateName || t(STAGE_NAMES[issue.stage]),
  };
}

/**
 * The Markdown of these notes, read whole (`GET …/notes/<note>`): the notes of each page under the
 * heading of their page, in the order of the list, then the tasks written by hand under their own.
 * A note that cannot be read is left out, and `missing` counts it.
 */
async function markdownOf(
  base: string,
  notes: readonly CopiedNote[],
  statusesOf: (site: string) => readonly StatusChoice[] | undefined,
): Promise<{ text: string; missing: number }> {
  const read = await Promise.all(
    notes.map(async (note) => {
      const got = await call<{ note: NoteIssue } | { task: TaskIssue }>(
        'GET',
        `${base}/notes/${encodeURIComponent(note.id)}`,
      ).catch(() => undefined);
      if (got?.ok !== true) return undefined;
      const issue = 'task' in got.data ? got.data.task : got.data.note;
      const status: NoteStatus | undefined = statusesOf(note.site.id)?.find((each) => each.key === issue.status);

      return { issue, ...(status === undefined ? {} : { status }) };
    }),
  );
  const words = wordsOf();
  const pages = new Map<string, { issue: NoteIssue; status?: NoteStatus }[]>();
  const tasks: { issue: TaskIssue; status?: NoteStatus }[] = [];
  for (const entry of read) {
    if (entry === undefined) continue;
    const { issue, status } = entry;
    if (isTaskIssue(issue)) {
      tasks.push({ issue, ...(status === undefined ? {} : { status }) });
      continue;
    }
    const page = issue.note.page.url;
    pages.set(page, [...(pages.get(page) ?? []), { issue, ...(status === undefined ? {} : { status }) }]);
  }
  const text = [
    ...[...pages].map(([pageUrl, entries]) => feedbackText(entries, { pageUrl, words })),
    ...(tasks.length === 0 ? [] : [tasksText(tasks, { heading: t('Tasks with no page'), words })]),
  ].join('\n');

  const missing = read.filter((entry) => entry === undefined).length;
  // Nothing read: nothing is copied, and the person is told the read failed, not the clipboard.
  if (missing === notes.length) throw new NotRead();

  return { text, missing };
}

/** No note of a copy could be read. */
class NotRead extends Error {}

/** No note of a copy has a reference that this person reads. */
class NoReference extends Error {}

/**
 * The reference of one note, read whole: `FB-12`, or the one of its tracker. A guest reads the id of
 * the note in its place, which is no reference: `undefined`, as for a note that does not load.
 */
async function referenceOf(base: string, id: string): Promise<string | undefined> {
  const got = await call<{ note: NoteIssue } | { task: TaskIssue }>(
    'GET',
    `${base}/notes/${encodeURIComponent(id)}`,
  ).catch(() => undefined);
  if (got?.ok !== true) return undefined;
  const identifier = 'task' in got.data ? got.data.task.identifier : got.data.note.identifier;

  return /^[A-Z][A-Z0-9]*-\d+$/u.test(identifier) ? identifier : undefined;
}

/**
 * Writes `text` to the clipboard. A text that is still being read goes as a `ClipboardItem` of a
 * promise, so that Safari, which wants the write in the gesture of the person, takes it too.
 */
async function writeClipboard(text: string | Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write !== undefined && typeof text !== 'string') {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': text.then((done) => new Blob([done], { type: 'text/plain' })) }),
    ]);
    return;
  }
  if (navigator.clipboard?.writeText === undefined) throw new Error('no clipboard');
  await navigator.clipboard.writeText(await text);
}

/**
 * « Copy » of the tasks (FRU-658): the link, the reference, or the Markdown of one note or of several,
 * and the sentence that says what was copied, in a status line the screen shows and a screen reader
 * reads. A refusal of the browser is said there too.
 */
export function useTaskCopy({
  base,
  workspace,
  statusesOf,
}: {
  base: string;
  workspace: string;
  statusesOf: (site: string) => readonly StatusChoice[] | undefined;
}): { copy: TaskCopy; status: ReactNode } {
  const [said, setSaid] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const say = useCallback((sentence: string) => {
    clearTimeout(timer.current);
    setSaid(sentence);
    timer.current = setTimeout(() => setSaid(undefined), 4000);
  }, []);

  const copied = useCallback(
    (text: string | Promise<string>, done: string | ((copied: string) => string)) => {
      writeClipboard(text).then(
        async () => say(typeof done === 'string' ? done : done(await text)),
        async () => {
          // The read failed, there was nothing to copy, or the browser refused: each is said as it is.
          const failure =
            typeof text === 'string'
              ? undefined
              : await text.then(
                  () => undefined,
                  (error: unknown) => error,
                );
          if (failure instanceof NoReference) return say(t('No ID to copy: these notes have no reference here.'));
          say(
            failure !== undefined
              ? t('The notes did not load, and nothing was copied. Try again.')
              : t('The browser did not let Fruitback copy. Allow the clipboard for this page, then try again.'),
          );
        },
      );
    },
    [say],
  );

  const copy: TaskCopy = {
    link: (notes) => {
      if (notes.length === 0) return;
      const origin = window.location.origin;
      // The id, not the short name (FRU-715): a link that leaves the console opens the workspace for
      // life, after a change of short name too. The console shows the short name on arrival.
      const links = notes.map((note) => `${origin}/w/${workspace}/notes?task=${encodeURIComponent(note.id)}`);
      copied(
        links.join('\n'),
        notes.length === 1 ? t('Link copied.') : t('{count} links copied.', { count: notes.length }),
      );
    },
    identifier: (notes) => {
      if (notes.length === 0) return;
      const said = (references: readonly string[]) =>
        references.length === 1
          ? t('{id} copied.', { id: references[0] as string })
          : t('{count} IDs copied.', { count: references.length });
      // A note of the list gives its reference. A note the list does not hold (a panel opened by its
      // link, on another page) is read for it: the panel shows one, so the key copies it.
      if (notes.every((note) => note.ref !== undefined || note.unlisted !== true)) {
        const references = notes.flatMap((note) => (note.ref === undefined ? [] : [note.ref]));
        if (references.length === 0) return say(t('No ID to copy: these notes have no reference here.'));
        return copied(references.join('\n'), said(references));
      }
      const text = Promise.all(notes.map((note) => note.ref ?? referenceOf(base, note.id))).then((found) => {
        const references = found.flatMap((each) => (each === undefined ? [] : [each]));
        if (references.length === 0) throw new NoReference();

        return references.join('\n');
      });
      text.catch(() => {});
      copied(text, (copiedText) => said(copiedText.split('\n')));
    },
    markdown: (notes) => {
      if (notes.length === 0) return;
      // A failed request is a note not read, never an error past this point. One sentence is said at
      // the end: the notes that did not load, or the copy.
      let missing = 0;
      const text = markdownOf(base, notes, statusesOf).then((read) => {
        missing = read.missing;

        return read.text;
      });
      text.catch(() => {});
      copied(text, () => {
        // Both facts: what was copied, and that the rest is not in it.
        if (missing > 0) {
          return t('{copied} of {count} notes copied as Markdown: the others did not load.', {
            copied: notes.length - missing,
            count: notes.length,
          });
        }

        return notes.length === 1
          ? t('Copied as Markdown.')
          : t('{count} notes copied as Markdown.', { count: notes.length });
      });
    },
  };

  const status = (
    <p
      role="status"
      data-copy-status=""
      className={
        said === undefined
          ? 'sr-only'
          : // The pill lets the pointer through: a button under it stays pressable while it shows.
            'pointer-events-none fixed bottom-[24px] left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-card bg-ink px-[16px] py-[8px] text-small text-page shadow-lg'
      }
    >
      {said ?? ''}
    </p>
  );

  return { copy, status };
}

/**
 * The shortcuts of a copy (FRU-658), as in Linear: Cmd or Ctrl, Shift and C for the link, and Cmd or
 * Ctrl, Shift and the full stop for the reference. By the key's place (`code`), so that a layout where
 * Shift and the full stop write another sign still takes it. Never in a field.
 */
export function copyShortcutOf(event: KeyboardEvent): 'link' | 'identifier' | undefined {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.repeat) return undefined;
  // A field of the console, or one in a Shadow root (FRU-726), keeps its keys.
  if (composes(event) || typedInField(event)) return undefined;
  if (event.code === 'KeyC') return 'link';
  if (event.code === 'Period') return 'identifier';

  return undefined;
}
