/**
 * The kinds of the connectors that come as a plugin (FRU-621): each one lives in its own file of
 * `trackers/`, and nothing else names it. The list is here, apart from `index.ts`, so that
 * `accounts.ts` reads it with no import of a plugin.
 *
 * A kind is listed before its plugin exists: a row of a worker of after, that names it, is read, and
 * its connector says that this worker cannot use it.
 */
export const PLUGIN_KINDS = ['jira', 'gitlab', 'slack', 'clickup', 'asana'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export function isPluginKind(value: unknown): value is PluginKind {
  return typeof value === 'string' && (PLUGIN_KINDS as readonly string[]).includes(value);
}
