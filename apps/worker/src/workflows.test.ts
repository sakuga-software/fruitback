import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isMap, isScalar, parseDocument, visit } from 'yaml';

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
function defaultPermissions(source: string): Record<string, string> | undefined {
  const granted = parseDocument(source).get('permissions');
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
