import { z } from 'zod';

/**
 * A **note** is one piece of visual feedback planted on an element of a live page.
 *
 * It is the only contract shared by the three moving parts of Fruitback:
 * the widget writes it, the worker relays it into Linear, and the widget reads it back to
 * re-plant the pin on the page. Everything else can be rewritten; this shape cannot change
 * silently.
 *
 * Two rules keep the round-trip lossless — write ↦ Linear ↦ read must return the same object:
 * no schema default values, and no field the widget cannot rebuild from the stored payload.
 */

/** Discriminator that lets us recognise our own JSON among anything else in a description. */
export const NOTE_KIND = 'fruitback.note';

/**
 * The version a note is written with, and the only one a reader takes (FRU-378).
 *
 * It starts at 3: versions 1 and 2 had another kind, which `rewrite-notes` of the worker 0.4.0 turned
 * into this one, once, in the trackers and in the database. A reader refuses a newer version rather than
 * silently drop the fields it does not know.
 */
export const NOTE_VERSION = 3;

/** Text excerpts are a re-anchoring hint, not content — keep them short. */
export const TEXT_EXCERPT_MAX_LENGTH = 160;

/** Linear titles are short; notes are not. Guard against a runaway paste. */
export const NOTE_MAX_LENGTH = 5_000;

const finite = z.number().finite();

const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'expected an ISO 8601 timestamp',
});

// Stryker disable BlockStatement: an empty catch returns `undefined`, which `refine` refuses as it refuses `false`. The range is the whole declaration, because a directive cannot lead a `catch`.
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

// Stryker restore BlockStatement

/**
 * Where the pin sits, as a share of the **document** box (not the viewport) so it survives a
 * different window size. Used to re-place a pin whose element can no longer be resolved, and to
 * detect drift when it can.
 */
export const noteBoundsSchema = z.object({
  xPct: finite,
  yPct: finite,
  wPct: finite,
  hPct: finite,
});

/**
 * Deliberately redundant: every field is an independent way to find the element again after the
 * site has been redeployed. Resolution order lives in the widget, not here — see
 * `NOTE_ANCHOR_STRATEGIES` for the intended precedence.
 */
export const noteAnchorSchema = z.object({
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
  bounds: noteBoundsSchema,
});

/** Precedence the widget applies when re-planting a pin (M4 / FRU-11). */
export const NOTE_ANCHOR_STRATEGIES = ['selector', 'testId', 'text', 'domPath', 'bounds'] as const;
export type NoteAnchorStrategy = (typeof NOTE_ANCHOR_STRATEGIES)[number];

/**
 * `url` is the canonical form produced by `canonicalizePageUrl` and is the grouping key for
 * "show me the notes of this page". It appears verbatim in the Linear description, which is what
 * makes a `description contains <url>` filter usable server-side.
 */
export const notePageSchema = z.object({
  url: httpUrl,
  path: z.string().min(1),
  title: z.string().optional(),
});

export const noteViewportSchema = z.object({
  width: finite,
  height: finite,
  /** `devicePixelRatio`, needed to read screenshots taken on a retina screen. */
  dpr: finite.optional(),
});

/** react-grab's payoff: the component and file behind the element. Dev/preview builds only. */
export const noteSourceSchema = z.object({
  component: z.string().optional(),
  file: z.string().optional(),
  line: finite.optional(),
  column: finite.optional(),
});

/** Which client site this note came from — drives the Linear team/label mapping (M5). */
export const noteClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});

/**
 * Absent means anonymous. The worker decides what it trusts; the widget only reports.
 *
 * **`verified` is the worker's word, never the client's** (FRU-9). A browser can put any name and
 * any address in here — that is what the popover's optional fields are — so a reader has to be able
 * to tell a claim from an identity the worker checked against a signed token. The worker strips this
 * flag from anything that arrives with it, and sets it only after verifying.
 *
 * It is a `true` literal rather than a boolean so that "not verified" stays *absent* rather than
 * `false`: the round-trip forbids a field the caller did not provide.
 */
export const noteReporterSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  verified: z.literal(true).optional(),
});

export const noteEnvSchema = z.object({
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  platform: z.string().optional(),
});

