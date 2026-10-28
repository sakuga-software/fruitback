import type { NoteComment, NoteIssue, NoteStatus } from './issue.ts';

/**
 * The feedback of a page as plain text (FRU-109): the format of « Copy as text » in the widget, and
 * of the tool `feedback_as_text` of the worker (FRU-463).
 *
 * The text holds what the reviewers wrote and where, and nothing more: no instruction and no
 * introduction. The person who pastes it writes the request around it.
 *
 * Markdown, because a person and a model both read it. **Every line a reviewer wrote is quoted.**
 * A note is text from anybody who can reach the page, so it must not be able to close a block, open
 * a heading or pass for a line of this format.
 *
 * The contract holds no word a person reads: the caller gives them, in its language.
 */

/** How sure the place of a note is. Absent: the caller has no page to find it on, and says nothing. */
export type NotePlacement = 'found' | 'approximate' | 'detached';

/** `status`: the status of the note in its read (FRU-370), when it has one. */
export type FeedbackTextEntry = { issue: NoteIssue; placement?: NotePlacement; status?: NoteStatus };

/** The words of the text, in the language of the caller. */
export type FeedbackWords = {
  title(url: string): string;
  empty: string;
  element(element: string): string;
  component(component: string): string;
  by(name: string): string;
  written(date: string): string;
  approximate: string;
  detached: string;
  picture(url: string): string;
  noNote: string;
  team: string;
  reply(author: string): string;
  /** The status of a note as a person reads it. */
  status(issue: NoteIssue, status: NoteStatus | undefined): string;
};

export function feedbackText(
  entries: readonly FeedbackTextEntry[],
  { pageUrl, words }: { pageUrl: string; words: FeedbackWords },
): string {
  const title = `# ${words.title(pageUrl)}`;
  if (entries.length === 0) return `${title}\n\n${words.empty}\n`;

  const blocks = entries.map((entry, index) => block(entry, index + 1, words));

  return `${[title, ...blocks].join('\n\n')}\n`;
}

function block({ issue, placement, status }: FeedbackTextEntry, position: number, words: FeedbackWords): string {
  const note = issue.note;
  const facts = [
    words.element(element(issue)),
    component(issue, words),
    signature(issue, words),
    placement === 'approximate' ? words.approximate : undefined,
    placement === 'detached' ? words.detached : undefined,
    note.screenshot?.url !== undefined ? words.picture(note.screenshot.url) : undefined,
  ].filter((line): line is string => line !== undefined);

  return [
    `## ${position}. ${oneLine(issue.identifier)} — ${oneLine(words.status(issue, status))}`,
    facts.map((fact) => `- ${fact}`).join('\n'),
    note.text.trim().length > 0 ? quote(note.text) : words.noNote,
    ...(issue.comments ?? []).map((comment) => reply(comment, words)),
  ].join('\n\n');
}

/** The tag, the text the element showed, and the selector that found it. */
function element(issue: NoteIssue): string {
  const anchor = issue.note.anchor;
  const text = oneLine(anchor.text ?? '');

  return [text.length > 0 ? `${anchor.tag} "${text}"` : anchor.tag, code(anchor.selector)].join(' · ');
}

function component(issue: NoteIssue, words: FeedbackWords): string | undefined {
  const source = issue.note.source;
  if (source === undefined) return undefined;

  const file = source.file === undefined ? undefined : [source.file, source.line].filter(isPresent).join(':');
  const parts = [source.component, file].filter(isPresent).map(oneLine);

  return parts.length > 0 ? words.component(parts.join(' · ')) : undefined;
}

function signature(issue: NoteIssue, words: FeedbackWords): string | undefined {
  const name = issue.note.reporter?.name ?? issue.note.reporter?.email;
  const date = day(issue.note.createdAt);
  if (name !== undefined) return dated(words.by(oneLine(name)), date);

  return date === '' ? undefined : words.written(date);
}

function reply(comment: NoteComment, words: FeedbackWords): string {
  const head = words.reply(oneLine(comment.author ?? words.team));

  return `${dated(head, day(comment.createdAt))}\n${quote(comment.body)}`;
}

/** The date after the words, and nothing after them when the store gave no date. */
function dated(text: string, date: string): string {
  return date === '' ? text : `${text} · ${date}`;
}

/** Each line behind a quote mark, so nothing in the text can end the quote. */
function quote(text: string): string {
  return text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** A code span that holds its content whatever backticks the content has. */
function code(text: string): string {
  const content = oneLine(text);
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';

  return `${fence}${pad}${content}${pad}${fence}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The date as `2026-10-06`: the same in every language, and what sorts. Empty when it is no date. */
function day(value: string | undefined): string {
  const date = new Date(String(value));

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function isPresent<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
