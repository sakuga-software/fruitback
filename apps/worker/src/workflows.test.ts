import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

/**
 * Every action a workflow uses is pinned to a commit SHA, with its version as a comment (SKG-608).
 *
 * A tag can move to other code, and `release-image.yml` runs with `packages: write`. Dependabot moves
 * a pin that exists, but it does not pin a new step, so this test is what holds the rule.
 *
 * The workflows are parsed as YAML, never matched line by line: `uses : x`, a quoted key, a flow
 * mapping and a value on the next line are all the same key to GitHub.
 *
 * It lives beside `compose.test.ts`, which also reads files outside this package, because the root has
 * no `test` target.
 */

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url);

/** `owner/repo@<40 hex>`, or the same for an action in a subdirectory of its repository. */
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/** The version comment that must follow a pinned action on its line. */
const VERSION_COMMENT = /# v\d+(\.\d+){0,2}\s*$/;

type Reference = { where: string; value: string; rest: string };

/** Every `uses` value in one workflow, with the text that follows it on its line. */
function referencesIn(file: string, source: string): Reference[] {
  const document = parseDocument(source);
  assert.deepEqual(document.errors, [], `${file} is not valid YAML`);
  const references: Reference[] = [];

  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'uses') return;
      assert.ok(isScalar(pair.value) && typeof pair.value.value === 'string', `${file}: a uses that is not a string`);
      const end = pair.value.range?.[1] ?? 0;
      const lineEnd = source.indexOf('\n', end);
      references.push({
        where: `${file}:${source.slice(0, end).split('\n').length}`,
        value: pair.value.value,
        rest: source.slice(end, lineEnd < 0 ? undefined : lineEnd),
      });
    },
  });

  return references;
}

/** Every workflow, by file name, parsed once. */
function workflows(): { file: string; source: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, source: readFileSync(new URL(file, WORKFLOWS), 'utf8') }));
}

/**
 * What a workflow grants to every one of its jobs, as `name: level` pairs.
 *
 * A workflow with no `permissions` at all is the case this reports as `undefined`: it takes the
 * repository's default, which can be write.
 */
export function defaultPermissions(source: string): Record<string, string> | undefined {
  // `get` unwraps a scalar unless it is asked to keep the node, so `permissions: write-all` came
  // back as a plain string and `isScalar` answered false — the widest grant of all read as a map of
  // nothing, and this test passed over it. Raised in review.
  const granted = parseDocument(source).get('permissions', true);
  if (granted === undefined || granted === null) return undefined;
  if (isScalar(granted)) return { all: String(granted.value) };
  if (!isMap(granted)) return {};

  return Object.fromEntries(
    granted.items.flatMap((pair) =>
      isScalar(pair.key) && isScalar(pair.value) ? [[String(pair.key.value), String(pair.value.value)]] : [],
    ),
  );
}

/** Every `uses` in the workflows. A local action has no tag to move. */
function actionReferences(): Reference[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => referencesIn(file, readFileSync(new URL(file, WORKFLOWS), 'utf8')))
    .filter((reference) => !reference.value.startsWith('./'));
}

/** The keys of a mapping node, or nothing when the node is not one. */
function keysOf(node: unknown): string[] {
  return isMap(node) ? node.items.flatMap((entry) => (isScalar(entry.key) ? [String(entry.key.value)] : [])) : [];
}

/** Every job of a workflow, with the steps it runs. */
function jobsIn(source: string): { job: string; checksOut: boolean; env: Set<string>; runsGh: boolean }[] {
  const jobs = parseDocument(source).get('jobs', true);
  if (!isMap(jobs)) return [];

  return jobs.items.flatMap((pair) => {
    if (!isScalar(pair.key) || !isMap(pair.value)) return [];
    const steps = pair.value.get('steps', true);
    const env = new Set(keysOf(pair.value.get('env', true)));
    let checksOut = false;
    let runsGh = false;

    if (isSeq(steps)) {
      for (const step of steps.items) {
        if (!isMap(step)) continue;
        const uses = step.get('uses');
        const run = step.get('run');
        if (typeof uses === 'string' && uses.startsWith('actions/checkout@')) checksOut = true;
        if (typeof run === 'string' && /(^|\s)gh\s/.test(run)) runsGh = true;
        for (const name of keysOf(step.get('env', true))) env.add(name);
      }
    }

    return [{ job: String(pair.key.value), checksOut, env, runsGh }];
  });
}

describe('the GitHub workflows', () => {
  it('pin every action to a commit SHA, with its version as a comment', () => {
    const references = actionReferences();

    assert.ok(references.length >= 20, `only ${references.length} action references found`);
    assert.deepEqual(
      references
        .filter((reference) => !PINNED.test(reference.value) || !VERSION_COMMENT.test(reference.rest))
        .map((reference) => reference.where),
      [],
    );
  });

  /**
   * **No workflow hands a write to every job** (SKG-609, widened to all of them by SKG-616).
   *
   * A job that publishes declares the permission it needs, beside the steps that need it. Granted at
   * the top instead, the same token reaches the jobs that only build and scan — and a step added to
   * one of those later inherits it with nothing to say so.
   */
  /**
   * The widest grant of all is a scalar — `permissions: write-all` — and it is the one the reader
   * missed. Driven on YAML rather than on the files, because no workflow here may hold that case.
   */
  it('read a permissions block whatever shape it is written in', () => {
    assert.deepEqual(defaultPermissions('permissions: write-all\njobs: {}\n'), { all: 'write-all' });
    assert.deepEqual(defaultPermissions('permissions: read-all\njobs: {}\n'), { all: 'read-all' });
    assert.deepEqual(defaultPermissions('permissions:\n  contents: write\njobs: {}\n'), { contents: 'write' });
    assert.deepEqual(defaultPermissions('permissions:\n  contents: read\njobs: {}\n'), { contents: 'read' });
    assert.equal(defaultPermissions('jobs: {}\n'), undefined);
  });

  /**
   * **`gh` reads the repository from the working directory**, and a job that checks nothing out has
   * none. `release-extension.yml`'s publish job only downloads an artefact: its first upload failed
   * for that, and the tag it would have failed on does not exist yet. Raised in review.
   */
  it('tell gh which repository it is talking about, in a job that checks nothing out', () => {
    const blind = workflows().flatMap(({ file, source }) =>
      jobsIn(source)
        .filter((job) => job.runsGh && !job.checksOut && !job.env.has('GH_REPO'))
        .map((job) => `${file}: ${job.job}`),
    );

    assert.deepEqual(blind, [], 'these jobs run gh with no repository to infer from');
  });

  it('grant no write above the job that needs it', () => {
    const files = workflows();

    assert.ok(files.length >= 3, `only ${files.length} workflows found — the walk stopped matching`);
    const wide = files
      .map(({ file, source }) => ({ file, granted: defaultPermissions(source) }))
      .filter(({ granted }) => granted === undefined || Object.values(granted).some((level) => level.includes('write')))
      .map(
        ({ file, granted }) => `${file}: ${granted === undefined ? 'no permissions block' : JSON.stringify(granted)}`,
      );

    assert.deepEqual(wide, [], 'these workflows give every job more than a read');
  });
});
