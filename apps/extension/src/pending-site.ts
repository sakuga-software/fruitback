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
 * It holds no credential: an entry is a worker address, a mode and a client id. An intent to add a
 * site (FRU-454) is a worker address, a workspace and what was chosen for the site.
 */
export const PENDING_KEY = 'fruitback:pending-site';

/** After this long a draft is somebody's old attempt, and it must not turn a site on by surprise. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * A site of no workspace that « Turn on » adds to one (FRU-454): the worker, the workspace, and what
 * was chosen on the screen (FRU-453). The entry is known once the worker added the site, so the
 * intent holds what adds it, and the one who settles adds it.
 */
export type PendingAdd = {
  endpoint: string;
  workspace: { id: string; name: string };
  settings?: PendingSettings;
};

export type PendingSettings = {
  visibility?: 'members' | 'everyone';
  place?: { connector: string; teamId?: string; projectId?: string } | null;
};

export type PendingSite = { pattern: string; at: number } & ({ site: SiteConfig } | { add: PendingAdd });

/** What adding the site gave: its entry, nothing yet (asked again at the next settle), or never. */
export type AddOutcome = SiteConfig | 'again' | 'never';

export function parsePending(value: unknown): PendingSite | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { pattern, site, add, at } = value as { pattern?: unknown; site?: unknown; add?: unknown; at?: unknown };
  if (typeof pattern !== 'string' || pattern === '' || typeof at !== 'number') return undefined;
  if (add !== undefined) {
    const parsedAdd = parseAdd(add);

    return parsedAdd === undefined ? undefined : { pattern, add: parsedAdd, at };
  }
  const parsed = parseSite(site);

  return parsed === undefined ? undefined : { pattern, site: parsed, at };
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= 2_048;

function parseAdd(value: unknown): PendingAdd | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { endpoint, workspace, settings } = value as Record<string, unknown>;
  if (!text(endpoint) || typeof workspace !== 'object' || workspace === null) return undefined;
  const { id, name } = workspace as Record<string, unknown>;
  if (!text(id) || typeof name !== 'string') return undefined;
  const chosen = settings === undefined ? {} : parseSettings(settings);
  if (chosen === undefined) return undefined;

  return {
    endpoint,
    workspace: { id, name },
    ...(Object.keys(chosen).length === 0 ? {} : { settings: chosen }),
  };
}

function parseSettings(value: unknown): PendingSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { visibility, place } = value as Record<string, unknown>;
  if (visibility !== undefined && visibility !== 'members' && visibility !== 'everyone') return undefined;
  let chosen: PendingSettings['place'];
  if (place === null) chosen = null;
  else if (place !== undefined) {
    if (typeof place !== 'object') return undefined;
    const { connector, teamId, projectId } = place as Record<string, unknown>;
    if (!text(connector)) return undefined;
    if (teamId !== undefined && !text(teamId)) return undefined;
    if (projectId !== undefined && !text(projectId)) return undefined;
    chosen = {
      connector,
      ...(teamId === undefined ? {} : { teamId }),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }

  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(chosen === undefined ? {} : { place: chosen }),
  };
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
  /**
   * Adds a site of no workspace to the one chosen (FRU-454), with what was chosen for it, and
   * answers its entry. Absent: an intent to add is left for a context that can.
   */
  add?: (pattern: string, add: PendingAdd) => Promise<AddOutcome>;
  now?: () => number;
};

export type Pending = {
  /** WARNING: call this before `permissions.request` and do not await it: an await loses the gesture. */
  remember(pattern: string, site: SiteConfig): Promise<void>;
  /** The same, for a site that the worker adds first (FRU-454). Same WARNING. */
  rememberAdd(pattern: string, add: PendingAdd): Promise<void>;
  /** Finishes the intent when the access is there. Answers the pattern it turned on, or nothing. */
  settle(): Promise<string | undefined>;
  /** The values somebody typed for this pattern, while the intent is fresh. */
  draft(pattern: string): Promise<SiteConfig | undefined>;
  forget(): Promise<void>;
  /**
   * Forgets the intent to add a site on `pattern` (FRU-454), and no other: the intent of another
   * site, written since by another click, stays for whoever settles it (raised in review).
   */
  forgetAdd(pattern: string): Promise<void>;
};

export function createPending({
  read: readStored,
  write,
  clear,
  granted,
  store,
  activate,
  add,
  now = Date.now,
}: PendingSeams): Pending {
  async function fresh(): Promise<PendingSite | undefined> {
    const pending = parsePending(await readStored());
    if (pending === undefined) return undefined;
    if (now() - pending.at > PENDING_TTL_MS) {
      await clear();

      return undefined;
    }

    return pending;
  }

  /**
   * One at a time inside this context. The background and the popup each hold their own instance, so
   * the two can still finish the same intent together. That is safe, and it is why `store` and
   * `activate` must stay idempotent: the entry goes through the one writer of the sites map, which
   * writes the same value twice, and both scripts refuse to run twice in one frame.
   */
  let settling: Promise<string | undefined> | undefined;

  /**
   * Clears the intent that was read, and not one written since: an add waits for the worker, and a
   * click on another site in that time writes its own intent in the same key (raised in review).
   */
  async function clearIfStill(read: PendingSite): Promise<void> {
    const now = parsePending(await readStored());
    if (now !== undefined && now.pattern === read.pattern && now.at === read.at) await clear();
  }

  async function finish(): Promise<string | undefined> {
    const pending = await fresh();
    if (pending === undefined || !(await granted(pending.pattern))) return undefined;

    let site: SiteConfig;
    if ('add' in pending) {
      if (add === undefined) return undefined;
      const outcome = await add(pending.pattern, pending.add);
      if (outcome === 'again') return undefined;
      // Refused for good (a role, a session that ended): nothing to turn on, and nothing to ask again.
      if (outcome === 'never') {
        await clearIfStill(pending);

        return undefined;
      }
      site = outcome;
    } else {
      site = pending.site;
    }

    await store(pending.pattern, site);
    // Cleared after the entry is stored: a failure between the two leaves the intent to try again.
    await clearIfStill(pending);
    await activate(pending.pattern);

    return pending.pattern;
  }

  return {
    remember: (pattern, site) => write({ pattern, site, at: now() }),
    rememberAdd: (pattern, intent) => write({ pattern, add: intent, at: now() }),
    settle() {
      settling ??= finish().finally(() => {
        settling = undefined;
      });

      return settling;
    },
    async draft(pattern) {
      const pending = await fresh();

      return pending !== undefined && pending.pattern === pattern && 'site' in pending ? pending.site : undefined;
    },
    forget: clear,
    async forgetAdd(pattern) {
      const pending = parsePending(await readStored());
      if (pending !== undefined && pending.pattern === pattern && 'add' in pending) await clear();
    },
  };
}
