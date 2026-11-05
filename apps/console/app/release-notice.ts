/**
 * The banner that says a newer release is out (FRU-520), to the administrator of the instance.
 *
 * « Dismiss » keeps the version in this browser: the banner of that version does not come back, and
 * the banner of a later version does. The screen « Instance » always says the release.
 */

const STORED = 'fruitback:release-dismissed';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The version that this browser dismissed, or `null`. */
export function dismissedRelease(): string | null {
  try {
    return storage()?.getItem(STORED) ?? null;
  } catch {
    // Private browsing can refuse storage. The banner shows.
    return null;
  }
}

/** Keeps `version` as dismissed. A refused storage keeps it for this page only. */
export function dismissRelease(version: string): void {
  try {
    storage()?.setItem(STORED, version);
  } catch {
    // Not kept: the banner comes back on the next page load.
  }
}

/** The release that the banner says, or `null`: none, or the one this browser dismissed. */
export function releaseToAnnounce<Release extends { version: string }>(
  release: Release | null,
  dismissed: string | null,
): Release | null {
  return release === null || release.version === dismissed ? null : release;
}
