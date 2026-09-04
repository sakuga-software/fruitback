import {
  canonicalizePageUrl,
  type Seed,
  type SeedParseFailure,
  type SeedParseResult,
  parseSeed,
  seedSchema,
} from './seed.ts';
import { z } from 'zod';

/**
 * Mapping between a seed and a Linear issue.
 *
 * Linear is the database: there is no Fruitback backend. So an issue has to carry everything the
 * widget needs to re-plant its pin later, while still reading like a normal ticket to whoever
 * triages it. The answer is two layers in the description — prose for humans on top, a JSON block
 * for the widget at the bottom.
 *
 * Why the description and not a custom field: it is portable (works on any workspace, no admin
 * setup), it survives an export, and Linear can filter on it server-side
 * (`description: { contains: <canonical url> }`), which is how "the seeds of this page" is queried
 * without walking every issue. The cost is that a human can corrupt the block by editing it —
 * hence the tolerant parser below and the loud caption.
 */

/** Every issue Fruitback creates carries this label. It is the read filter. */
export const FRUITBACK_LABEL = 'fruitback';

/** Per-client label, so one workspace can serve every client site. */
export function clientLabelName(clientId: string): string {
  return `${FRUITBACK_LABEL}:${clientId}`;
}

/** Labels to apply when creating the issue (M3 / SKG-497). */
export function buildIssueLabels(seed: Seed): string[] {
  return seed.client ? [FRUITBACK_LABEL, clientLabelName(seed.client.id)] : [FRUITBACK_LABEL];
}

/**
 * The line above the JSON block, and the only thing standing between the payload and an editor.
 *
 * Deliberately shouty for that reason: whoever opens the issue in the store's own interface has to
 * understand that the block below is not prose to tidy up.
 *
 * Free to reword, though — the parser finds the block by parsing its JSON, never by matching this.
 * Pinned by `finds the block by its JSON, never by the caption above it`, which fails if the parser
 * ever starts depending on it. That is what made dropping the emoji it used to open with safe rather
 * than hopeful (SKG-517).
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

/** Full Linear description for a seed. `parseSeedFromDescription` is its exact inverse. */
export function buildIssueDescription(seed: Seed): string {
  const sections = [seed.note.trim(), buildIssueMetadata(seed).join('\n'), SEED_BLOCK_CAPTION, buildSeedBlock(seed)];

  return `${sections.filter((section) => section.length > 0).join('\n\n')}\n`;
}

/**
 * Recover the seed from a Linear description.
 *
 * Tolerant on purpose: the description round-trips through Linear's editor and through humans, so
 * we accept any fenced block (backticks or tildes, with or without a language tag, CRLF endings,
 * an unterminated fence) and locate ours by its `kind` field rather than by position or marker.
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

  // An unterminated fence still yields — Linear truncating a long description must not lose the seed.
  if (open !== null) yield { info: open.info, body: open.body.join('\n') };
}

/**
 * How ripe a pin looks on the page. This is the whole status story: the widget never stores a status
 * of its own, it renders the one the store reports.
 *
 * The vocabulary belongs here. The **projection** onto it does not: Linear has workflow state types,
 * GitHub has open/closed and some labels, a SQL store has whatever it chose. Each connector owns its
 * own, so naming one provider's states in the contract made every consumer of this package depend on
 * that provider (SKG-516).
 */
export const SEED_STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type SeedStage = (typeof SEED_STAGES)[number];

/**
 * What a connector reports for a state it does not recognise.
 *
 * The tolerance is the contract's, not the connector's. A provider gains a state, or a team renames
 * one, and the pin still has to be drawn — dropping it would make someone's note vanish from the page
 * because a workflow column was added.
 */
export const DEFAULT_SEED_STAGE: SeedStage = 'seeded';

/*
 * `SEED_STAGE_STYLES` used to live here, carrying an `emoji`, a `label` and a `color` per stage. All
 * three are gone (SKG-517), and each for its own reason:
 *
 * - **`color`** was already dead. SKG-528 moved every colour into the widget's `theme.ts` as a
 *   `--fruitback-stage-*` token, so a host can repaint the stages; nothing had read this field since.
 * - **`emoji`** was a rendering decision travelling in a published type. A consumer of this package
 *   could not change it, and the widget could not drop it without a major version. It is the widget's
 *   business now, and by default there is no glyph at all — the pin's shape and colour carry the
 *   stage (SKG-529).
 * - **`label`** was an English string in a contract, which is untranslatable by anyone downstream.
 *   The vocabulary is `SEED_STAGES`; the *words* belong to whoever renders them. The widget keeps its
 *   own map (`stages.ts`), ready for SKG-530 to make it locale-aware, and each store names its own
 *   states in `stateName`.
 *
 * The pattern is SKG-516's, one level further in: the contract holds the vocabulary, and every
 * projection onto something a human sees belongs to the side doing the showing.
 */

/**
 * A reply from the team, as the widget shows it (SKG-502).
 *
 * Part of the **read envelope**, not of the seed: comments live in Linear and are fetched, never
 * stored in the description. Nothing here affects the round trip, so `SEED_VERSION` does not move.
 */
export const seedCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  createdAt: z.string(),
  /** Absent when Linear returns a comment with no user — an integration, or a deleted account. */
  author: z.string().optional(),
});

export type SeedComment = z.infer<typeof seedCommentSchema>;

/**
 * What the worker sends back to the widget for one planted seed (M4 / SKG-499). Kept here because
 * both ends validate against it.
 */
export const seedIssueSchema = z.object({
  id: z.string().min(1),
  /** Human handle, e.g. `SKG-491` from Linear, `FB-12` from a store that numbers its own. */
  identifier: z.string().min(1),
  /**
   * Where a human can open this note in the store's own interface — **when the store has one**
   * (SKG-524).
   *
   * Optional because SQLite has no web interface at all, and the only way to keep this required was
   * to invent a URL that goes nowhere. A pin whose link leads back to the page it is already on is
   * worse than a pin with no link: it looks like the store lost the note. The widget renders the
   * link only when this is present.
   *
   * Read-envelope field, like `comments`: nothing here is stored in a seed, so `SEED_VERSION` does
   * not move.
   */
  url: z.string().min(1).optional(),
  title: z.string(),
  stage: z.enum(SEED_STAGES),
  stateName: z.string(),
  updatedAt: z.string(),
  /**
   * Oldest first, so the thread reads as a conversation. Absent means the worker did not ask for
   * them; empty means it did and there were none — the widget says something different for each.
   */
  comments: z.array(seedCommentSchema).optional(),
  seed: seedSchema,
});

export type SeedIssue = z.infer<typeof seedIssueSchema>;

/**
 * The `description contains` term used to fetch the seeds of one page. It works because
 * `buildSeedBlock` writes the canonical URL verbatim into the JSON.
 */
export function pageQueryTerm(url: string | URL): string {
  return canonicalizePageUrl(url);
}
