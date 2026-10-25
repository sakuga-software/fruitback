import {
  canonicalizePageUrl,
  type Note,
  type NoteParseFailure,
  type NoteParseResult,
  type NoteReporter,
  parseNote,
} from './note.ts';

/**
 * A note stored in a markdown description, with the issue still readable by whoever triages it
 * (FRU-30).
 *
 * Nothing here belongs to one provider. Every tracker worth connecting to stores a markdown body and
 * lets something search it, so this is a strategy connectors share rather than part of the store.
 * A connector picks it up or ignores it: `notes-postgres.ts` has columns and uses none of this.
 *
 * Two layers. Prose on top for the human in the tracker; a fenced JSON block underneath for the
 * widget that re-plants the pin. The body rather than a custom field, because a body needs no
 * workspace setup, survives an export, and a substring filter finds it server-side.
 *
 * A human can edit that block, so `parseNoteFromDescription` is tolerant and must never throw.
 * `parseNoteFromDescription(buildIssueDescription(note)) === note` is the invariant.
 */

/**
 * The words of the prose half, in the language of the team that triages (FRU-39).
 *
 * **The reader of a description is the team, never the reporter.** So these follow the worker's
 * `FRUITBACK_TEAM_LOCALE` and never the browser: a reporter in Tokyo must not file a Japanese issue
 * into a team that reads English. What the reporter wrote — the note, their name — is never
 * translated, and neither is the JSON block, which is the machine's half.
 */
export type TeamWords = {
  page: string;
  element: string;
  component: string;
  viewport: string;
  reportedBy: string;
  client: string;
  anonymous: string;
  verified: string;
  unverified: string;
  /** The line above the JSON block. It tells whoever opens the issue not to tidy the block below. */
  caption: string;
};

const ENGLISH: TeamWords = {
  page: 'Page',
  element: 'Element',
  component: 'Component',
  viewport: 'Viewport',
  reportedBy: 'Reported by',
  client: 'Client',
  anonymous: 'Anonymous',
  verified: 'verified',
  unverified: 'unverified — self-declared',
  caption: '**Fruitback data** · machine-readable, do not edit',
};

export const TEAM_WORDS: Record<string, TeamWords> = {
  en: ENGLISH,
  fr: {
    page: 'Page',
    element: 'Élément',
    component: 'Composant',
    viewport: 'Fenêtre',
    reportedBy: 'Signalé par',
    client: 'Client',
    anonymous: 'Anonyme',
    verified: 'vérifié',
    unverified: 'non vérifié — déclaré par la personne',
    caption: '**Données Fruitback** · lisible par la machine, ne pas modifier',
  },
};

/**
 * The words for a locale tag: the tag itself, then its base language, then English.
 *
 * The same cascade the widget's catalogs follow, and it never throws: a tag nobody recognises costs
 * the translation and never the description. The worker refuses a tag that is not a locale at all,
 * at boot, where an operator sees it.
 */
export function teamWords(locale: string | undefined): TeamWords {
  // An absent locale becomes the word `undefined`, which no catalog names: English.
  const tag = String(locale).toLowerCase();
  // A limit of 1 keeps the part before the first `-`, and `join` turns it into a string.
  const base = tag.split('-', 1).join();

  return TEAM_WORDS[tag] ?? TEAM_WORDS[base] ?? ENGLISH;
}

/**
 * The English caption, which is what every description carried before FRU-39.
 *
 * Free to reword: the parser recognises the block by parsing it, never by matching this caption.
 * `finds the block by its JSON, never by the caption above it` fails if that stops being true.
 */
export const NOTE_BLOCK_CAPTION = ENGLISH.caption;

const DEFAULT_TITLE_MAX_LENGTH = 80;

/**
 * Issue title: the visitor's own words, trimmed to one line. Falls back to the element when the
 * note is empty (a pin with a screenshot and no text is still worth triaging).
 */
