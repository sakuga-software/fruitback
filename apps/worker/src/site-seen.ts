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

/**
 * How long a claim of the extension that did not check is not checked again, by site: a read with a
 * bad token costs one verification a minute, not one a read. A session of the site that comes in that
 * minute is written at a later read. The script is not held so: its check compares the `Origin`, and
 * costs nothing.
 */
export const REFUSED_FOR_MS = 60_000;

/** At most so many sites and ways remembered: past it, each map is emptied, as in `last-seen.ts`. */
const MAX_REMEMBERED = 10_000;

/** What this process wrote last, by site and way. A process that starts writes once more. */
const written = new Map<string, number>();
/** When a claim last did not check, by site and way. */
const refused = new Map<string, number>();

/** Forgets what this process wrote and refused: for a test that plays two processes. */
export function forgetSeen(): void {
  written.clear();
  refused.clear();
}

function remember(map: Map<string, number>, key: string, now: number): void {
  if (map.size >= MAX_REMEMBERED) map.clear();
  map.set(key, now);
}

/**
 * Writes that the widget read a page of `site` by `way`, when this process did not write it in the
 * last hour. `way` is what the request claims (a token: the extension; none: the script); `confirm`
 * checks it, and is asked only when a write is due: telling a session of the extension verifies a
 * token, and a read in the hour after a write verifies nothing more.
 */
export async function seeSite(
  accounts: Pick<AccountStore, 'markSiteSeen'>,
  site: string,
  way: Channel,
  confirm: () => Promise<boolean>,
  now: number,
): Promise<void> {
  const key = `${site}:${way}`;
  if (now - (written.get(key) ?? Number.NEGATIVE_INFINITY) < SEEN_EVERY_MS) return;
  if (now - (refused.get(key) ?? Number.NEGATIVE_INFINITY) < REFUSED_FOR_MS) return;
  try {
    if (!(await confirm())) {
      if (way === 'extension') remember(refused, key, now);

      return;
    }
    await accounts.markSiteSeen(site, way, now);
    remember(written, key, now);
    refused.delete(key);
  } catch (error) {
    console.error(
      `[fruitback] the visit of a site was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
