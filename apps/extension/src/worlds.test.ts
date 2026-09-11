import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The token never reaches the page's world, asserted from the build rather than from a promise.
 *
 * SKG-535 stated it and SKG-599 has to keep it: an access token that the host site's JavaScript can
 * read is the worst outcome of this batch. A content script with `world: 'MAIN'` runs in the page's
 * own realm, so anything it can reach, the page can reach.
 *
 * **Written as an allowlist, not a denylist.** Naming the files that must stay clean would pass a
 * main-world entrypoint added next year without anyone noticing. Instead the entrypoints are
 * discovered — every `*.content.ts` that declares `world: 'MAIN'` — and what each one can reach is
 * computed from its imports. A new one is covered on the day it is written, and a session module
 * added later is covered because the rule names a prefix rather than a list of files. Raised in
 * review of the plan for this ticket.
 *
 * What it cannot see: the workspace packages a main-world file imports. `@fruitback/widget` is the
 * one that matters, and it is kept clean the other way round — the widget takes a `transport` seam
 * (SKG-595) and never learns that a session exists.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Anything under this prefix holds or moves a session credential. */
const SECRET_PREFIX = 'session';

/** Names that must not appear in code a page can read, whatever route they arrived by. */
const SECRET_NAMES = ['refreshToken', 'accessToken'];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The entrypoints that run in the page's own realm.
 *
 * Discovered rather than listed, which is the whole point: `registration.ts` decides which built
 * file gets `world: 'MAIN'`, and the entrypoint that produces it is the one declaring it here.
 *
 * **Detected on the code, not on the file.** `page.content.ts` opens with a paragraph about why
 * `world: 'MAIN'` is the ticket, so a plain search kept the file in this list after the declaration
 * itself had changed — the guard then ran against a file that no longer reached the page at all,
 * and reported three passes. Found by mutating the declaration and watching nothing fail.
 */
function mainWorldEntrypoints(): string[] {
  const directory = resolve(ROOT, 'entrypoints');

  return readdirSync(directory)
    .filter((name) => name.endsWith('.content.ts'))
    .map((name) => resolve(directory, name))
    .filter((path) => /world:\s*'MAIN'/.test(codeOf(read(path))));
}

/** Every file the page's world ends up with, following this app's own relative imports. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);

    for (const match of read(path).matchAll(/\bfrom\s+'(\.[^']*)'/g)) {
      queue.push(resolve(dirname(path), match[1] as string));
    }
  }

  return [...seen];
}

/**
 * The source with its comments removed.
 *
 * `protocol.ts` explains at length why no token travels on its channel, so a search for the word
 * would fail on the paragraph that promises it does not happen. What is asserted is the code.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

describe('the page world can reach nothing that holds a session', () => {
  const entrypoints = mainWorldEntrypoints();

  /** A guard over an empty set passes. Say so here rather than discover it after a rename. */
  it('finds the main-world entrypoints it is written to guard', () => {
    assert.ok(entrypoints.length > 0, "no entrypoint declares world: 'MAIN'; this guard now checks nothing");
  });

  it('imports no session module, however many files away', () => {
    for (const entry of entrypoints) {
      const offenders = reachableFrom(entry)
        .filter((path) => basename(path).startsWith(SECRET_PREFIX))
        .map((path) => relative(ROOT, path));

      assert.deepEqual(
        offenders,
        [],
        `${relative(ROOT, entry)} runs in the page's world and reaches ${offenders.join(', ')}`,
      );
    }
  });

  /** The same rule for a file that carries a token without importing the module that keeps it. */
  it('names no session credential in code the page can read', () => {
    for (const entry of entrypoints) {
      for (const path of reachableFrom(entry)) {
        const code = codeOf(read(path));
        for (const name of SECRET_NAMES) {
          assert.ok(
            !code.includes(name),
            `${relative(ROOT, path)} runs in, or is imported into, the page's world and names ${name}`,
          );
        }
      }
    }
  });
});
