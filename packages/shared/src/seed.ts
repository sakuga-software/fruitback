import { z } from 'zod';

/**
 * A **seed** is one piece of visual feedback planted on an element of a live page.
 *
 * It is the only contract shared by the three moving parts of Fruitback:
 * the widget writes it, the worker relays it into Linear, and the widget reads it back to
 * re-plant the pin on the page. Everything else can be rewritten; this shape cannot change
 * silently.
 *
 * Two rules keep the round-trip lossless — write ↦ Linear ↦ read must return the same object:
 * no schema default values, and no field the widget cannot rebuild from the stored payload.
 */

/** Bump only when the payload shape changes. Readers accept older versions, refuse newer ones. */
export const SEED_VERSION = 1;

/** Discriminator that lets us recognise our own JSON among anything else in a description. */
export const SEED_KIND = 'fruitback.seed';

/** Text excerpts are a re-anchoring hint, not content — keep them short. */
export const TEXT_EXCERPT_MAX_LENGTH = 160;

/** Linear titles are short; notes are not. Guard against a runaway paste. */
export const NOTE_MAX_LENGTH = 5_000;

const finite = z.number().finite();

const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'expected an ISO 8601 timestamp',
});

const httpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'expected an absolute http(s) URL' },
);

/**
 * Where the pin sits, as a share of the **document** box (not the viewport) so it survives a
 * different window size. Used to re-place a pin whose element can no longer be resolved, and to
 * detect drift when it can.
 */
export const seedBoundsSchema = z.object({
  xPct: finite,
  yPct: finite,
  wPct: finite,
  hPct: finite,
});

/**
 * Deliberately redundant: every field is an independent way to find the element again after the
 * site has been redeployed. Resolution order lives in the widget, not here — see
 * `SEED_ANCHOR_STRATEGIES` for the intended precedence.
 */
export const seedAnchorSchema = z.object({
  /** Most specific selector we could build that still looked stable (ids and test ids favoured). */
  selector: z.string().min(1),
  /** Structural fallback: `:nth-child` chain from `<html>`. Brittle alone, useful as a tiebreak. */
  domPath: z.string().min(1).optional(),
  tag: z.string().min(1),
  /** Trimmed excerpt of the element's text, for content-based matching. */
  text: z.string().max(TEXT_EXCERPT_MAX_LENGTH).optional(),
  /** Identity-ish attributes worth matching on when the selector misses. */
  attrs: z
    .object({
      id: z.string(),
      testId: z.string(),
      name: z.string(),
      role: z.string(),
      ariaLabel: z.string(),
    })
    .partial()
    .optional(),
  bounds: seedBoundsSchema,
});

/** Precedence the widget applies when re-planting a pin (M4 / SKG-500). */
export const SEED_ANCHOR_STRATEGIES = ['selector', 'testId', 'text', 'domPath', 'bounds'] as const;
export type SeedAnchorStrategy = (typeof SEED_ANCHOR_STRATEGIES)[number];

/**
 * `url` is the canonical form produced by `canonicalizePageUrl` and is the grouping key for
 * "show me the seeds of this page". It appears verbatim in the Linear description, which is what
 * makes a `description contains <url>` filter usable server-side.
 */
export const seedPageSchema = z.object({
  url: httpUrl,
  path: z.string().min(1),
  title: z.string().optional(),
});

export const seedViewportSchema = z.object({
  width: finite,
  height: finite,
  /** `devicePixelRatio`, needed to read screenshots taken on a retina screen. */
  dpr: finite.optional(),
});

/** react-grab's payoff: the component and file behind the element. Dev/preview builds only. */
export const seedSourceSchema = z.object({
  component: z.string().optional(),
  file: z.string().optional(),
  line: finite.optional(),
  column: finite.optional(),
});

/** Which client site this seed came from — drives the Linear team/label mapping (M5). */
export const seedClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});

/** Absent means anonymous. The worker decides what it trusts; the widget only reports. */
export const seedReporterSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});

export const seedEnvSchema = z.object({
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  platform: z.string().optional(),
});

/** Filled in by the worker once the capture is uploaded as a Linear attachment (M2 / SKG-495). */
export const seedScreenshotSchema = z.object({
  url: httpUrl.optional(),
  width: finite.optional(),
  height: finite.optional(),
});

