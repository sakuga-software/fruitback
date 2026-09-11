import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * What the two published files actually contain (SKG-505).
 *
 * Every other test in this package runs against the sources. These run against the **build**, which
 * is the only thing a client site ever sees: a widget whose `dist` is broken has a green suite and
 * ships nothing. It builds once and asks the questions a consumer would.
 */

const run = promisify(execFile);
// `fileURLToPath`, not `.pathname`: a repo checked out under a path with a space arrives
// percent-escaped, and a Windows drive letter arrives with a leading slash. Both make `cwd` wrong.
const root = fileURLToPath(new URL('..', import.meta.url));

let dist: string;

before(async () => {
  await run(process.execPath, ['build.ts'], { cwd: root });
  await run(process.execPath, ['build.ts'], { cwd: join(root, '..', 'shared') });
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

  /**
   * The README's snippet, read from the README (SKG-519).
   *
   * `CLAUDE.md` said the snippet was executed by the suite, and it was not: the test above asserts
   * the *build* names one attribute, and nothing had ever opened the file a reader copies from. So a
   * renamed attribute would have left the landing page quietly wrong — the reader pastes the tag,
   * the widget mounts with no endpoint, and nothing in this repository fails.
   *
   * Every attribute the page documents has to be one the build reads. Not the reverse: the snippet
   * is deliberately the short form, and `label` and the rest live in `docs/install.md`.
   */
  it('reads every attribute the README tells a reader to write', async () => {
    const source = await readFile(join(dist, 'fruitback.iife.js'), 'utf8');
    const readme = await readFile(join(root, '..', '..', 'README.md'), 'utf8');
    // `[a-z-]*[a-z]` and not `[a-z]+`: the first version stopped at the first hyphen, so a name like
    // `data-fruitback-endpoint-extra` matched **nothing at all** and was skipped in silence — the
    // guard then checked the one attribute left and passed while the snippet no longer mounted
    // anything. Raised in review, and measured: that spelling captured `[]`.
    const captures = [...readme.matchAll(/data-(fruitback[a-z-]*[a-z])=/g)].map((match) => match[1] ?? '');
    const documented = new Set(captures.filter((name) => name !== ''));

    // A guard over an empty set passes. The snippet is the first thing on the landing page; if it is
    // gone, that is the failure, not a reason to skip.
    assert.ok(documented.size > 0, 'the README documents no data-fruitback-* attribute any more');

    for (const attribute of documented) {
      const camel = attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      assert.ok(
        source.includes(`data-${attribute}`) || source.includes(camel),
        `the README documents data-${attribute} and the built script never reads it`,
      );
    }
  });

  /**
   * The other direction, which the first version left open (SKG-519).
   *
   * "Everything documented is read" says nothing about a snippet that stopped documenting what the
   * tag cannot mount without. `global.ts` returns early unless **both** `fruitbackEndpoint` and
   * `fruitbackClient` are on the tag, so a README that lost either one would hand a reader a script
   * tag that loads, does nothing, and reports nothing. Raised in review.
   *
   * The required names are taken from `global.ts`'s own early return rather than listed here, so
   * renaming one fails this test instead of quietly narrowing it.
   */
  it('documents the attributes the script tag cannot mount without', async () => {
    const bootstrap = await readFile(join(root, 'src', 'global.ts'), 'utf8');
    const guarded = /if \(endpoint !== undefined && clientId !== undefined\)/.test(bootstrap);
    assert.ok(guarded, 'global.ts no longer gates the mount on those two locals; this guard is stale');

    const required = [...bootstrap.matchAll(/script\.dataset\.(fruitback[A-Za-z]+)/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => name !== '' && !bootstrap.includes(`label: script.dataset.${name}`));
    assert.equal(required.length, 2, `expected two required attributes, found ${required.join(', ')}`);

    const readme = await readFile(join(root, '..', '..', 'README.md'), 'utf8');
    for (const camel of required) {
      const kebab = camel.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      assert.ok(
        readme.includes(`data-${kebab}=`),
        `the script tag will not mount without data-${kebab}, and the README no longer documents it`,
      );
    }
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
          specifier.startsWith('@fruitback/'),
          `${name} imports ${specifier}, which is not published alongside this package`,
        );
      }
    }
  });
});

