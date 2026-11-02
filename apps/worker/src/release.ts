import worker from '../package.json' with { type: 'json' };

/**
 * « Fruitback 0.7.0 is out » on the screen « Instance » of the administrator (FRU-520): the version
 * this worker runs, and the last release when it is newer.
 *
 * **The source is the last release on GitHub**, as for the extension (FRU-519,
 * `apps/extension/src/update-notice.ts`). The image of a release carries the same number: the
 * versions of the packages move together (`.changeset/config.json`, `fixed`), and the tag `vX.Y.Z`
 * names them.
 *
 * The worker asks once a day at most, and only when an administrator opens the screen. The request
 * carries no cookie and nothing of the instance, but GitHub sees the address of the server.
 * `FRUITBACK_NO_UPDATE_CHECK=1` stops it.
 */

/** The version of this worker: the one of its package, which the release sets. */
export const WORKER_VERSION: string = worker.version;

/** The last release of the repository: GitHub leaves the drafts and the pre-releases out. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/sakuga-software/fruitback/releases/latest';

/** The pages of the releases. A link that points elsewhere is not given to the console. */
const RELEASES_PAGE = 'https://github.com/sakuga-software/fruitback/releases/';

/** One answer of GitHub serves a day: GitHub allows 60 requests an hour to an address. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** After a failure, the next visit after this time asks again. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * How long GitHub has to answer. The screen waits for it, so it stays short. After it, the screen
 * shows no line, and the next try waits `RETRY_AFTER_MS`.
 */
export const FETCH_TIMEOUT_MS = 3000;

export type Release = { version: string; url: string };

/** The numbers of a version « 1.2.3 », or `undefined` for anything else. */
function parts(version: string): number[] | undefined {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) return undefined;

  return version.split('.').map(Number);
}

/** Whether `candidate` comes after `running`. A version that is not « 1.2.3 » never does. */
export function isNewer(candidate: string, running: string): boolean {
  const a = parts(candidate);
  const b = parts(running);
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
  if (typeof tag !== 'string' || typeof url !== 'string') return undefined;
  const version = tag.replace(/^v/, '');
  if (parts(version) === undefined || !url.startsWith(RELEASES_PAGE)) return undefined;

  return { version, url };
}

export type ReleaseCheckDeps = {
  /** The version of this worker. `WORKER_VERSION` outside a test. */
  running: string;
  /** The answer of `LATEST_RELEASE_API`, already read as JSON. Throws when there is none. */
  fetchLatest: (signal: AbortSignal) => Promise<unknown>;
  now: () => number;
  /** `FETCH_TIMEOUT_MS`, shorter in a test. */
  timeoutMs?: number;
};

/**
 * Runs `fetch` with a signal that aborts after `ms`, and rejects then even when `fetch` ignores the
 * signal: the screen of the administrator waits for this answer.
 */
async function withTimeout<T>(fetch: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer in ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fetch(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The check of one process: a function that gives the release to tell the administrator about, or
 * `undefined`. It keeps the last answer in memory. Two visits at the same time share one request.
 */
export function releaseCheck(deps: ReleaseCheckDeps): () => Promise<Release | undefined> {
  let known: Release | undefined;
  let askAgainAt = 0;
  let asking: Promise<void> | undefined;

  const ask = async (): Promise<void> => {
    try {
      const release = parseRelease(await withTimeout(deps.fetchLatest, deps.timeoutMs ?? FETCH_TIMEOUT_MS));
      if (release !== undefined) known = release;
      askAgainAt = deps.now() + (release === undefined ? RETRY_AFTER_MS : CHECK_EVERY_MS);
    } catch {
      askAgainAt = deps.now() + RETRY_AFTER_MS;
    }
  };

  return async () => {
    if (!(deps.now() < askAgainAt)) {
      asking ??= ask().finally(() => {
        asking = undefined;
      });
      await asking;
    }

    return known !== undefined && isNewer(known.version, deps.running) ? known : undefined;
  };
}

/** The check of the server: it asks GitHub with the `fetch` of Node, with no cookie and no referrer. */
export function githubReleaseCheck(): () => Promise<Release | undefined> {
  return releaseCheck({
    running: WORKER_VERSION,
    now: Date.now,
    fetchLatest: async (signal) => {
      const answer = await fetch(LATEST_RELEASE_API, {
        signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `fruitback-worker/${WORKER_VERSION}` },
        redirect: 'error',
      });
      if (!answer.ok) throw new Error(`GitHub answered ${answer.status}`);

      return answer.json();
    },
  });
}
