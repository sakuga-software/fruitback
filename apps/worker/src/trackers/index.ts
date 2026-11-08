import { plugin as asana } from './asana.ts';
import { plugin as clickup } from './clickup.ts';
import { plugin as gitlab } from './gitlab.ts';
import { plugin as jira } from './jira.ts';
import { PLUGIN_KINDS, type PluginKind, isPluginKind } from './kinds.ts';
import type { TrackerPlugin } from './plugin.ts';
import { plugin as slack } from './slack.ts';

/**
 * The plugins of this build (FRU-621). Each kind of `PLUGIN_KINDS` has its file, which a connector
 * fills in when it ships: no connector edits this list.
 */
const SHIPPED: Readonly<Record<PluginKind, TrackerPlugin | undefined>> = { jira, gitlab, slack, clickup, asana };

/** For the tests: a plugin set here wins over the one of the build, until `withoutTestPlugins`. */
const forTests = new Map<PluginKind, TrackerPlugin>();

/** The plugin of a kind, or `undefined` for a kind that is no plugin, or whose plugin has not shipped. */
export function pluginOf(kind: unknown): TrackerPlugin | undefined {
  if (!isPluginKind(kind)) return undefined;

  return forTests.get(kind) ?? SHIPPED[kind];
}

/** The plugins that this build has, in the order of `PLUGIN_KINDS`. */
export function shippedPlugins(): TrackerPlugin[] {
  return PLUGIN_KINDS.flatMap((kind) => {
    const found = pluginOf(kind);

    return found === undefined ? [] : [found];
  });
}

export function useTestPlugin(plugin: TrackerPlugin): void {
  forTests.set(plugin.kind, plugin);
}

export function withoutTestPlugins(): void {
  forTests.clear();
}
