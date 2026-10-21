import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Runs again, under the locale of this process, the test files that `locale-probe.ts` saw read the
 * locale in the first run (FRU-344).
 *
 *   node tools/ci/locale-rerun.ts <directory of the probe>
 *
 * Each package runs its own files with its own runner: `vitest run <files>` when its `test` script
 * is vitest, else `node --test <files>`. It fails when a run fails, and when the probe wrote nothing
 * at all: the widget and the console read the locale in their tests, so an empty probe is a probe
 * that did not load, and a French run of nothing would pass.
 */

/** What the probe wrote: each test file, and the APIs it read the locale through. */
export function readProbe(directory: string): Map<string, Set<string>> {
  const files = new Map<string, Set<string>>();
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.tsv'))) {
    for (const line of readFileSync(join(directory, name), 'utf8').split('\n')) {
      const [file, api] = line.split('\t');
      if (file === undefined || file === '' || api === undefined) continue;
      const apis = files.get(file) ?? new Set<string>();
      apis.add(api);
      files.set(file, apis);
    }
  }

  return files;
}

/** The directory of the nearest `package.json` above a file. */
export function packageOf(file: string): string | undefined {
  let directory = dirname(file);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    directory = dirname(directory);
  }

  return undefined;
}

/** The command that runs some test files of a package, from its `test` script. */
export function commandOf(testScript: string, files: string[]): [string, string[]] {
  return /^vitest\b/.test(testScript.trim())
    ? ['pnpm', ['exec', 'vitest', 'run', ...files]]
    : ['node', ['--test', ...files]];
}

function main([directory = '']: string[]): void {
  const probed = readProbe(directory);
  const say = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  if (probed.size === 0) {
    console.log(`::error title=locale::the probe wrote no test file in ${directory}: did it load?`);
    process.exit(1);
  }

  const byPackage = new Map<string, string[]>();
  for (const file of [...probed.keys()].sort()) {
    const pkg = packageOf(file);
    if (pkg === undefined) throw new Error(`${file} is in no package`);
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), relative(pkg, file)]);
  }

  say(`### Tests run again under ${navigator.language}`);
  say('');
  say('| Package | Test files | What they read |');
  say('|---|---|---|');
  for (const [pkg, files] of byPackage) {
    const apis = new Set(files.flatMap((file) => [...(probed.get(join(pkg, file)) ?? [])]));
    say(`| \`${relative(process.cwd(), pkg)}\` | ${files.length} | ${[...apis].sort().join(', ')} |`);
  }
  say('');

  let failed = false;
  for (const [pkg, files] of byPackage) {
    const { scripts = {} } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const [command, args] = commandOf(scripts.test ?? '', files);
    console.log(`::group::${relative(process.cwd(), pkg)}: ${command} ${args.join(' ')}`);
    // The probe stays out of this run: it reads, it does not choose.
    const env = { ...process.env, FRUITBACK_LOCALE_PROBE: '' };
    const run = spawnSync(command, args, { cwd: pkg, stdio: 'inherit', env });
    console.log('::endgroup::');
    if (run.status !== 0) {
      console.log(`::error title=locale::${relative(process.cwd(), pkg)} failed under ${navigator.language}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
