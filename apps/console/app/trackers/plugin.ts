/**
 * A connector that comes as a plugin (FRU-621), as the console draws it: its card in « Add a
 * connector », its form when it connects by a token, its mark and its name. The worker says which
 * plugins it has, and how each connects there (`GET /connectors`, `trackers`).
 *
 * Each kind has its file in this folder, `<kind>.ts`, and its French in `<kind>.fr.ts`: a connector
 * edits no list that another one edits too. The sentences that every plugin says (its way back from
 * OAuth, its refusals, its panel) are in `parts/connector-plugin.tsx`, with the name of the service
 * as `{source}`.
 */

/** The kinds of the plugins, as the worker lists them (`apps/worker/src/trackers/kinds.ts`). */
export const PLUGIN_KINDS = ['jira', 'gitlab', 'slack', 'clickup', 'asana'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export function isPluginKind(value: unknown): value is PluginKind {
  return typeof value === 'string' && (PLUGIN_KINDS as readonly string[]).includes(value);
}

/** A mark: a path in its box, filled, or drawn as lines of 1.5 px at 16 px (`connector-marks.tsx`). */
export type PluginMark = { box: 16 | 24; path: string; lines?: true };

/** A field of the form of a token. `label`, `hint` and `placeholder` are marked with `msg`. */
export type TokenField = {
  /** The name of the field in the body of `POST /connectors`. */
  name: string;
  label: string;
  type: 'text' | 'password' | 'url';
  hint?: string;
  placeholder?: string;
  /** A field that may stay empty: it is then not sent. */
  optional?: true;
};

export type ConsoleTracker = {
  kind: PluginKind;
  /** What a note becomes there, under the name of its card. Marked with `msg`. */
  detail: string;
  mark: PluginMark;
  /** The fields of the form, for a plugin that connects by a token. */
  tokenFields?: readonly TokenField[];
  /** What a refusal of the form means, by the word of the worker, beside the ones every plugin has. */
  problems?: Readonly<Record<string, string>>;
  /** The line under the name of a connector, from the label the worker wrote. Absent: the label. */
  sourceLine?(label: string): string;
};
