/**
 * The path is one of the settings of the workspace: `/settings` or a page under it, as `/settings/ai`
 * (FRU-544). Not a path that only starts with the same letters, as `/settingsX`.
 */
export function underSettings(pathname: string, workspace: string): boolean {
  const settings = `/w/${workspace}/settings`;

  return pathname === settings || pathname.startsWith(`${settings}/`);
}
