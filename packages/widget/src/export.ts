import { type FeedbackWords, type NotePlacement, feedbackText } from '@fruitback/shared';
import type { NoteIssue, NoteStatus } from '@fruitback/shared';
import type { Translator } from './messages.ts';
import { statusLabel } from './status-paint.ts';

/**
 * The feedback of a page as plain text (FRU-109). The format is `feedbackText` of
 * `@fruitback/shared`, which the worker writes too (FRU-463); the widget gives it its words, in the
 * language of the reader, and the place of each note on the page.
 */

export type FeedbackPlacement = NotePlacement;

/** `status`: the status of the note in its read (FRU-370), when it has one. */
export type FeedbackEntry = { issue: NoteIssue; placement: FeedbackPlacement; status?: NoteStatus };

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
  return feedbackText(entries, { pageUrl: options.pageUrl, words: wordsOf(options.translator) });
}

function wordsOf(t: Translator): FeedbackWords {
  return {
    title: (url) => t.text('export.title', { url }),
    empty: t.text('export.empty'),
    element: (element) => t.text('export.element', { element }),
    component: (component) => t.text('export.component', { component }),
    by: (name) => t.text('export.by', { name }),
    written: (date) => t.text('export.written', { date }),
    approximate: t.text('export.approximate'),
    detached: t.text('export.detached'),
    picture: (url) => t.text('export.picture', { url }),
    noNote: t.text('thread.noNote'),
    team: t.text('thread.team'),
    reply: (author) => t.text('export.reply', { author }),
    status: (issue, status) => statusLabel(issue, status, t),
  };
}
