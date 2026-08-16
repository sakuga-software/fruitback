import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * What the two published files actually contain (SKG-505).
 *
 * Every other test in this package runs against the sources. These run against the **build**, which
 * is the only thing a client site ever sees: a widget whose `dist` is broken has a green suite and
 * ships nothing. It builds once and asks the questions a consumer would.
 */

const run = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;

let dist: string;

before(async () => {
  await run(process.execPath, ['build.ts'], { cwd: root });
  dist = join(root, 'dist');
});

describe('the ESM build', () => {
  it('exports `init` and nothing that needs a bundler to resolve', async () => {
    const bundle = join(dist, 'fruitback.mjs');
    const module = (await import(bundle)) as Record<string, unknown>;

    assert.equal(typeof module.init, 'function');
    // Bundled, not merely compiled: an unresolved bare import here is a package that explodes on the
    // consumer's first build rather than on ours.
    const source = await readFile(bundle, 'utf8');
    assert.doesNotMatch(source, /from ["']react-grab/);
    assert.doesNotMatch(source, /from ["']zod/);
  });

  it('promises only what `public.ts` declares', async () => {
    // The published surface is a contract. If `createOverlay` appears here, someone widened it by
    // accident and we are stuck with it until a major version.
    const module = (await import(join(dist, 'fruitback.mjs'))) as Record<string, unknown>;

    assert.deepEqual(Object.keys(module).sort(), ['init']);
  });
});

describe('the script-tag build', () => {
  it('defines the global the snippet documents', async () => {
    const source = await readFile(join(dist, 'fruitback.iife.js'), 'utf8');

    // Not executed here — it wants a DOM, and `host.spec.ts` drives the real thing in a browser.
    // What this asserts is the shape a `<script>` tag depends on.
    assert.match(source, /var Fruitback\s*=/);
    assert.match(source, /data-fruitback-endpoint|fruitbackEndpoint/);
  });

  it('is small enough to put on someone else’s page', async () => {
    const { size } = await import('node:fs').then((fs) => fs.promises.stat(join(dist, 'fruitback.iife.js')));
    const gzipped = await gzipSize(join(dist, 'fruitback.iife.js'));

    // Not a style rule: a feedback widget that costs its host half a megabyte is one they remove.
    // The number is generous on purpose — it is a tripwire for a dependency that should have been
    // bundled out, not a budget to optimise against.
    assert.ok(gzipped < 150_000, `${Math.round(gzipped / 1024)}kB gzipped, from ${Math.round(size / 1024)}kB raw`);
  });
});

describe('the published declarations', () => {
  it('resolve to files that exist', async () => {
    // `tsc` carries the source's `.ts` extensions into the `.d.ts`, where `dist` has no `.ts` to
    // find. The build rewrites them; this is what notices when it stops.
    const types = await readFile(join(dist, 'public.d.ts'), 'utf8');

    assert.doesNotMatch(types, /from '\.[^']*\.ts'/);
    assert.match(types, /export \{ init/);
  });

  it('names only packages a consumer can install', async () => {
    const files = await import('node:fs').then((fs) => fs.promises.readdir(dist));
    const declarations = files.filter((name) => name.endsWith('.d.ts'));

    for (const name of declarations) {
      const body = await readFile(join(dist, name), 'utf8');
      const bare = [...body.matchAll(/from '(@?[a-z][^'.][^']*)'/g)]
        .map(([, specifier]) => specifier)
        .filter((specifier) => specifier !== undefined);

      for (const specifier of bare) {
        assert.ok(
          specifier.startsWith('@sakuga/'),
          `${name} imports ${specifier}, which is not published alongside this package`,
        );
      }
    }
  });
});

async function gzipSize(path: string): Promise<number> {
  const { gzipSync } = await import('node:zlib');

  return gzipSync(await readFile(path)).byteLength;
}

after(async () => {
  await rm(await mkdtemp(join(tmpdir(), 'fruitback-')), { recursive: true, force: true });
});
