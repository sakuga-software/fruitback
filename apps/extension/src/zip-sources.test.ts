import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * What the sources archive has to carry (SKG-616).
 *
 * AMO rebuilds the extension from that archive and compares it with the one submitted, so the
 * archive has to build. This extension imports workspace packages: an archive of `apps/extension`
 * alone holds no `@fruitback/widget`, no lockfile and no workspace file, and `pnpm install` fails on
 * its first line. wxt's default root is the package, which is exactly that archive — raised in
 * review, and the first version shipped it.
 */

const EXTENSION = new URL('../', import.meta.url);

function config(): string {
  return readFileSync(new URL('wxt.config.ts', EXTENSION), 'utf8');
}

/** The workspace packages this extension depends on, by their path in the repository. */
function workspaceDependencies(): string[] {
  const manifest = JSON.parse(readFileSync(new URL('package.json', EXTENSION), 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  return Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => version.startsWith('workspace:'))
    .map(([name]) => `packages/${name.replace('@fruitback/', '')}`);
}

describe('the sources archive', () => {
  it('is rooted at the repository, not at the extension', () => {
    assert.match(config(), /sourcesRoot: '\.\.\/\.\.'/);
  });

  it('carries every workspace package the extension depends on', () => {
    const declared = config();
    const dependencies = workspaceDependencies();

    assert.ok(dependencies.length >= 2, `only ${dependencies.length} workspace dependencies found`);
    assert.deepEqual(
      dependencies.filter((path) => !declared.includes(`'${path}/**'`)),
      [],
      'these packages are imported and are not in the archive that has to build',
    );
  });

  /** Without these, `pnpm install` has no workspace to resolve them in and no versions to install. */
  it('carries what pnpm needs to install them', () => {
    const declared = config();

    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.ok(declared.includes(`'${file}'`), `${file} is not in the sources archive`);
    }
  });
});
