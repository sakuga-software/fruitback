import {
  createSeed,
  type Seed,
  type SeedClient,
  type SeedReporter,
  type SeedScreenshot,
  type SeedSource,
} from '@sakuga/fruitback-shared';
import { captureAnchor } from './anchor.ts';
import { captureEnv, capturePage, captureViewport } from './page.ts';
import { readReactSource } from './source.ts';

/**
 * One click plus one note, assembled into the payload the worker stores.
 *
 * This is the only place the widget builds a seed, and it goes through `createSeed`, so an anchor
 * that came out malformed fails here — in the reporter's browser, with a message — rather than as a
 * `400 invalid-seed` after the note was typed.
 */

export type CaptureSeedOptions = {
  /** The element the reporter clicked. */
  element: Element;
  note: string;
  /** Defaults to the element's own window. Passed explicitly when capturing inside an iframe. */
  view?: Window;
  client?: SeedClient;
  /** Client-asserted and unverified until SKG-498 — the worker treats it as a claim, not identity. */
  reporter?: SeedReporter;
  screenshot?: SeedScreenshot;
  /**
   * What react-grab resolved for this element. Wins over the fiber fallback in `source.ts`
   * **field by field**, rather than wholesale: on a design system react-grab gets the file and the
   * line right while dropping the component name (see `engine.ts`), and the fallback is exactly what
   * knows the name. Taking either one entire would throw away the half the other got right.
   */
  source?: SeedSource;
  /** Off when the reporter has not agreed to send their user agent along. */
  includeEnv?: boolean;
  /** Injected by the tests, and by anything that needs the seed to be reproducible. */
  id?: string;
  createdAt?: string;
};

export function captureSeed(options: CaptureSeedOptions): Seed {
  const { element, note, includeEnv = true } = options;
  const view = options.view ?? element.ownerDocument.defaultView;
  if (view === null) {
    throw new Error('captureSeed: the element belongs to a document with no window');
  }

  const seed = {
    id: options.id ?? newSeedId(view),
    createdAt: options.createdAt ?? new Date().toISOString(),
    note,
    page: capturePage(view),
    viewport: captureViewport(view),
    anchor: captureAnchor(element),
    ...optional(
      'source',
      mergeSource(options.source, () => readReactSource(element)),
    ),
    ...optional('client', options.client),
    ...optional('reporter', options.reporter),
    ...optional('env', includeEnv ? captureEnv(view) : undefined),
    ...optional('screenshot', options.screenshot),
  };

  return createSeed(seed);
}

const SOURCE_FIELDS = ['component', 'file', 'line', 'column'] as const;

/**
 * The engine's answer, completed by the fiber walk's — never the other way round.
 *
 * Nothing is invented here: a field absent from both stays absent, which is what keeps the seed
 * round-trip free of values the widget cannot rebuild.
 *
 * The fallback is passed unevaluated because it is a walk up the fiber tree on every capture, and
 * there is nothing for it to add once the engine has answered in full.
 */
function mergeSource(
  engine: SeedSource | undefined,
  readFallback: () => SeedSource | undefined,
): SeedSource | undefined {
  if (engine !== undefined && SOURCE_FIELDS.every((field) => engine[field] !== undefined)) return engine;

  const fallback = readFallback();
  if (engine === undefined) return fallback;
  if (fallback === undefined) return engine;

  const merged = { ...fallback, ...engine };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Spread rather than assigned, because the round-trip forbids writing a key the caller did not
 * provide: `{ client: undefined }` survives `JSON.stringify` as an absent key but not as an absent
 * *field* everywhere it is compared.
 */
function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}

/**
 * Generated client-side, and only has to be unique among the seeds of one workspace — it dedupes a
 * retry and keys the pin across reloads. `randomUUID` needs a secure context, which a staging site
 * on http does not have, hence the fallback.
 */
function newSeedId(view: Window): string {
  return `sd_${randomHex(view, SEED_ID_HEX_LENGTH)}`;
}

/** Twelve hex characters — 48 bits, and the same shape whichever branch below produced it. */
const SEED_ID_HEX_LENGTH = 12;

function randomHex(view: Window, length: number): string {
  const crypto = view.crypto;

  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '').slice(0, length);

  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));

    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  }

  // `Math.random().toString(16)` is not a fixed-width string — `0.5` prints as `0.8` — so the digits
  // are padded and accumulated rather than sliced out of one draw.
  let hex = '';
  while (hex.length < length) {
    hex += Math.floor(Math.random() * 0x1_0000)
      .toString(16)
      .padStart(4, '0');
  }

  return hex.slice(0, length);
}
