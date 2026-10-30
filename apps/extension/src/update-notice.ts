/**
 * « Fruitback 0.6.0 is out » (FRU-519): the line the popup and the options page show when this
 * extension is older than the last release.
 *
 * **Only an install that no store updates asks.** The Chrome Web Store, and a policy of an
 * administrator, update the extension on their own. A folder loaded by hand (`development`), an
 * archive put there by another program (`sideload`) and Firefox's temporary add-on stay on their
 * version until the reviewer installs another. `management.getSelf` says which, and it asks for no
 * permission. A browser without it asks nothing.
 *
 * **The source is the last release on GitHub**, the page `reviewing.md` sends a reviewer to for the
 * archive. The worker says no version: `/health` and the routes of a session carry none. The API of
 * GitHub answers any origin (`Access-Control-Allow-Origin: *`), so the request needs no host
 * permission. It carries nothing of the reviewer, and it goes once a day at most.
 *
 * `runtime.requestUpdateCheck` does not serve this: it asks the store of the install, and a folder
 * loaded by hand has no store. Firefox does not have it.
 */

/** The last release of the repository: GitHub leaves the drafts and the pre-releases out. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/sakuga-software/fruitback/releases/latest';

/** The pages of the releases. A link that points elsewhere is not followed. */
const RELEASES_PAGE = 'https://github.com/sakuga-software/fruitback/releases/';

/** Where the answer of GitHub is kept, in `storage.local`. */
export const LATEST_RELEASE_KEY = 'latestRelease';

/** One request a day at most: GitHub allows 60 an hour to an address, and a release is rare. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** The install types that no store updates. `normal` and `admin` update on their own. */
const UPDATED_BY_HAND: ReadonlySet<string> = new Set(['development', 'sideload', 'other']);

export type Release = { version: string; url: string };

/** What `storage.local` keeps: the last release seen, and when GitHub was asked. */
export type Checked = { checkedAt: number; release?: Release };

/** Whether an install stays on its version until somebody installs another. */
export function updatedByHand(installType: string | undefined): boolean {
  return installType !== undefined && UPDATED_BY_HAND.has(installType);
}

/** The numbers of a version « 1.2.3 », or `undefined` for anything else. */
function parts(version: string): number[] | undefined {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) return undefined;

  return version.split('.').map(Number);
}

/** Whether `candidate` comes after `installed`. A version that is not « 1.2.3 » never does. */
export function isNewer(candidate: string, installed: string): boolean {
  const a = parts(candidate);
  const b = parts(installed);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }

  return false;
}

/** The release in an answer of GitHub: its tag `v1.2.3` and its page. `undefined` for anything else. */
export function parseRelease(body: unknown): Release | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { tag_name: tag, html_url: url } = body as { tag_name?: unknown; html_url?: unknown };
  if (typeof tag !== 'string') return undefined;

  return validRelease(tag.replace(/^v/, ''), url);
}

function validRelease(version: unknown, url: unknown): Release | undefined {
  if (typeof version !== 'string' || typeof url !== 'string') return undefined;
  if (parts(version) === undefined || !url.startsWith(RELEASES_PAGE)) return undefined;

  return { version, url };
}

function parseChecked(value: unknown): Checked | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { checkedAt, release: kept } = value as { checkedAt?: unknown; release?: unknown };
  if (typeof checkedAt !== 'number') return undefined;
  const { version, url } = typeof kept === 'object' && kept !== null ? (kept as Partial<Release>) : {};
  const parsed = validRelease(version, url);

  return parsed === undefined ? { checkedAt } : { checkedAt, release: parsed };
}

export type UpdateDeps = {
  /** The version of this extension, from its manifest. */
  installed: string;
  /** The install type of `management.getSelf`, or `undefined` when the browser does not say. */
  installType: () => Promise<string | undefined>;
  read: () => Promise<unknown>;
  write: (checked: Checked) => Promise<void>;
  /** The answer of `LATEST_RELEASE_API`, already read as JSON. Throws when there is none. */
  fetchLatest: () => Promise<unknown>;
  now: () => number;
};

/**
 * The release to tell the reviewer about, or `undefined`. It asks GitHub only when the last answer
 * is a day old, and an error of the network keeps what was known: the line is never worth a problem.
 */
export async function availableUpdate(deps: UpdateDeps): Promise<Release | undefined> {
  if (!updatedByHand(await deps.installType().catch(() => undefined))) return undefined;

  let checked = parseChecked(await deps.read().catch(() => undefined));
  if (checked === undefined || !(deps.now() - checked.checkedAt < CHECK_EVERY_MS)) {
    try {
      const release = parseRelease(await deps.fetchLatest());
      checked = release === undefined ? { checkedAt: deps.now() } : { checkedAt: deps.now(), release };
      await deps.write(checked);
    } catch {
      // Offline, or GitHub refused: the line waits for the next opening.
    }
  }

  const release = checked?.release;

  return release !== undefined && isNewer(release.version, deps.installed) ? release : undefined;
}

/** Puts the line in a shell of the popup, above its foot, once. The gallery draws it the same way. */
export function intoPopup(screen: Element, line: HTMLElement): void {
  if (screen.contains(line)) return;
  screen.insertBefore(line, screen.querySelector(':scope > .popup-foot'));
}
