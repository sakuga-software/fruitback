import { browser } from 'wxt/browser';
import { updateLine } from './kit.ts';
import { type Checked, LATEST_RELEASE_API, LATEST_RELEASE_KEY, availableUpdate } from './update-notice.ts';

/** The release this extension is behind, over the real manifest, storage and network (FRU-519). */
export function browserAvailableUpdate(): ReturnType<typeof availableUpdate> {
  return availableUpdate({
    installed: browser.runtime.getManifest().version,
    // `getSelf` asks for no permission, in Chromium and in Firefox. Safari may not have it.
    installType: async () => (await browser.management?.getSelf())?.installType,
    read: async () =>
      ((await browser.storage.local.get(LATEST_RELEASE_KEY)) as Record<string, unknown>)[LATEST_RELEASE_KEY],
    write: (checked: Checked) => browser.storage.local.set({ [LATEST_RELEASE_KEY]: checked }),
    fetchLatest: async () => {
      const response = await fetch(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

      return (await response.json()) as unknown;
    },
    now: () => Date.now(),
  });
}

/** Puts the line of a new release where `place` says, once the answer is known. Nothing when none. */
export async function showUpdateLine(place: (line: HTMLElement) => void): Promise<void> {
  const release = await browserAvailableUpdate().catch(() => undefined);
  if (release !== undefined) place(updateLine(document, release));
}
