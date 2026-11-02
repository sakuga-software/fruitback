/**
 * Largest first. Under a minute is counted in seconds, and `numeric: 'auto'` says "now" for zero. The
 * side panel of the extension counts its ages with the same units (FRU-512).
 */
export const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];
