/**
 * The words of a note as a short line shows them, and the dates a store writes (FRU-509). The pin,
 * the list of the page and the detached notes read them the same way.
 */

/** The first line of a text that has words, trimmed, or `undefined` for a text of blanks. */
export function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** The first line of a text, cut to `max` characters with « … », or `undefined` for a text of blanks. */
export function excerpt(text: string, max: number): string | undefined {
  const line = firstLine(text);
  if (line === undefined) return undefined;

  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A date as a store or a host wrote it, or `undefined` for a shape `Date` cannot read. */
export function readDate(written: string): Date | undefined {
  const date = new Date(written);

  return Number.isNaN(date.getTime()) ? undefined : date;
}
