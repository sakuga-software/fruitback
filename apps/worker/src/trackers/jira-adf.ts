import { type Note, buildIssueMetadata, buildNoteBlock, parseNoteFromDescription, teamWords } from '@fruitback/shared';

/**
 * The description of a Jira issue, in the Atlassian Document Format that the v3 API takes (FRU-622).
 *
 * It says what `buildIssueDescription` says, block for block: the words of the note, the page, the
 * element and the reporter, the caption, then the note itself in a code block of JSON. The block is
 * what a read finds again: `noteOfDescription` turns each code block back into a fence of Markdown
 * and hands it to `parseNoteFromDescription`, the parser of every other tracker.
 */

type Mark = { type: 'strong' } | { type: 'code' } | { type: 'link'; attrs: { href: string } };
type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hardBreak' };
type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'codeBlock'; attrs: { language: string }; content: { type: 'text'; text: string }[] };
export type AdfDocument = { type: 'doc'; version: 1; content: Block[] };

/**
 * The inline Markdown of a line of the metadata (`**bold**`, `` `code` ``, `[label](url)`), as ADF
 * marks. Nothing else of Markdown is read: the line is written by `buildIssueMetadata`.
 */
function inline(line: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > at) out.push({ type: 'text', text: line.slice(at, index) });
    if (match[1] !== undefined) out.push({ type: 'text', text: match[1], marks: [{ type: 'strong' }] });
    else if (match[2] !== undefined) out.push({ type: 'text', text: match[2], marks: [{ type: 'code' }] });
    else if (match[3] !== undefined && match[4] !== undefined && /^https?:\/\//.test(match[4])) {
      out.push({ type: 'text', text: match[3], marks: [{ type: 'link', attrs: { href: match[4] } }] });
    } else out.push({ type: 'text', text: match[0] });
    at = index + match[0].length;
  }
  if (at < line.length) out.push({ type: 'text', text: line.slice(at) });

  return out;
}

/** Lines as one paragraph, a break between two. ADF refuses a text node that is empty. */
function paragraph(lines: readonly Inline[][]): Block {
  const content: Inline[] = [];
  lines.forEach((each, index) => {
    if (index > 0) content.push({ type: 'hardBreak' });
    content.push(...each.filter((node) => node.type !== 'text' || node.text !== ''));
  });

  return { type: 'paragraph', content };
}

export function buildAdfDescription(note: Note, locale: string | undefined): AdfDocument {
  const text = note.text.trim();
  const said: Block[] =
    text === ''
      ? []
      : text.split(/\n\s*\n/).map((part) => paragraph(part.split('\n').map((line) => [{ type: 'text', text: line }])));
  // The note block of every tracker, without its fence: ADF draws a code block of its own.
  const block = buildNoteBlock(note).split('\n').slice(1, -1).join('\n');

  return {
    type: 'doc',
    version: 1,
    content: [
      ...said,
      paragraph(buildIssueMetadata(note, { ...(locale === undefined ? {} : { locale }) }).map(inline)),
      paragraph([[{ type: 'text', text: teamWords(locale).caption }]]),
      { type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: block }] },
    ],
  };
}

type Node = { type?: unknown; text?: unknown; content?: unknown };

function childrenOf(node: Node): Node[] {
  return Array.isArray(node.content) ? (node.content as Node[]) : [];
}

/** The text of a node of ADF, its paragraphs one per line. */
export function adfText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const each = node as Node;
  if (each.type === 'text') return typeof each.text === 'string' ? each.text : '';
  if (each.type === 'hardBreak') return '\n';
  const inner = childrenOf(each).map(adfText);
  const blocks = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'panel'];

  return blocks.includes(String(each.type)) ? inner.join('\n') : inner.join('');
}

/**
 * The note an issue holds, from its description: each code block of the document, as a fence of
 * Markdown, for the parser of every tracker. A description that a person rewrote as text is read as
 * text, so a fence they typed is found too.
 */
export function noteOfDescription(description: unknown): ReturnType<typeof parseNoteFromDescription> {
  if (typeof description === 'string') return parseNoteFromDescription(description);
  const fences: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const each = node as Node;
    if (each.type === 'codeBlock') {
      fences.push(['```', adfText({ type: 'paragraph', content: each.content }), '```'].join('\n'));
      return;
    }
    childrenOf(each).forEach(walk);
  };
  walk(description);

  return parseNoteFromDescription(fences.length === 0 ? adfText(description) : fences.join('\n\n'));
}