/** Filled in by the worker once the capture is uploaded as a Linear attachment (M2 / FRU-6). */
export const noteScreenshotSchema = z.object({
  url: httpUrl.optional(),
  width: finite.optional(),
  height: finite.optional(),
});

export const noteSchema = z.object({
  kind: z.literal(NOTE_KIND),
  v: z.literal(NOTE_VERSION),
  /** Generated client-side. Dedupes retries and keys the pin across reloads. */
  id: z.string().min(1),
  createdAt: isoTimestamp,
  /** What the visitor actually wrote. Stored here too so the round-trip stays lossless. */
  text: z.string().max(NOTE_MAX_LENGTH),
  page: notePageSchema,
  viewport: noteViewportSchema,
  anchor: noteAnchorSchema,
  source: noteSourceSchema.optional(),
  client: noteClientSchema.optional(),
  reporter: noteReporterSchema.optional(),
  env: noteEnvSchema.optional(),
  screenshot: noteScreenshotSchema.optional(),
});

export type Note = z.infer<typeof noteSchema>;
export type NoteAnchor = z.infer<typeof noteAnchorSchema>;
export type NoteBounds = z.infer<typeof noteBoundsSchema>;
export type NotePage = z.infer<typeof notePageSchema>;
export type NoteViewport = z.infer<typeof noteViewportSchema>;
export type NoteSource = z.infer<typeof noteSourceSchema>;
export type NoteClient = z.infer<typeof noteClientSchema>;
export type NoteReporter = z.infer<typeof noteReporterSchema>;
export type NoteEnv = z.infer<typeof noteEnvSchema>;
export type NoteScreenshot = z.infer<typeof noteScreenshotSchema>;

/** What a caller supplies; `kind` and `v` are stamped by `createNote`. */
export type NoteInput = Omit<Note, 'kind' | 'v'>;

export type NoteParseFailure =
  /** No Fruitback payload in there at all. */
  | { ok: false; reason: 'not-found' }
  /** Written by a newer Fruitback than this one — refuse rather than silently drop fields. */
  | { ok: false; reason: 'unsupported-version'; version: number }
  | { ok: false; reason: 'invalid'; message: string };

export type NoteParseResult = { ok: true; note: Note } | NoteParseFailure;

/** Build a validated note, stamping the current kind and version. Throws on an invalid input. */
export function createNote(input: NoteInput): Note {
  return noteSchema.parse({ ...input, kind: NOTE_KIND, v: NOTE_VERSION });
}

/**
 * Validate an untrusted value as a note. Never throws — the caller is usually parsing a Linear
 * description a human may have edited.
 *
 * It reads `NOTE_KIND` at `NOTE_VERSION` only. A payload of another kind is `not-found`, a block of
 * before FRU-378 included.
 */
export function parseNote(value: unknown): NoteParseResult {
  if (!isNoteShaped(value)) {
    return { ok: false, reason: 'not-found' };
  }

  const version = value.v;
  if (
    !Number.isInteger(version) ||
    // Stryker disable next-line ConditionalExpression: `Number.isInteger` above refused a value that is not a number already. This narrows `unknown` for TypeScript.
    typeof version !== 'number' ||
    version < 1
  ) {
    return { ok: false, reason: 'invalid', message: 'missing or malformed note version' };
  }

  if (version > NOTE_VERSION) {
    return { ok: false, reason: 'unsupported-version', version };
  }
  if (version < NOTE_VERSION) {
    return { ok: false, reason: 'invalid', message: `v: ${NOTE_KIND} starts at version ${NOTE_VERSION}` };
  }

  const result = noteSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, reason: 'invalid', message: formatIssues(result.error) };
  }

  return { ok: true, note: result.data };
}

/** Cheap `kind` check, so an unrelated JSON block reports `not-found` rather than `invalid`. */
function isNoteShaped(value: unknown): value is Record<string, unknown> {
  // A string or a number has no `kind` either; only `null` and `undefined` need the `?.`.
  const kind = (value as { kind?: unknown } | null | undefined)?.kind;

  return kind === NOTE_KIND;
}

function formatIssues(error: z.ZodError): string {
  // `isNoteShaped` lets only an object through, and no rule of the schema sits on the object itself,
  // so every issue has a path.
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/**
 * Query parameters that identify a campaign, not a page. Two visitors landing on the same screen
 * through different ads must produce notes that group together.
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
