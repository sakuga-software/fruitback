import { canonicalizePageUrl, type Seed, type SeedParseFailure, type SeedParseResult, parseSeed } from './seed.ts';

/**
 * A seed stored in a markdown description, with the issue still readable by whoever triages it
 * (SKG-523).
 *
 * Nothing here belongs to one provider. Every tracker worth connecting to stores a markdown body and
 * lets something search it, so this is a strategy connectors share rather than part of `SeedStore`.
 * A connector picks it up or ignores it: `sqlite.ts` has columns and uses none of this.
 *
 * Two layers. Prose on top for the human in the tracker; a fenced JSON block underneath for the
 * widget that re-plants the pin. The body rather than a custom field, because a body needs no
 * workspace setup, survives an export, and a substring filter finds it server-side.
 *
 * A human can edit that block, so `parseSeedFromDescription` is tolerant and must never throw.
 * `parseSeedFromDescription(buildIssueDescription(seed)) === seed` is the invariant.
 */

/**
 * The line above the JSON block. It tells whoever opens the issue not to tidy the block below.
 *
 * Free to reword: the parser recognises the block by parsing it, never by matching this caption.
 * `finds the block by its JSON, never by the caption above it` fails if that stops being true.
 */
export const SEED_BLOCK_CAPTION = '**Fruitback seed** · machine-readable, do not edit';

const DEFAULT_TITLE_MAX_LENGTH = 80;

/**
 * Issue title: the visitor's own words, trimmed to one line. Falls back to the element when the
 * note is empty (a pin with a screenshot and no text is still worth triaging).
 */
export function buildIssueTitle(seed: Seed, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_TITLE_MAX_LENGTH;
  const firstLine = seed.note
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const title = firstLine ? firstLine.replace(/\s+/g, ' ') : `Feedback on <${seed.anchor.tag}> — ${seed.page.path}`;

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

/** The human half of the description: what was said, where, and by whom. */
export function buildIssueMetadata(seed: Seed): string[] {
  const lines = [
    `**Page** · [${seed.page.path}](${seed.page.url})`,
    `**Element** · \`${seed.anchor.selector}\` (\`<${seed.anchor.tag}>\`)`,
  ];

  if (seed.source?.component || seed.source?.file) {
    const location = [seed.source.file, seed.source.line].filter((part) => part !== undefined).join(':');
    const component = seed.source.component ? `\`${seed.source.component}\`` : null;
    lines.push(`**Component** · ${[component, location ? `\`${location}\`` : null].filter(Boolean).join(' — ')}`);
  }

  lines.push(`**Viewport** · ${seed.viewport.width}×${seed.viewport.height}${formatDpr(seed.viewport.dpr)}`);
  lines.push(`**Reported by** · ${formatReporter(seed.reporter)}`);

  if (seed.client) {
    lines.push(`**Client** · ${seed.client.name ?? seed.client.id}`);
  }

  return lines;
}

/**
 * Says whose word it is, because the difference is the point (SKG-498).
 *
 * A name typed into the popover is a claim by whoever was on the page. Only a name the worker
 * checked against a signed token is an identity. Rendering them the same way would let anyone put a
 * colleague's name on a complaint and have it read as theirs.
 */
function formatReporter(reporter: Seed['reporter']): string {
  // A token carrying only `sub` identifies someone perfectly well; it just does not name them.
  // Reading that as "Anonymous" would throw away the one distinction this line exists to make.
  const who = [reporter?.name, reporter?.email].filter(Boolean).join(' · ') || reporter?.id;
  if (who === undefined || who.length === 0) return 'Anonymous';

  return reporter?.verified === true ? `${who} (verified)` : `${who} (unverified — self-declared)`;
}

function formatDpr(dpr: number | undefined): string {
  return dpr !== undefined && dpr !== 1 ? ` @${dpr}×` : '';
}

/** The machine half: a fenced JSON block the parser can find again. */
export function buildSeedBlock(seed: Seed): string {
  return ['```json', JSON.stringify(seed, null, 2), '```'].join('\n');
}

/** Full issue description for a seed. `parseSeedFromDescription` is its exact inverse. */
export function buildIssueDescription(seed: Seed): string {
  const sections = [seed.note.trim(), buildIssueMetadata(seed).join('\n'), SEED_BLOCK_CAPTION, buildSeedBlock(seed)];

  return `${sections.filter((section) => section.length > 0).join('\n\n')}\n`;
}

/**
 * Recover the seed from an issue description.
 *
 * Tolerant on purpose: the description passes through the tracker's editor and through humans. Any
 * fenced block is accepted — backticks or tildes, with or without a language tag, CRLF endings, an
 * unterminated fence — and ours is found by parsing it, never by its position or by a marker.
 */
export function parseSeedFromDescription(description: string | null | undefined): SeedParseResult {
  if (!description) return { ok: false, reason: 'not-found' };

  // A real failure (a corrupted or too-new block) beats reporting "no seed here".
  let failure: SeedParseFailure = { ok: false, reason: 'not-found' };

  for (const block of iterateFencedBlocks(description)) {
    const value = tryParseJson(block.body);
    if (value === undefined) continue;

    const result = parseSeed(value);
    if (result.ok) return result;
    if (result.reason !== 'not-found') failure = result;
  }

  return failure;
}

function tryParseJson(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

type FencedBlock = { info: string; body: string };

function* iterateFencedBlocks(markdown: string): Generator<FencedBlock> {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const fencePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
  let open: { marker: string; info: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = fencePattern.exec(line);

    if (open === null) {
      if (match) open = { marker: match[1] ?? '', info: (match[2] ?? '').trim(), body: [] };
      continue;
    }

    const run = match?.[1] ?? '';
    const closes =
      run.length >= open.marker.length && run.charAt(0) === open.marker.charAt(0) && (match?.[2] ?? '').trim() === '';

    if (closes) {
      yield { info: open.info, body: open.body.join('\n') };
      open = null;
      continue;
    }

    open.body.push(line);
  }

  // An unterminated fence still yields — a tracker that truncates a long description must not lose
  // the seed.
  if (open !== null) yield { info: open.info, body: open.body.join('\n') };
}

/**
 * The `description contains` term a store uses to fetch the seeds of one page.
 *
 * It works because `buildSeedBlock` writes the canonical URL verbatim into the JSON. That is a
 * property of this codec, not of any provider, so it lives beside the writer that makes it true.
 * A store with real search does not need it; Linear's substring filter does.
 */
export function pageQueryTerm(url: string | URL): string {
  return canonicalizePageUrl(url);
}
