import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Every action a workflow uses is pinned to a commit SHA, with its version as a comment (SKG-608).
 *
 * A tag can move to other code, and `release-image.yml` runs with `packages: write`. Dependabot moves
 * a pin that exists, but it does not pin a new step, so this test is what holds the rule.
 *
 * It lives beside `compose.test.ts`, which also reads files outside this package, because the root has
 * no `test` target.
 */

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url);

/** `owner/repo@<40 hex>`, or the same for an action in a subdirectory of its repository. */
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/** The version comment that must end a line with a pinned action. */
const VERSION_COMMENT = /# v\d+(\.\d+){0,2}\s*$/;

/**
 * Every `uses:` value in the workflows, with its line. A key at the start of a step and a key inside a
 * flow mapping such as `- { uses: owner/repo@v1 }` both count. A local action has no tag to move.
 */
function actionReferences(): { where: string; value: string; line: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      readFileSync(new URL(file, WORKFLOWS), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /^\s*#/.test(line)
            ? []
            : [...line.matchAll(/(?:^|[\s{,])uses:\s*['"]?([^\s'",}]+)/g)]
                .map((match) => match[1] ?? '')
                .filter((value) => !value.startsWith('./'))
                .map((value) => ({ where: `${file}:${index + 1}`, value, line })),
        ),
    );
}

describe('the GitHub workflows', () => {
  it('pin every action to a commit SHA, with its version as a comment', () => {
    const references = actionReferences();

    assert.ok(references.length >= 20, `only ${references.length} action references found`);
    assert.deepEqual(
      references
        .filter((reference) => !PINNED.test(reference.value) || !VERSION_COMMENT.test(reference.line))
        .map((reference) => reference.where),
      [],
    );
  });
});
