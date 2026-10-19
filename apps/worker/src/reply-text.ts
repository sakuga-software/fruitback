import type { SeedComment } from '@fruitback/shared';
import type { CheckVerdict, NewCheck, NewReply } from './store.ts';

/**
 * The text of a reply in a tracker (FRU-257): one line that says who wrote it, then what they wrote,
 * quoted.
 *
 * A tracker writes the reply under the identity of its key: the app of Fruitback for a connection by
 * OAuth, and the owner of the key for a personal key. So the name of the person is in the text, and
 * the line says whether the worker vouches for it.
 *
 * **Every line of what somebody wrote is quoted**, the empty ones too. The first line of the text is
 * therefore always the line of the worker: a reply that writes a line of the same shape is a line of
 * the quote, and never the line that says who wrote it.
 */

/** The longest name the line holds. A longer one is cut. */
export const REPLY_NAME_LENGTH = 80;

const WORDS = {
  en: { visitor: 'Visitor', via: 'via Fruitback', member: 'member of', unverified: 'not verified' },
  fr: { visitor: 'Visiteur', via: 'via Fruitback', member: 'membre de', unverified: 'non vérifié' },
} as const;

/**
 * A name as the line shows it: on one line, with none of the characters that make markdown, and at
 * most `REPLY_NAME_LENGTH` characters. An empty name is no name.
 */
export function replyName(name: string | undefined): string | undefined {
  const flat = [
    ...(name ?? '')
      .replace(/[*_`[\]<>#|\\~]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  ]
    .slice(0, REPLY_NAME_LENGTH)
    .join('')
    .trim();

  return flat === '' ? undefined : flat;
}

/** The text of `reply`, in the language of the team (FRU-39). */
export function replyText(reply: NewReply, locale?: string): string {
  return [whoLine(reply.author, locale), '', ...quoted(reply.body)].join('\n');
}

/** The first line: who wrote it, and whether the worker vouches for them. */
function whoLine(author: NewReply['author'], locale?: string): string {
  const words = WORDS[locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en'];
  const name = replyName(author.name) ?? words.visitor;
  const who =
    author.kind === 'member' ? `${words.member} ${replyName(author.workspace) ?? ''}`.trim() : words.unverified;

  return `**${name}** ${words.via} · ${who}`;
}

/** Every line of what somebody wrote, quoted, the empty ones too. */
function quoted(body: string): string[] {
  return body
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`));
}

/**
 * The line under the line of who wrote it that marks a verdict (FRU-294), in each language of a team.
 * A reply of the page never has it: its second line is always empty (`replyText`).
 */
const VERDICTS = {
  en: { fixed: 'Checked: looks fixed', wrong: 'Reopened: still wrong' },
  fr: { fixed: 'Vérifié : semble corrigé', wrong: 'Rouvert : toujours faux' },
} as const;

/**
 * The text of a verdict in a tracker (FRU-294): the line of who wrote it, as for a reply, then the
 * line of the verdict, then what the person typed, quoted. A read finds the verdict in it again with
 * `verdictOf`, whatever the language of the team was when it was written.
 */
export function checkText(check: NewCheck, locale?: string): string {
  const language = locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const typed = check.body?.trim() ?? '';

  return [
    whoLine(check.author, locale),
    VERDICTS[language][check.verdict],
    ...(typed === '' ? [] : ['', ...quoted(typed)]),
  ].join('\n');
}

/** The first line that the worker writes, and the name in it. */
const WHO_LINE = /^\*\*([^*\n]+)\*\* via Fruitback · /u;

/**
 * The verdict a comment holds, and the name of who gave it, or `undefined` for any other comment.
 *
 * WARNING: this reads a text. A person of the team who writes in the tracker can write these two
 * lines by hand: the tracker is theirs, and they can move the note there too. A reply of the page
 * cannot: its second line is empty.
 */
export function verdictOf(body: string): { verdict: CheckVerdict; by: string } | undefined {
  const [first = '', second = ''] = body.replace(/\r\n?/gu, '\n').split('\n');
  const by = WHO_LINE.exec(first)?.[1];
  if (by === undefined) return undefined;
  for (const words of Object.values(VERDICTS)) {
    if (second === words.fixed) return { verdict: 'fixed', by };
    if (second === words.wrong) return { verdict: 'wrong', by };
  }

  return undefined;
}

/**
 * Who confirmed a note, and when (FRU-294): the newest verdict among its replies, when it is
 * « fixed ». A « wrong » after it, or no verdict, is no confirmation. `undefined` for comments that
 * were not read.
 */
export function checkedOf(comments: readonly SeedComment[] | undefined): { by: string; at: string } | undefined {
  let newest: { verdict: CheckVerdict; by: string; at: string } | undefined;
  for (const comment of comments ?? []) {
    const verdict = verdictOf(comment.body);
    if (verdict !== undefined && (newest === undefined || comment.createdAt >= newest.at)) {
      newest = { ...verdict, at: comment.createdAt };
    }
  }

  return newest?.verdict === 'fixed' ? { by: newest.by, at: newest.at } : undefined;
}
