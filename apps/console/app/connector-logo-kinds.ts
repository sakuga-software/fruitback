/**
 * The kinds that have a logo on the Connectors screen (FRU-690), and where the console serves each
 * one: `public/logos/<kind>.svg`. Apart from `connector-logos.tsx`, so that a guard reads them.
 */
export const LOGO_KINDS = [
  'linear',
  'jira',
  'github',
  'gitlab',
  'asana',
  'clickup',
  'trello',
  'notion',
  'slack',
  'webhook',
  'rest',
  'claude-routine',
] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

/** Where the console serves the logo of a kind. */
export function logoPath(kind: LogoKind): string {
  return `/logos/${kind}.svg`;
}

export function hasLogo(kind: string): kind is LogoKind {
  return (LOGO_KINDS as readonly string[]).includes(kind);
}
