import { tracker as asana } from './asana.ts';
import { tracker as clickup } from './clickup.ts';
import { tracker as gitlab } from './gitlab.ts';
import { tracker as jira } from './jira.ts';
import { type ConsoleTracker, PLUGIN_KINDS, type PluginKind, isPluginKind } from './plugin.ts';
import { tracker as slack } from './slack.ts';

/**
 * The plugins this console knows (FRU-621). Each kind has its file, which a connector fills in when
 * it ships: no connector edits this list.
 */
const SHIPPED: Readonly<Record<PluginKind, ConsoleTracker | undefined>> = { jira, gitlab, slack, clickup, asana };

/** The plugin of a kind, or `undefined` for a kind that is no plugin, or whose plugin has not shipped here. */
export function trackerOf(kind: unknown): ConsoleTracker | undefined {
  return isPluginKind(kind) ? SHIPPED[kind] : undefined;
}

/** The plugins of this console, in the order of `PLUGIN_KINDS`. */
export function shippedTrackers(): ConsoleTracker[] {
  return PLUGIN_KINDS.flatMap((kind) => {
    const found = SHIPPED[kind];

    return found === undefined ? [] : [found];
  });
}
