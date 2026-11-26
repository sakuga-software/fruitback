import type { AccountStore } from './accounts.ts';
import type { Channel } from './notes-index.ts';

/**
 * When the widget was last seen on a site (FRU-721): the console says « Installed » and « Seen on the
 * site 2 h ago » from it. The worker learns it from the read of the pins of a page (`GET /feedback`),
 * which the widget sends when it mounts: no call of its own, nothing more for the widget to send.
 *
 * **What is kept**: one date per site and per way (`script`, `extension`), in `sites`. No page, no
 * address, no person: `docs/privacy.md` names the two columns.
 *
 * **At most one write an hour per site and per way.** This process remembers what it wrote, so a
 * read in the hour after asks nothing of the database; the store writes only a date an hour old, so
 * two processes write once. A write that fails is said in the log, and the read goes on: a date is
 * never worth a page that does not load.
 *
 * **It proves nothing.** The way is `extension` for a session of the workspace that the worker
 * verifies, and `script` for a read with the `Origin` of the site, which any program can write. The
 * date says that a page asked, not who: it gives no right, and nothing reads it but the console.
 */

/** How long a date stays: no write for the same site and way in that time. */
export const SEEN_EVERY_MS = 3_600_000;

/** What this process wrote last, by site and way. A process that starts writes once more. */
const written = new Map<string, number>();

/** Forgets what this process wrote: for a test that plays two processes. */
export function forgetSeen(): void {
  written.clear();
}

/**
 * Writes that the widget read a page of `site` by `channel`, when this process did not write it in
 * the last hour. `channel` is asked only then: telling an extension from a script verifies a token.
 */
export async function seeSite(
  accounts: Pick<AccountStore, 'markSiteSeen'>,
  site: string,
  channel: () => Promise<Channel | undefined>,
  now: number,
): Promise<void> {
  const fresh = (way: Channel) => now - (written.get(`${site}:${way}`) ?? Number.NEGATIVE_INFINITY) < SEEN_EVERY_MS;
  if (fresh('script') && fresh('extension')) return;
  try {
    const way = await channel();
    if (way === undefined || fresh(way)) return;
    await accounts.markSiteSeen(site, way, now);
    written.set(`${site}:${way}`, now);
  } catch (error) {
    console.error(
      `[fruitback] the visit of a site was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
