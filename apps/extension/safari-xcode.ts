import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SAFARI_BUNDLE_ID, fixXcodeProject } from './src/safari-xcode.ts';

/**
 * The Xcode project that carries the Safari build (FRU-380): `pnpm safari:xcode`, after
 * `pnpm build:safari`. macOS with Xcode only. It signs nothing and uploads nothing: signing and App
 * Store Connect need the Apple Developer account, see `docs/decisions/extension.md`, « Safari ».
 *
 * The project is written to `.output/safari-xcode/`, which git ignores: it is made again from the
 * build each time, so it cannot drift from it.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(`${here}package.json`, 'utf8')) as { version: string };
const project = `${here}.output/safari-xcode`;

execFileSync(
  'xcrun',
  [
    'safari-web-extension-converter',
    `${here}.output/safari-mv3`,
    '--project-location',
    project,
    '--app-name',
    'Fruitback',
    '--bundle-identifier',
    SAFARI_BUNDLE_ID,
    '--macos-only',
    '--copy-resources',
    '--no-open',
    '--no-prompt',
    '--force',
  ],
  { stdio: 'inherit' },
);

const pbxproj = `${project}/Fruitback/Fruitback.xcodeproj/project.pbxproj`;
writeFileSync(pbxproj, fixXcodeProject(readFileSync(pbxproj, 'utf8'), SAFARI_BUNDLE_ID, version));
console.log(`${project}/Fruitback/Fruitback.xcodeproj`);
