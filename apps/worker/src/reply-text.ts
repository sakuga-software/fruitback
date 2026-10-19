import type { NewReply } from './store.ts';

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
  const words = WORDS[locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en'];
  const { author } = reply;
  const name = replyName(author.name) ?? words.visitor;
  const who =
    author.kind === 'member' ? `${words.member} ${replyName(author.workspace) ?? ''}`.trim() : words.unverified;
  const quoted = reply.body
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`));

  return [`**${name}** ${words.via} · ${who}`, '', ...quoted].join('\n');
}
