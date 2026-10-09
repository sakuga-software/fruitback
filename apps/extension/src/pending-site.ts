import { type SiteConfig, parseSite } from './sites.ts';

/**
 * A site somebody asked to turn on, kept while the browser asks for access (FRU-117, FRU-118).
 *
 * The permission prompt can close the popup, and the code after `permissions.request` then never
 * runs: the grant exists, the entry was never written, and the fields somebody typed are gone. The
 * intent is written before the prompt, so two things can finish it:
 *
 * - the background, when `permissions.onAdded` says the access arrived;
 * - the popup, when it opens again and finds the access granted.
 *
 * A refused prompt leaves the intent as a draft, and the form shows its values again.
 *
 * It holds no credential: an entry is a worker address, a mode and a client id.
 */
export const PENDING_KEY = 'fruitback:pending-site';

/** After this long a draft is somebody's old attempt, and it must not turn a site on by surprise. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export type PendingSite = { pattern: string; site: SiteConfig; at: number };

export function parsePending(value: unknown): PendingSite | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { pattern, site, at } = value as { pattern?: unknown; site?: unknown; at?: unknown };
  const parsed = parseSite(site);
  if (typeof pattern !== 'string' || pattern === '' || typeof at !== 'number' || parsed === undefined) return undefined;

  return { pattern, site: parsed, at };
}

export type PendingSeams = {
  read: () => Promise<unknown>;
  write: (pending: PendingSite) => Promise<void>;
  clear: () => Promise<void>;
  /** Whether the browser holds the access this pattern needs. */
  granted: (pattern: string) => Promise<boolean>;
  /** Stores the entry, through the one writer of the sites map. */
  store: (pattern: string, site: SiteConfig) => Promise<void>;
  /** Puts the scripts in the tabs already open on the pattern. */
  activate: (pattern: string) => Promise<void>;
  now?: () => number;
};

export type Pending = {
  /** WARNING: call this before `permissions.request` and do not await it: an await loses the gesture. */
  remember(pattern: string, site: SiteConfig): Promise<void>;
  /** Finishes the intent when the access is there. Answers the pattern it turned on, or nothing. */
  settle(): Promise<string | undefined>;
  /** The values somebody typed for this pattern, while the intent is fresh. */
  draft(pattern: string): Promise<SiteConfig | undefined>;
  forget(): Promise<void>;
};

export function createPending({ read, write, clear, granted, store, activate, now = Date.now }: PendingSeams): Pending {
  async function fresh(): Promise<PendingSite | undefined> {
    const pending = parsePending(await read());
    if (pending === undefined) return undefined;
    if (now() - pending.at > PENDING_TTL_MS) {
      await clear();

      return undefined;
    }

    return pending;
  }

  /** One at a time: the background and the popup can both hear that the access arrived. */
  let settling: Promise<string | undefined> | undefined;

  async function finish(): Promise<string | undefined> {
    const pending = await fresh();
    if (pending === undefined || !(await granted(pending.pattern))) return undefined;

    await store(pending.pattern, pending.site);
    // Cleared after the entry is stored: a failure between the two leaves the intent to try again.
    await clear();
    await activate(pending.pattern);

    return pending.pattern;
  }

  return {
    remember: (pattern, site) => write({ pattern, site, at: now() }),
    settle() {
      settling ??= finish().finally(() => {
        settling = undefined;
      });

      return settling;
    },
    async draft(pattern) {
      const pending = await fresh();

      return pending?.pattern === pattern ? pending.site : undefined;
    },
    forget: clear,
  };
}
