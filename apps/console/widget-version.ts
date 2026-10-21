// The versioned address of the widget's script (FRU-106).
//
// The console serves the script at `/v/<version>/fruitback.iife.js` with a cache of one year that a
// browser never revalidates (`immutable`). That is only true if the file at one address never changes.
// The version of the package does not change at each merge, so the version holds a hash of the file:
// `<version of the package>-<12 hex characters of its sha256>`. Another file gets another address.
//
//   node widget-version.ts version <script> <package.json of the widget>
//       Writes the version. The Dockerfile gives it to the build of the console as
//       VITE_FRUITBACK_WIDGET_VERSION, and the snippet of the console gives the address.
//   node widget-version.ts place <script> <package.json of the widget> <build directory of the console>
//       Copies the script to `client/v/<version>/fruitback.iife.js`, writes the version in
//       `console.conf.template`, and stops if the bundle of the console does not give that address.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The letters a version may have. It goes into a location of nginx and into an address. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

/** The version of the script `source`, from the version `release` of its package. */
export function widgetVersion(source: string | Uint8Array, release: unknown): string {
  if (typeof release !== 'string' || !VERSION.test(release)) {
    throw new Error(`The version of the widget's package is not one the address can hold: ${JSON.stringify(release)}.`);
  }
  return `${release}-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

/** The version of the script at `script`, whose package is described by `manifest`. */
export function versionOf(script: string, manifest: string): string {
  return widgetVersion(
    readFileSync(script),
    (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version,
  );
}

/** Puts the script at its versioned address in the build `build`, and writes the version in the server. */
export function place(script: string, manifest: string, build: string): string {
  const version = versionOf(script, manifest);
  const path = `/v/${version}/fruitback.iife.js`;

  // The bundle holds the version the server serves, or the snippet leads to the address of another
  // file. The bundle writes the address at run time, so the version is what it holds.
  const assets = join(build, 'client', 'assets');
  const given = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .some((name) => {
      const code = readFileSync(join(assets, name), 'utf8');
      // As a string of the bundle: the minifier may write it between any of the three quotes.
      return ['"', "'", '`'].some((quote) => code.includes(`${quote}${version}${quote}`));
    });
  if (!given) {
    throw new Error(
      `No file of the console's bundle holds the version ${version} of ${path}. Build it with VITE_FRUITBACK_WIDGET_VERSION=${version}.`,
    );
  }

  const server = join(build, 'console.conf.template');
  const template = readFileSync(server, 'utf8');
  if (!template.includes('__WIDGET_VERSION__')) throw new Error(`${server} has no __WIDGET_VERSION__ to replace.`);
  writeFileSync(server, template.replaceAll('__WIDGET_VERSION__', version));

  mkdirSync(join(build, 'client', 'v', version), { recursive: true });
  copyFileSync(script, join(build, 'client', 'v', version, 'fruitback.iife.js'));
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, script, manifest, build] = process.argv.slice(2);
  if (command === 'version' && script && manifest) {
    process.stdout.write(versionOf(script, manifest));
  } else if (command === 'place' && script && manifest && build) {
    console.log(`widget: served at /v/${place(script, manifest, build)}/fruitback.iife.js`);
  } else {
    console.error('Usage: node widget-version.ts version <script> <package.json>');
    console.error('       node widget-version.ts place <script> <package.json> <build directory>');
    process.exit(2);
  }
}
