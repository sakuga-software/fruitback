import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { checkDigest, checkInstalled } from './checks.ts';

/**
 * Fetch what the people who use Fruitback have now (FRU-460): the last published npm packages and
 * the last released extension. `playwright.published.config.ts` then runs them against the worker
 * of this commit.
 *
 * Both sources are public, so no token is needed:
 * - npm: `fruitback`, `@fruitback/widget` and `@fruitback/element`, at the `latest` tag.
 * - the extension: the archive for Chrome that `release-extension.yml` attaches to the latest
 *   GitHub release. It is the archive that the same run gives to the stores.
 *
 * `FRUITBACK_PUBLISHED_VERSION` and `FRUITBACK_PUBLISHED_EXTENSION` pin a version (`0.4.0`), for
 * example to replay a run. `GITHUB_TOKEN`, if set, only raises the rate limit of the GitHub API.
 *
 * Usage: node e2e/published/fetch.ts
 */

const PUBLISHED = '.published';
const REPOSITORY = 'sakuga-software/fruitback';

function npmLatest(): string {
  return execFileSync('npm', ['view', 'fruitback@latest', 'version'], { encoding: 'utf8' }).trim();
}

type Release = {
  tag_name: string;
  assets: { name: string; browser_download_url: string; digest: string | null }[];
};

/** The latest release, or the one of `version`. */
async function release(version: string | undefined): Promise<Release> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const which = version ? `tags/v${version}` : 'latest';
  const answer = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/${which}`, { headers });
  if (!answer.ok) throw new Error(`GitHub gave no release ${which}: ${answer.status} ${await answer.text()}`);

  return (await answer.json()) as Release;
}

/**
 * The bytes of an asset, checked against the SHA-256 that GitHub computed when the asset was
 * uploaded (`digest` of the API). A download that was cut or changed on its way fails here, before
 * any of it runs. Raised in review.
 */
async function downloadChecked(asset: Release['assets'][number], to: string): Promise<void> {
  const answer = await fetch(asset.browser_download_url);
  if (!answer.ok) throw new Error(`${asset.browser_download_url}: ${answer.status}`);
  const bytes = Buffer.from(await answer.arrayBuffer());
  checkDigest(asset.name, bytes, asset.digest);
  fs.writeFileSync(to, bytes);
}

const npmVersion = process.env.FRUITBACK_PUBLISHED_VERSION || npmLatest();
const extensionRelease = await release(process.env.FRUITBACK_PUBLISHED_EXTENSION || undefined);
const extensionVersion = extensionRelease.tag_name.replace(/^v/, '');

fs.rmSync(PUBLISHED, { recursive: true, force: true });
fs.mkdirSync(PUBLISHED);
const npmDirectory = path.join(PUBLISHED, 'npm');
fs.mkdirSync(npmDirectory);
// A package of its own, so npm installs here and not into the workspace. No scripts: nothing of
// these packages runs on the runner, only in the browser of the specs.
fs.writeFileSync(path.join(npmDirectory, 'package.json'), '{"private":true}\n');
execFileSync(
  'npm',
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    `fruitback@${npmVersion}`,
    `@fruitback/widget@${npmVersion}`,
    `@fruitback/element@${npmVersion}`,
  ],
  { cwd: npmDirectory, stdio: 'inherit' },
);

// `import { init } from 'fruitback'`, as the README writes it, through a bundler as a site builds
// it. The specs read `init` from this global.
await build({
  stdin: {
    contents: "import { init } from 'fruitback'; globalThis.FruitbackFromNpm = { init };",
    resolveDir: npmDirectory,
  },
  bundle: true,
  format: 'iife',
  outfile: path.join(PUBLISHED, 'fruitback-import.js'),
  logLevel: 'warning',
});

const archive = path.join(PUBLISHED, 'extension-chrome.zip');
const chrome = extensionRelease.assets.find((asset) => asset.name === `fruitback-${extensionVersion}-chrome.zip`);
if (chrome === undefined) throw new Error(`the release v${extensionVersion} holds no archive for Chrome`);
await downloadChecked(chrome, archive);
// Python and not `unzip`: the image of Playwright that CI runs in has no `unzip`. `zipfile` also
// refuses a name that climbs out of the directory.
execFileSync('python3', ['-I', '-m', 'zipfile', '-e', archive, path.join(PUBLISHED, 'extension')], {
  stdio: 'inherit',
});
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLISHED, 'extension', 'manifest.json'), 'utf8')) as {
  version: string;
};
if (manifest.version !== extensionVersion) {
  throw new Error(`the archive of v${extensionVersion} holds the extension ${manifest.version}`);
}

// What npm installed, read from the disk, and not the version it was asked for: `fruitback` names
// its widget and its contract by an exact version, and a run that mixes two versions fails here.
// Raised in review.
const installed = Object.fromEntries(
  ['fruitback', '@fruitback/widget', '@fruitback/element', '@fruitback/shared'].map((name) => [
    name,
    (
      JSON.parse(fs.readFileSync(path.join(npmDirectory, 'node_modules', name, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version,
  ]),
);
checkInstalled(npmVersion, installed);

fs.writeFileSync(
  path.join(PUBLISHED, 'versions.json'),
  `${JSON.stringify({ npm: npmVersion, extension: extensionVersion, installed, archive: chrome.digest }, null, 2)}\n`,
);
console.log(`published versions: npm ${npmVersion}, extension ${extensionVersion}`);
