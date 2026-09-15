import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `CONTRIBUTING.md` against the files it describes (SKG-520).
 *
 * The page tells a person which commands to run, which ports to open, which checks must pass and how
 * to write a pull request title. Each of these has one source in the repository, and a source can change
 * with no failure in the prose. So this test reads each source and the page.
 *
 * It lives beside `compose.test.ts`, which also guards files at the root, because the root has no `test`
 * target. It compares names and numbers only: a pattern over sentences guards only the sentences it
 * happens to match.
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const CONTRIBUTING = read('../../../CONTRIBUTING.md');
const PULL_REQUEST_TEMPLATE = read('../../../.github/pull_request_template.md');
const ROOT_PACKAGE = JSON.parse(read('../../../package.json')) as {
  scripts: Record<string, string>;
  packageManager: string;
};

/** pnpm's own commands. They are not scripts of this repository. */
const PNPM_COMMANDS = new Set(['install', 'exec', 'add', 'dlx', 'store']);

/** Every `pnpm <name>` in a text, except pnpm's own commands. `pnpm --filter` starts with a dash. */
function pnpmScripts(text: string): string[] {
  const names = [...text.matchAll(/\bpnpm ([a-z][a-z0-9:-]*)/g)].map((match) => match[1] ?? '');

  return [...new Set(names)].filter((name) => !PNPM_COMMANDS.has(name)).sort();
}

/** The scripts of each workspace package, by package name. */
function workspaceScripts(): Map<string, string[]> {
  const scripts = new Map<string, string[]>();
  for (const group of ['apps', 'packages']) {
    for (const dir of readdirSync(new URL(`../../../${group}/`, import.meta.url))) {
      const file = `../../../${group}/${dir}/package.json`;
      if (!existsSync(new URL(file, import.meta.url))) continue;
      const manifest = JSON.parse(read(file)) as { name: string; scripts?: Record<string, string> };
      scripts.set(manifest.name, Object.keys(manifest.scripts ?? {}));
    }
  }

  return scripts;
}

/** The name of each check `ci.yml` reports on a pull request. A job with no `name` reports its id. */
function ciChecks(): string[] {
  const ci = read('../../../.github/workflows/ci.yml');
  assert.match(ci, /^ {2}pull_request:/m, 'ci.yml no longer runs on pull requests');
  assert.ok(ci.includes('\njobs:\n'), 'ci.yml has no jobs');

  const jobs: { id: string; name?: string }[] = [];
  for (const line of ci.slice(ci.indexOf('\njobs:\n')).split('\n')) {
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id !== undefined) jobs.push({ id });
    const name = /^ {4}name: (.+)$/.exec(line)?.[1];
    const job = jobs.at(-1);
    if (name !== undefined && job !== undefined) job.name = name.trim().replace(/^['"]|['"]$/g, '');
  }
  const targets = (/target: \[([^\]]+)\]/.exec(ci)?.[1] ?? '')
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target !== '');

  return jobs.flatMap((job) => (job.name?.includes('${{') ? targets : [job.name ?? job.id])).sort();
}

