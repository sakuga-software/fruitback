/**
 * An OAuth application of the worker, as a variable of the environment gives it (FRU-97): the GitHub
 * App and the Google client of better-auth, and the Linear application of a connector.
 */

/** `<client id>:<client secret>` of an OAuth application. */
export type OAuthClient = { clientId: string; clientSecret: string };

export function parseOAuthClient(value: string): OAuthClient | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return { clientId: value.slice(0, separator).trim(), clientSecret: value.slice(separator + 1).trim() };
}
