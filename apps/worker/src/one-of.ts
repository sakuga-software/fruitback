/**
 * Whether a value read from a request, a row or a file is one of a list of literals (FRU-507). A
 * guard: past it, the value has the type of the list, with no cast.
 */
export function isOneOf<T>(value: unknown, among: readonly T[]): value is T {
  return (among as readonly unknown[]).includes(value);
}
