import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

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

async function latestRelease(): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const answer = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers });
  if (!answer.ok) throw new Error(`GitHub gave no latest release: ${answer.status} ${await answer.text()}`);
  const { tag_name: tag } = (await answer.json()) as { tag_name: string };

  return tag.replace(/^v/, '');
}

async function download(url: string, to: string): Promise<void> {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`${url}: ${answer.status}`);
  fs.writeFileSync(to, Buffer.from(await answer.arrayBuffer()));
}

const npmVersion = process.env.FRUITBACK_PUBLISHED_VERSION || npmLatest();
const extensionVersion = process.env.FRUITBACK_PUBLISHED_EXTENSION || (await latestRelease());

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
await download(
  `https://github.com/${REPOSITORY}/releases/download/v${extensionVersion}/fruitback-${extensionVersion}-chrome.zip`,
  archive,
);
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

fs.writeFileSync(
  path.join(PUBLISHED, 'versions.json'),
  `${JSON.stringify({ npm: npmVersion, extension: extensionVersion }, null, 2)}\n`,
);
console.log(`published versions: npm ${npmVersion}, extension ${extensionVersion}`);
