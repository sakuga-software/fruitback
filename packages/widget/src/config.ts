import { SEED_STAGES, type SeedStage } from '@fruitback/shared';

/**
 * What the reporter can change about the widget, and where it is kept (SKG-503).
 *
 * **What is not here is the point.** The ticket asked for the Linear team, project and labels too,
 * and they are deliberately absent: since SKG-504 the worker resolves those from the client id it is
 * given, and refuses an id it does not know. A browser that could name its own team would either be
 * ignored — a setting that does nothing is worse than no setting — or obeyed, which would let any
 * page write into any workspace. The client id is the one thing the reporter can say; what it routes
 * to stays server-side.
 *
 * Everything below is a preference of this browser on this site. None of it travels in a seed.
 */

export type WidgetConfig = {
  /** Where the worker answers. */
  endpoint: string;
  /** Which client this site is, as the worker's map knows it. */
  clientId: string;
  /** Stages whose pins are not drawn. `ripe` and `composted` are what "resolved" means. */
  hiddenStages: SeedStage[];
  /**
   * Attach an image of the element to the note (SKG-495). **Off by default**, and only offered when
   * the embedder gave `init` something to capture with — a switch that controls nothing is worse
   * than no switch.
   */
  screenshot: boolean;
};

export type ConfigStore = {
  get(): WidgetConfig;
  /** Merge a change in, persist it, and tell whoever is listening. */
  set(patch: Partial<WidgetConfig>): void;
  subscribe(listener: (config: WidgetConfig) => void): () => void;
};

export type ConfigStoreOptions = {
  /** Used for whatever the stored config does not say. */
  defaults: WidgetConfig;
  /**
   * Defaults to `localStorage`. Pass `null` to keep the config in memory — which is also what
   * happens by itself when the browser refuses storage.
   */
  storage?: Storage | null;
  key?: string;
  /**
   * Fields the caller owns outright, which a stored config must never override.
   *
   * The store reads its key from the page's own `localStorage`, and the page can write it. For an
   * ordinary embed that is the feature: the reporter's preferences outlive the reload, the endpoint
   * included, because the panel is where it is edited. For a caller whose routing was decided
   * somewhere else it is the opposite — a stored value wins over the new default for ever, so
   * changing the endpoint in the extension's popup would never take effect on a site the reporter
   * had already set a preference on, and a page that wrote that key would send the notes to a worker
   * nobody chose. Raised in review.
   */
  pinned?: readonly (keyof WidgetConfig)[];
};

export const CONFIG_STORAGE_KEY = 'fruitback:config';

/** The stages a reporter usually stops caring about: done, and cancelled. */
export const RESOLVED_STAGES: SeedStage[] = ['ripe', 'composted'];

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const key = options.key ?? CONFIG_STORAGE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set<(config: WidgetConfig) => void>();

  const stored = readStored(storage, key);
  for (const field of options.pinned ?? []) delete stored[field];

  let config = seal({ ...options.defaults, ...stored });

  return {
    get: () => config,
    set(patch) {
      config = seal({ ...config, ...patch });
      write(storage, key, config);
      for (const listener of listeners) listener(config);
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

/**
 * Copied, then frozen.
 *
 * `get` hands the same object to everyone and is called once per pin, so copying on the way out
 * would be both wasteful and easy to forget. Freezing on the way in costs nothing per read and turns
 * a caller who mutates the config — or the array they passed to `set` — into a `TypeError` here
 * rather than into state that changed without being persisted or announced.
 */
function seal(config: WidgetConfig): WidgetConfig {
  return Object.freeze({ ...config, hiddenStages: Object.freeze([...config.hiddenStages]) }) as WidgetConfig;
}

/**
 * Reading `localStorage` can throw rather than return null.
 *
 * Safari in private browsing and a browser with site data disabled both raise on the property
 * itself, so this is not a null check. A widget that cannot start on a page with cookies turned off
 * is a widget nobody can debug.
 */
function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Tolerant on the way in, like `parseSeed`: this is a string a human can edit in devtools, and a
 * malformed one must cost the reporter their preferences, not the widget.
 */
function readStored(storage: Storage | null, key: string): Partial<WidgetConfig> {
  if (storage === null) return {};

  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const stored = parsed as Record<string, unknown>;
    const config: Partial<WidgetConfig> = {};

    if (typeof stored.endpoint === 'string') config.endpoint = stored.endpoint;
    if (typeof stored.clientId === 'string') config.clientId = stored.clientId;
    if (typeof stored.screenshot === 'boolean') config.screenshot = stored.screenshot;
    if (Array.isArray(stored.hiddenStages)) config.hiddenStages = stored.hiddenStages.filter(isStage);

    return config;
  } catch {
    return {};
  }
}

function write(storage: Storage | null, key: string, config: WidgetConfig): void {
  try {
    storage?.setItem(key, JSON.stringify(config));
  } catch {
    // Full, or refused. The config still applies for this page; it just will not outlive it.
  }
}

function isStage(value: unknown): value is SeedStage {
  return typeof value === 'string' && (SEED_STAGES as readonly string[]).includes(value);
}
