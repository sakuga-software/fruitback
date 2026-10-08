import type { SeedComment, SeedIssue } from '@fruitback/shared';
import type { Translator } from './messages.ts';

/**
 * The feedback of a page as plain text (FRU-109).
 *
 * The text holds what the reviewers wrote and where, and nothing more: no instruction and no
 * introduction. The person who pastes it writes the request around it.
 *
 * Markdown, because a person and a model both read it. **Every line a reviewer wrote is quoted.**
 * A note is text from anybody who can reach the page, so it must not be able to close a block, open
 * a heading or pass for a line of this format.
 */

export type FeedbackPlacement = 'found' | 'approximate' | 'detached';

export type FeedbackEntry = { issue: SeedIssue; placement: FeedbackPlacement };

/** How sure the place of a note is, from what the cascade answered for it. */
export function placementOf(resolution: { strategy: string; confident: boolean }): FeedbackPlacement {
  if (resolution.strategy === 'orphan') return 'detached';

  return resolution.confident ? 'found' : 'approximate';
}

export type FeedbackTextOptions = {
  /** The page the notes are about. */
  pageUrl: string;
  translator: Translator;
};

export function feedbackAsText(entries: readonly FeedbackEntry[], options: FeedbackTextOptions): string {
  const t = options.translator;
  const title = `# ${t.text('export.title', { url: options.pageUrl })}`;
  if (entries.length === 0) return `${title}\n\n${t.text('export.empty')}\n`;

  const blocks = entries.map((entry, index) => block(entry, index + 1, t));

  return `${[title, ...blocks].join('\n\n')}\n`;
}

function block({ issue, placement }: FeedbackEntry, position: number, t: Translator): string {
  const seed = issue.seed;
  const facts = [
    t.text('export.element', { element: element(issue) }),
    component(issue, t),
    signature(issue, t),
    placement === 'approximate' ? t.text('export.approximate') : undefined,
    placement === 'detached' ? t.text('export.detached') : undefined,
    seed.screenshot?.url !== undefined ? t.text('export.picture', { url: seed.screenshot.url }) : undefined,
  ].filter((line): line is string => line !== undefined);

  return [
    `## ${position}. ${oneLine(issue.identifier)} — ${oneLine(issue.stateName || t.stage(issue.stage))}`,
    facts.map((fact) => `- ${fact}`).join('\n'),
    seed.note.trim().length > 0 ? quote(seed.note) : t.text('thread.noNote'),
    ...(issue.comments ?? []).map((comment) => reply(comment, t)),
  ].join('\n\n');
}

/** The tag, the text the element showed, and the selector that found it. */
function element(issue: SeedIssue): string {
  const anchor = issue.seed.anchor;
  const text = oneLine(anchor.text ?? '');

  return [text.length > 0 ? `${anchor.tag} "${text}"` : anchor.tag, code(anchor.selector)].join(' · ');
}

function component(issue: SeedIssue, t: Translator): string | undefined {
  const source = issue.seed.source;
  if (source === undefined) return undefined;

  const file = source.file === undefined ? undefined : [source.file, source.line].filter(isPresent).join(':');
  const parts = [source.component, file].filter(isPresent).map(oneLine);

  return parts.length > 0 ? t.text('export.component', { component: parts.join(' · ') }) : undefined;
}

function signature(issue: SeedIssue, t: Translator): string | undefined {
  const name = issue.seed.reporter?.name ?? issue.seed.reporter?.email;
  const date = day(issue.seed.createdAt);
  if (name !== undefined) return dated(t.text('export.by', { name: oneLine(name) }), date);

  return date === '' ? undefined : t.text('export.written', { date });
}

function reply(comment: SeedComment, t: Translator): string {
  const head = t.text('export.reply', { author: oneLine(comment.author ?? t.text('thread.team')) });

  return `${dated(head, day(comment.createdAt))}\n${quote(comment.body)}`;
}

/** The date after the words, and nothing after them when the store gave no date. */
function dated(words: string, date: string): string {
  return date === '' ? words : `${words} · ${date}`;
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
  if (value === undefined) return '';
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function isPresent<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