describe('a consumer installing this from npm', () => {
  /**
   * The test that was missing, and the reason a broken package shipped green.
   *
   * The assertions above check *our* declarations for stray `.ts` imports and for specifiers a
   * consumer could install. Neither notices that `@fruitback/shared` itself pointed at raw
   * sources: `main` and `types` went straight to `src/index.ts`, whose own imports carry the `.ts`
   * extension this repo allows and nobody else does. A downstream `tsc` failed with TS5097 while
   * every check here stayed green.
   *
   * So this one does what a consumer does: pack both packages, install them into a scratch project,
   * and type-check an import with ordinary settings. Slow, and the only honest guard.
   *
   * **Both `dist` directories are deleted first**, on purpose. Packing a tree this file had already
   * built is not the path a release takes: a bare `pnpm publish` on a fresh checkout has no `dist`
   * at all, and only each package's `prepack` hook puts one there. Building before packing is what
   * hid a tarball that shipped nothing but sources.
   */
  it('type-checks an import with no special tsconfig', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'fruitback-consumer-'));
    const workspace = join(root, '..', '..');

    try {
      for (const name of ['widget', 'shared', 'fruitback']) {
        await rm(join(root, '..', name, 'dist'), { recursive: true, force: true });
      }

      for (const pkg of ['@fruitback/shared', '@fruitback/widget', 'fruitback']) {
        await run('pnpm', ['--filter', pkg, 'pack', '--pack-destination', scratch], { cwd: workspace, shell: true });
      }

      await writeFile(
        join(scratch, 'package.json'),
        JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
      );
      await writeFile(
        join(scratch, 'index.ts'),
        [
          // The front door first, because it is the one a reader of the docs installs. Nothing else
          // here would notice a broken `exports` in `packages/fruitback`, and an `export *` collision
          // between the two packages it forwards is dropped silently by the module spec rather than
          // reported.
          'import { init, type Seed } from "fruitback";',
          // And the scoped packages directly, because they stay published and someone will.
          'import { init as initScoped } from "@fruitback/widget";',
          'import type { SeedIssue } from "@fruitback/shared";',
          // The theme type, because `FruitbackOptions.theme` names it (SKG-528). It resolves through
          // `theme.d.ts`, which ships but is not reachable through the package's `exports` — so
          // "the option is documented" and "the consumer can describe what they pass" are two
          // different claims, and this is the one that checks the second.
          'import type { FruitbackTheme, ThemeToken } from "fruitback";',
          'const palette: FruitbackTheme = { "color-accent": "#0055ff" };',
          'export const accent: ThemeToken = "color-accent";',
          'export const mount = () => init({ endpoint: "https://w.test", clientId: "acme", theme: palette });',
          'export const mountScoped = () => initScoped({ endpoint: "https://w.test", clientId: "acme" });',
          'export type Payload = Seed;',
          'export type Pin = SeedIssue;',
          '',
        ].join('\n'),
      );
      // The defaults a project gets from `tsc --init`, with one exception.
      await writeFile(
        join(scratch, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'preserve',
            moduleResolution: 'bundler',
            target: 'es2022',
            noEmit: true,
            strict: true,
            // Deliberately **off**, unlike the default. The declarations are the reason the contract
            // package is published at all, and skipping them would leave this guard checking nothing
            // about its own premise.
            skipLibCheck: false,
          },
          include: ['index.ts'],
        }),
      );

      // Asserted before installing, because "the tarball contains a build" is the exact thing that
      // was wrong twice: once with `main` pointing at sources, once with no `dist` packed at all.
      // A type-check alone reports it as a missing module, three layers from the cause.
      const tarballs = (await import('node:fs')).readdirSync(scratch).filter((name) => name.endsWith('.tgz'));

      for (const tarball of tarballs) {
        const { stdout } = await run('tar', ['-tzf', join(scratch, tarball)]);
        assert.ok(
          stdout.includes('package/dist/'),
          `${tarball} ships no dist — its prepack did not run, and publishConfig points at one`,
        );
        // A package nobody may legally use is worse than an unpublished one (SKG-515), and all three
        // shipped as `UNLICENSED` until this ticket. So the field is what gets asserted, read back
        // out of the tarball rather than off disk.
        //
        // Two things this deliberately does *not* rely on, both measured rather than assumed:
        // npm force-includes a `LICENSE` whatever `files` says, and pnpm copies the workspace root's
        // LICENSE into any package that has none of its own. Between them, "the tarball contains a
        // file called LICENSE" is true even for a package that never declared one — which is why the
        // text is checked too, and why that check would catch AGPL leaking into a published package.
        const [{ stdout: manifest }, { stdout: licence }] = await Promise.all([
          run('tar', ['-xzOf', join(scratch, tarball), 'package/package.json']),
          run('tar', ['-xzOf', join(scratch, tarball), 'package/LICENSE']),
        ]);

        assert.equal((JSON.parse(manifest) as { license?: string }).license, 'MIT', `${tarball} declares no MIT`);
        assert.match(licence, /^MIT License/, `${tarball} ships a LICENSE that is not the MIT text`);
      }

      // MIT asks for the notice to travel with the code, and the widget compiles `react-grab` and
      // `zod` **into** its bundle. `react-grab` carries `@license` banners esbuild keeps; `zod`
      // carries none, so its notice reaches a consumer through this file or not at all.
      //
      // Unlike `LICENSE` above, this one really does depend on `files`: npm force-includes nothing
      // by that name. Dropping the entry was measured failing exactly here.
      const widgetTarball = tarballs.find((name) => name.startsWith('fruitback-widget-'));
      assert.ok(widgetTarball, `no widget tarball among ${tarballs.join(', ')}`);
      const { stdout: widgetFiles } = await run('tar', ['-tzf', join(scratch, widgetTarball)]);
      assert.ok(
        widgetFiles.includes('package/THIRD-PARTY-NOTICES.md'),
        'the widget bundles other people’s MIT code and ships none of their notices',
      );
      // `./` matters: npm reads a bare name as a registry package, not a local file.
      await run('npm', ['install', '--no-audit', '--no-fund', ...tarballs.map((name) => `./${name}`)], {
        cwd: scratch,
        shell: true,
      });

      await run(process.execPath, [join(workspace, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
        cwd: scratch,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

async function gzipSize(path: string): Promise<number> {
  const { gzipSync } = await import('node:zlib');

  return gzipSync(await readFile(path)).byteLength;
}