/** The body of one `## ` section, up to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const end = text.indexOf('\n## ', start + 1);

  return text.slice(start, end < 0 ? undefined : end);
}

describe('CONTRIBUTING.md', () => {
  it('runs only scripts the root package.json defines, and so does the pull request template', () => {
    const scripts = Object.keys(ROOT_PACKAGE.scripts);
    const cited = pnpmScripts(CONTRIBUTING);

    for (const name of ['dev', 'test', 'e2e', 'lint', 'format', 'format:fix', 'typecheck']) {
      assert.ok(cited.includes(name), `the page no longer names pnpm ${name}, so the detector reads nothing`);
    }
    assert.deepEqual(
      cited.filter((name) => !scripts.includes(name)),
      [],
    );
    const inTemplate = pnpmScripts(PULL_REQUEST_TEMPLATE);
    for (const check of ciChecks()) {
      assert.ok(
        PULL_REQUEST_TEMPLATE.includes(`\`pnpm ${check}\``) || PULL_REQUEST_TEMPLATE.includes(`\`${check}\``),
        `the pull request template does not name the ${check} check`,
      );
    }
    assert.deepEqual(
      inTemplate.filter((name) => !scripts.includes(name)),
      [],
    );
  });

  it('runs only package scripts and test files that exist', () => {
    const packages = workspaceScripts();
    const filtered = [...CONTRIBUTING.matchAll(/\bpnpm --filter (\S+) ([a-z][a-z0-9:-]*)/g)];
    const files = [...CONTRIBUTING.matchAll(/\bcd (\S+) && node --test (\S+)/g)];

    assert.ok(filtered.length >= 2 && files.length >= 1, 'the detector found no command to check');
    for (const [command, name = '', script = ''] of filtered) {
      assert.ok(packages.get(name)?.includes(script), `${command}: no such package script`);
    }
    for (const [command, dir = '', file = ''] of files) {
      assert.ok(existsSync(new URL(`../../../${dir}/${file}`, import.meta.url)), `${command}: no such file`);
    }
  });

  it('gives the licence each workspace package declares', () => {
    const licences = section(CONTRIBUTING, 'Licences');
    let checked = 0;
    for (const group of ['apps', 'packages']) {
      for (const dir of readdirSync(new URL(`../../../${group}/`, import.meta.url))) {
        const file = `../../../${group}/${dir}/package.json`;
        if (!existsSync(new URL(file, import.meta.url))) continue;
        const { license } = JSON.parse(read(file)) as { license?: string };
        if (license === undefined) continue;
        const row = licences.split('\n').find((line) => line.startsWith(`| \`${group}/${dir}\` |`));
        assert.ok(row?.includes(license), `the Licences section does not give ${group}/${dir} as ${license}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 5, `only ${checked} declared licences found`);
  });

  it('gives the ports that pnpm dev opens', () => {
    const playground = /\bport: (\d+)/.exec(read('../../playground/vite.config.ts'))?.[1];
    const worker = /\bPORT=(\d+)/.exec(
      (JSON.parse(read('../package.json')) as { scripts: Record<string, string> }).scripts['dev:fake'] ?? '',
    )?.[1];

    assert.ok(playground !== undefined && worker !== undefined, 'a port source was not found');
    assert.match(section(CONTRIBUTING, 'Set up'), new RegExp(`\`http://localhost:${playground}\``));
    assert.match(section(CONTRIBUTING, 'Set up'), new RegExp(`\`http://localhost:${worker}\``));
  });

  it('lists exactly the checks CI runs on a pull request', () => {
    const checks = ciChecks();

    const listed = [
      ...section(CONTRIBUTING, 'Before you open a pull request').matchAll(/^\| `([a-z][a-z0-9 -]*)` \|/gm),
    ]
      .map((match) => match[1] ?? '')
      .sort();

    assert.ok(checks.length >= 5, `only ${checks.length} checks found in ci.yml`);
    assert.deepEqual(listed, checks);
  });

  it('gives the Node and pnpm versions the repository pins', () => {
    const node = read('../../../.nvmrc').trim();
    const pnpm = /^pnpm@(.+)$/.exec(ROOT_PACKAGE.packageManager)?.[1];

    assert.ok(pnpm !== undefined, 'packageManager does not pin pnpm');
    assert.match(section(CONTRIBUTING, 'Set up'), new RegExp(`\\*\\*Node ${node}\\*\\*`));
    assert.match(section(CONTRIBUTING, 'Set up'), new RegExp(`\\*\\*pnpm ${pnpm.replaceAll('.', '\\.')}\\*\\*`));
    assert.ok(CONTRIBUTING.includes(`pnpm@${pnpm}`), 'the install command names another pnpm');
  });

  it('gives the commit types CLAUDE.md gives', () => {
    const types = (text: string, lead: string): string[] => {
      const line = new RegExp(`${lead}([^.]+)\\.`).exec(text.replace(/\n\s*/g, ' '))?.[1] ?? '';

      return [...line.matchAll(/`([a-z]+)`/g)].map((match) => match[1] ?? '').sort();
    };
    const claude = types(read('../../../CLAUDE.md'), 'Types in use: ');

    assert.ok(claude.length >= 5, 'the types were not found in CLAUDE.md');
    assert.deepEqual(types(CONTRIBUTING, 'The types are '), claude);

    const format = /`type\(scope\): [^`]+`/.exec(read('../../../CLAUDE.md'))?.[0];
    assert.ok(format !== undefined, 'the title format was not found in CLAUDE.md');
    assert.ok(CONTRIBUTING.includes(format), `the page does not give the title format ${format}`);
  });
});