export const seedSchema = z.object({
  kind: z.literal(SEED_KIND),
  v: z.number().int().positive(),
  /** Generated client-side. Dedupes retries and keys the pin across reloads. */
  id: z.string().min(1),
  createdAt: isoTimestamp,
  /** What the visitor actually wrote. Stored here too so the round-trip stays lossless. */
  note: z.string().max(NOTE_MAX_LENGTH),
  page: seedPageSchema,
  viewport: seedViewportSchema,
  anchor: seedAnchorSchema,
  source: seedSourceSchema.optional(),
  client: seedClientSchema.optional(),
  reporter: seedReporterSchema.optional(),
  env: seedEnvSchema.optional(),
  screenshot: seedScreenshotSchema.optional(),
});

export type Seed = z.infer<typeof seedSchema>;
export type SeedAnchor = z.infer<typeof seedAnchorSchema>;
export type SeedBounds = z.infer<typeof seedBoundsSchema>;
export type SeedPage = z.infer<typeof seedPageSchema>;
export type SeedViewport = z.infer<typeof seedViewportSchema>;
export type SeedSource = z.infer<typeof seedSourceSchema>;
export type SeedClient = z.infer<typeof seedClientSchema>;
export type SeedReporter = z.infer<typeof seedReporterSchema>;
export type SeedScreenshot = z.infer<typeof seedScreenshotSchema>;

/** What a caller supplies; `kind` and `v` are stamped by `createSeed`. */
export type SeedInput = Omit<Seed, 'kind' | 'v'>;

export type SeedParseFailure =
  /** No Fruitback payload in there at all. */
  | { ok: false; reason: 'not-found' }
  /** Written by a newer Fruitback than this one — refuse rather than silently drop fields. */
  | { ok: false; reason: 'unsupported-version'; version: number }
  | { ok: false; reason: 'invalid'; message: string };

export type SeedParseResult = { ok: true; seed: Seed } | SeedParseFailure;

/** Build a validated seed, stamping the current kind and version. Throws on an invalid input. */
export function createSeed(input: SeedInput): Seed {
  return seedSchema.parse({ ...input, kind: SEED_KIND, v: SEED_VERSION });
}

/**
 * Validate an untrusted value as a seed. Never throws — the caller is usually parsing a Linear
 * description a human may have edited.
 */
export function parseSeed(value: unknown): SeedParseResult {
  if (!isSeedShaped(value)) {
    return { ok: false, reason: 'not-found' };
  }

  const version = value.v;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid', message: 'missing or malformed seed version' };
  }
  if (version > SEED_VERSION) {
    return { ok: false, reason: 'unsupported-version', version };
  }

  const result = seedSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, reason: 'invalid', message: formatIssues(result.error) };
  }

  return { ok: true, seed: result.data };
}

/** Cheap `kind` check, so an unrelated JSON block reports `not-found` rather than `invalid`. */
function isSeedShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).kind === SEED_KIND;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Query parameters that identify a campaign, not a page. Two visitors landing on the same screen
 * through different ads must produce seeds that group together.
 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^dclid$/i,
  /^fbclid$/i,
  /^igshid$/i,
  /^msclkid$/i,
  /^ttclid$/i,
  /^twclid$/i,
  /^yclid$/i,
  /^li_fat_id$/i,
  /^mc_(cid|eid)$/i,
  /^_g(a|l)$/i,
];

/**
 * The stable identity of a page.
 *
 * Fragment and tracking parameters are dropped, the host is lowercased, a default port and a
 * trailing slash are removed, and the remaining parameters are sorted — so the same screen always
 * produces the same key, whichever link the visitor followed. Kept meaningful parameters (`?tab=2`)
 * still separate two screens that share a path.
 *
 * @throws if `input` is not an absolute URL.
 */
export function canonicalizePageUrl(input: string | URL, options: { keepSearch?: boolean } = {}): string {
  const { keepSearch = true } = options;
  const url = new URL(input.toString());

  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();

  if (keepSearch) {
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
  } else {
    url.search = '';
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  // `URL` already strips the default port; `toString()` keeps a bare `?` out of the result.
  return url.toString();
}