export function buildIssueTitle(note: Note, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_TITLE_MAX_LENGTH;
  const firstLine = note.text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const title = firstLine ? firstLine.replace(/\s+/g, ' ') : `Feedback on <${note.anchor.tag}> — ${note.page.path}`;

  return truncate(title, maxLength);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const hardCut = value.slice(0, maxLength - 1);
  const lastSpace = hardCut.lastIndexOf(' ');
  // Only break on a word when that does not eat most of the title.
  const cut = lastSpace > maxLength * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${cut.trimEnd()}…`;
}

/** What the description is written in. Absent is English, which is every worker before FRU-39. */
export type DescriptionOptions = { locale?: string };

/** The human half of the description: what was said, where, and by whom, in the team's language. */
export function buildIssueMetadata(note: Note, { locale }: DescriptionOptions = {}): string[] {
  const words = teamWords(locale);
  const lines = [
    `**${words.page}** · [${note.page.path}](${note.page.url})`,
    `**${words.element}** · \`${note.anchor.selector}\` (\`<${note.anchor.tag}>\`)`,
  ];

  if (note.source?.component || note.source?.file) {
    const location = [note.source.file, note.source.line].filter((part) => part !== undefined).join(':');
    const component = note.source.component ? `\`${note.source.component}\`` : null;
    lines.push(
      `**${words.component}** · ${[component, location ? `\`${location}\`` : null].filter(Boolean).join(' — ')}`,
    );
  }

  lines.push(`**${words.viewport}** · ${note.viewport.width}×${note.viewport.height}${formatDpr(note.viewport.dpr)}`);
  lines.push(`**${words.reportedBy}** · ${formatReporter(words, note.reporter)}`);

  if (note.client) {
    lines.push(`**${words.client}** · ${note.client.name ?? note.client.id}`);
  }

  return lines;
}

/**
 * Says whose word it is, because the difference is the point (FRU-9).
 *
 * A name typed into the popover is a claim by whoever was on the page. Only a name the worker
 * checked against a signed token is an identity. Rendering them the same way would let anyone put a
 * colleague's name on a complaint and have it read as theirs.
 */
function formatReporter(words: TeamWords, reporter: NoteReporter = {}): string {
  // A token carrying only `sub` identifies someone perfectly well; it just does not name them.
  // Reading that as "Anonymous" would throw away the one distinction this line exists to make.
  // The name itself is the reporter's own word, so it is never translated.
  const who = [reporter.name, reporter.email].filter(Boolean).join(' · ') || reporter.id;
  if (!who) return words.anonymous;

  return `${who} (${reporter.verified ? words.verified : words.unverified})`;
}

function formatDpr(dpr: number | undefined): string {
  return dpr !== undefined && dpr !== 1 ? ` @${dpr}×` : '';
}

/** The machine half: a fenced JSON block the parser can find again. */
export function buildNoteBlock(note: Note): string {
  return ['```json', JSON.stringify(note, null, 2), '```'].join('\n');
}

/**
 * Full issue description for a note. `parseNoteFromDescription` is its exact inverse.
 *
 * **The locale reaches the prose and never the block.** That is what keeps the round trip true in
 * every language, and it is a constraint to hold rather than a fact to rely on: a translated key, or
 * a translated caption the parser looked for, would break it.
 */
export function buildIssueDescription(note: Note, options: DescriptionOptions = {}): string {
  const sections = [
    note.text.trim(),
    buildIssueMetadata(note, options).join('\n'),
    teamWords(options.locale).caption,
    buildNoteBlock(note),
  ];

  return `${sections.filter((section) => section.length > 0).join('\n\n')}\n`;
}

/**
 * Recover the note from an issue description.
 *
 * Tolerant on purpose: the description passes through the tracker's editor and through humans. Any
 * fenced block is accepted — backticks or tildes, with or without a language tag, CRLF endings, an
 * unterminated fence — and ours is found by parsing it, never by its position or by a marker.
 */
export function parseNoteFromDescription(description: string | null | undefined): NoteParseResult {
  if (!description) return { ok: false, reason: 'not-found' };

  // A real failure (a corrupted or too-new block) beats reporting "no note here".
  let failure: NoteParseFailure = { ok: false, reason: 'not-found' };

  for (const lines of iterateFencedBlocks(description)) {
    let result: NoteParseResult;
    try {
      // `trim` also drops a no-break space, which `JSON.parse` refuses and an editor can leave.
      // Stryker disable next-line StringLiteral: JSON needs no line break between its tokens, so the lines of a block parse the same joined by nothing.
      result = parseNote(JSON.parse(lines.join('\n').trim()));
    } catch {
      // Not JSON: a block of code or of prose. `parseNote` itself never throws.
      continue;
    }

    if (result.ok) return result;
    if (result.reason !== 'not-found') failure = result;
  }

  return failure;
}

/**
 * The lines of each fenced block, in order. A fence is a run of three backticks or tildes or more,
 * indented by three spaces at most. A block closes on a run of the same character, as long at least,
 * with nothing after it.
 */
function* iterateFencedBlocks(markdown: string): Generator<string[]> {
  let fence: string | null = null;
  let lines: string[] = [];

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const run = /^ {0,3}(?:`{3,}|~{3,})/.exec(line)?.[0].trimStart();

    if (fence === null) {
      if (run) fence = run;
      continue;
    }

    // A run is all one character, so `includes` checks both the character and the length.
    if (line.trim() === run && run.includes(fence)) {
      yield lines;
      fence = null;
      lines = [];
      continue;
    }

    lines.push(line);
  }

  // An unterminated fence still yields — a tracker that truncates a long description must not lose
  // the note.
  // Stryker disable next-line ConditionalExpression: with no open fence `lines` is empty, and an empty block parses as nothing.
  if (fence !== null) yield lines;
}

/**
 * The `description contains` term a store uses to fetch the notes of one page.
 *
 * It works because `buildNoteBlock` writes the canonical URL verbatim into the JSON. That is a
 * property of this codec, not of any provider, so it lives beside the writer that makes it true.
 * A store with real search does not need it; Linear's substring filter does.
 */
export function pageQueryTerm(url: string | URL): string {
  return canonicalizePageUrl(url);
}
