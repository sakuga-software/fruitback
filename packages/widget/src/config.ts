import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import { DESTINATION_ID_MAX } from './destinations.ts';

/**
 * What the reporter can change about the widget, and where it is kept (FRU-14).
 *
 * **What is not here is the point.** The ticket asked for the Linear team, project and labels too,
 * and they are deliberately absent: since FRU-15 the worker resolves those from the client id it is
 * given, and refuses an id it does not know. A browser that could name its own team would either be
 * ignored — a setting that does nothing is worse than no setting — or obeyed, which would let any
 * page write into any workspace.
 *
 * **The worker and the client id are absent too** (FRU-89). They are the word of the caller of
 * `init`, and a reporter cannot use them. A stored copy let a page that wrote this key choose where
 * the notes go, so a stored `endpoint` or `clientId` is not read.
 *
 * Everything below is a preference of this browser on this site. None of it travels in a seed.
 */

export type WidgetConfig = {
  /** Stages whose pins are not drawn. `ripe` and `composted` are what "resolved" means. */
  hiddenStages: SeedStage[];
  /**
   * Attach an image of the element to the note (FRU-6). **Off by default**, and only offered when
   * the embedder gave `init` something to capture with — a switch that controls nothing is worse
   * than no switch.
   */
  screenshot: boolean;
  /**
   * The name the reporter signs a note with, kept only when the reporter ticks the box that asks for
   * it (FRU-91). Absent by default: the widget remembers nobody who did not ask.
   */
  reporterName?: string;
  /**
   * The place the reporter last chose for a note, as the opaque id the worker gave (FRU-123). Absent
   * until somebody chooses.
   *
   * It is a preference and not a route, which is what keeps it apart from the `endpoint` this store
   * refuses to hold (FRU-89). The composer follows it only when the worker offers that id to this
   * reader now, it shows the place on its line, and the worker checks the id again on the write. A
   * page that writes this key can do no more than choose first among the places the reader may use.
   */
  destination?: string;
};

type Optional = 'reporterName' | 'destination';

/** A change to the config. `reporterName: undefined` forgets the name, and `destination` likewise. */
export type ConfigPatch = Partial<Omit<WidgetConfig, Optional>> & { [Key in Optional]?: string | undefined };

export type ConfigStore = {
  get(): WidgetConfig;
  /** Merge a change in, persist it, and tell whoever is listening. */
  set(patch: ConfigPatch): void;
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
};

export const CONFIG_STORAGE_KEY = 'fruitback:config';

/** The stages a reporter usually stops caring about: done, and cancelled. */
export const RESOLVED_STAGES: SeedStage[] = ['ripe', 'composted'];

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const key = options.key ?? CONFIG_STORAGE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set<(config: WidgetConfig) => void>();

  let config = seal({ ...options.defaults, ...readStored(storage, key) });

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
function seal(config: Omit<WidgetConfig, Optional> & { [Key in Optional]?: string | undefined }): WidgetConfig {
  const { reporterName, destination, ...rest } = config;
  const name = reporterName?.trim().slice(0, REPORTER_NAME_MAX) ?? '';
  // Longer than an id can be: dropped, never cut, because a cut id is another id.
  const place = destination !== undefined && destination.length <= DESTINATION_ID_MAX ? destination : '';

  return Object.freeze({
    ...rest,
    hiddenStages: Object.freeze([...config.hiddenStages]),
    // Absent, never empty: a key that stays in storage with no value reads as a name that was kept.
    ...(name.length > 0 ? { reporterName: name } : {}),
    ...(place.length > 0 ? { destination: place } : {}),
  }) as WidgetConfig;
}

/** A name is a few words. The limit keeps a page that wrote the key from storing a document here. */
const REPORTER_NAME_MAX = 120;

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

    if (typeof stored.screenshot === 'boolean') config.screenshot = stored.screenshot;
    if (typeof stored.reporterName === 'string') config.reporterName = stored.reporterName;
    if (typeof stored.destination === 'string') config.destination = stored.destination;
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
