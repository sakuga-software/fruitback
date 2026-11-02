/**
 * The type guards that the parsers of the extension share (FRU-511).
 *
 * A record is a plain object: `null` and an array are not records. Before FRU-511, four copies of
 * `isRecord` accepted an array and two refused it. An array where a record is expected is
 * malformed, so each parser now refuses it at the guard.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
