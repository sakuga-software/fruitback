import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { PUBLISHED, isChangeset, withoutChangeset } from '../../../tools/ci/changeset.ts';

/**
 * The changesets of the published packages (FRU-28). A directory left out of `PUBLISHED` lets a
 * change to its package reach npm with no line in its changelog. So the list is held here to the
 * packages that are not private.
 *
 * It lives beside `workflows.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);

describe('the changeset of a pull request', () => {
  it('watches every package that goes to npm, and only those', () => {
    const packages = ['shared', 'widget', 'element', 'react', 'fruitback', 'element-x'].flatMap((directory) => {
      try {
        const manifest = JSON.parse(readFileSync(new URL(`packages/${directory}/package.json`, ROOT), 'utf8')) as {
          private?: boolean;
        };
        return manifest.private === true ? [] : [`packages/${directory}/`];
      } catch {
        return [];
      }
    });

    assert.deepEqual([...PUBLISHED].sort(), packages.sort());
  });

  it('asks for a changeset when a published file changes, and only then', () => {
    assert.deepEqual(withoutChangeset(['packages/widget/src/composer.ts']), ['packages/widget/src/composer.ts']);
    assert.deepEqual(withoutChangeset(['packages/shared/package.json', 'docs/a.md']), ['packages/shared/package.json']);
    assert.deepEqual(withoutChangeset(['packages/widget/src/composer.ts', '.changeset/brave-pins.md']), []);
    // A test, an app, a document: nothing a consumer of npm gets.
    assert.deepEqual(withoutChangeset(['packages/widget/src/composer.test.ts', 'apps/worker/src/app.ts']), []);
    // `packages/widget-x` is not `packages/widget`.
    assert.deepEqual(withoutChangeset(['packages/widget-x/a.ts']), []);
  });

  it('counts a Markdown file of .changeset as a changeset, and not its README or its config', () => {
    assert.equal(isChangeset('.changeset/brave-pins.md'), true);
    assert.equal(isChangeset('.changeset/README.md'), false);
    assert.equal(isChangeset('.changeset/config.json'), false);
    assert.equal(isChangeset('.changeset/nested/a.md'), false);
    assert.deepEqual(withoutChangeset(['packages/react/src/index.ts', '.changeset/README.md']), [
      'packages/react/src/index.ts',
    ]);
  });
});
