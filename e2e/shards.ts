import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The spec files of one part of the E2E suite on CI, chosen by their duration (FRU-268).
 *
 * `--shard` of Playwright cuts the suite by the count of tests. The tests of the extension are few
 * and slow, so the part that got them took twice the time of another one: 1335, 665 and 967 s of
 * tests on run 40720268982. The parts are chosen here from `durations.json`, the seconds that each
 * file took on CI, so that each part ends at about the same time.
 *
 * A part runs its files on `workers` workers. Playwright gives each worker the next file in the
 * order of the paths, and a file stays on one worker. The time of a part is the time of its busiest
 * worker in that order, and each file goes, longest first, to the part where that time grows least.
 *
 * A new spec file is not in `durations.json`: it counts as the mean of the files that are. Every spec
 * file of the folder is in exactly one part, whatever the file holds. `pnpm e2e:durations` writes
 * the file again from the log of a run (`tools/ci/e2e-durations.ts`).
 */

export const SPEC = /\.spec\.ts$/;

/** The time of a part: its files, in the order of their paths, each on the first free worker. */
export function partSeconds(files: readonly string[], seconds: (file: string) => number, workers: number): number {
  const busy: number[] = Array.from({ length: workers }, () => 0);
  for (const file of files.toSorted()) {
    const free = busy.indexOf(Math.min(...busy));
    busy[free] = (busy[free] ?? 0) + seconds(file);
  }

  return Math.max(...busy);
}

/** `files` in `parts` parts, by their `durations` in seconds. The files of each part are sorted. */
export function partsOf(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  parts: number,
  workers: number,
): string[][] {
  const known = files.map((file) => durations[file]).filter((each): each is number => each !== undefined);
  const mean = known.length === 0 ? 1 : known.reduce((sum, each) => sum + each, 0) / known.length;
  const seconds = (file: string): number => durations[file] ?? mean;
  const total = (part: readonly string[]): number => part.reduce((sum, file) => sum + seconds(file), 0);

  const out: string[][] = Array.from({ length: parts }, () => []);
  // The name breaks a tie, so every job of the matrix computes the same parts.
  const longestFirst = files.toSorted((a, b) => seconds(b) - seconds(a) || a.localeCompare(b));
  for (const file of longestFirst) {
    let best = 0;
    let bestKey: [number, number] | undefined;
    out.forEach((part, index) => {
      const key: [number, number] = [partSeconds([...part, file], seconds, workers), total(part)];
      if (bestKey === undefined || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = index;
        bestKey = key;
      }
    });
    out[best]?.push(file);
  }

  return out.map((part) => part.toSorted());
}

/** `2/3` → `{ index: 2, total: 3 }`. Throws on anything else: a part that runs nothing proves nothing. */
export function shardOf(value: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || index < 1 || total < 1 || index > total) {
    throw new Error(`E2E_SHARD is « ${value} », not « <part>/<parts> » with 1 <= part <= parts`);
  }

  return { index, total };
}

/** The spec files of the part `value` (`2/3`) of `dir`, as names in that folder. */
export function filesOfShard(value: string, dir: string, workers: number): string[] {
  const { index, total } = shardOf(value);
  const files = readdirSync(dir).filter((name) => SPEC.test(name));
  const durations = JSON.parse(readFileSync(join(dir, 'durations.json'), 'utf8')) as Record<string, number>;

  return partsOf(files, durations, total, workers)[index - 1] ?? [];
}
