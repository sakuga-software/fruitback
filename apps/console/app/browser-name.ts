/**
 * The browser of a user agent, in a word: what « Technical details » of the panel of a note sums up
 * (FRU-687). Edge and Chrome both say « Safari », and Edge says « Chrome »: the most precise word
 * is read first. A browser it does not know is `undefined`, and the panel says the screen alone.
 */
export function browserOf(agent: string | undefined): string | undefined {
  if (agent === undefined) return undefined;
  if (/Edg\//u.test(agent)) return 'Edge';
  if (/Firefox\//u.test(agent)) return 'Firefox';
  if (/Chrome\//u.test(agent)) return 'Chrome';
  if (/Safari\//u.test(agent)) return 'Safari';

  return undefined;
}
