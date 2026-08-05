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

/** Deliberately shouty: this line is the only thing standing between the payload and an editor. */
export const SEED_BLOCK_CAPTION = '🌱 **Fruitback seed** · machine-readable, do not edit';

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
  lines.push(`**Reported by** · ${seed.reporter?.name ?? seed.reporter?.email ?? 'Anonymous'}`);

  if (seed.client) {
    lines.push(`**Client** · ${seed.client.name ?? seed.client.id}`);
  }

  return lines;
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
 * Linear workflow state types, mapped to how ripe the pin looks on the page. This is the whole
 * status story: the widget never stores a status of its own, it renders Linear's.
 */
export const LINEAR_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  // Real state type on the SKG team ("Duplicate"), and absent from Linear's documented list.
  'duplicate',
] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

export const SEED_STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type SeedStage = (typeof SEED_STAGES)[number];

export const SEED_STAGE_STYLES: Record<SeedStage, { emoji: string; label: string; color: string }> = {
  seeded: { emoji: '🌱', label: 'Seeded', color: '#A3B18A' },
  green: { emoji: '🍏', label: 'Green', color: '#7CB342' },
  ripening: { emoji: '🍊', label: 'Ripening', color: '#FB8C00' },
  ripe: { emoji: '🍓', label: 'Ripe', color: '#E53935' },
  composted: { emoji: '🍂', label: 'Composted', color: '#8D6E63' },
};

const STAGE_BY_STATE_TYPE: Record<LinearStateType, SeedStage> = {
  triage: 'seeded',
  backlog: 'seeded',
  unstarted: 'green',
  started: 'ripening',
  completed: 'ripe',
  canceled: 'composted',
  duplicate: 'composted',
};

/** Unknown state types fall back to `seeded` rather than hiding the pin. */
export function stageForLinearState(stateType: string): SeedStage {
  return STAGE_BY_STATE_TYPE[stateType as LinearStateType] ?? 'seeded';
}

/**
 * What the worker sends back to the widget for one planted seed (M4 / SKG-499). Kept here because
 * both ends validate against it.
 */
export const seedIssueSchema = z.object({
  id: z.string().min(1),
  /** Human handle, e.g. `SKG-491`. */
  identifier: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  stage: z.enum(SEED_STAGES),
  stateName: z.string(),
  updatedAt: z.string(),
  commentCount: z.number().int().nonnegative().optional(),
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
