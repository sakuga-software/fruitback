import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { commandOf, packageOf, readProbe } from '../../../tools/ci/locale-rerun.ts';

/**
 * CI runs again under a French locale only the test files that read the locale (FRU-344). A test
 * that reads it and is not run again is the defect of FRU-172 back, with a green check. So each kind
 * of read is planted here, in a process of its own, and the probe must write it; and each kind of
 * code that is no read must leave it silent.
 *
 * It lives beside `workflows.test.ts` because the root has no `test` target.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROBE = join(ROOT, 'tools/ci/locale-probe.ts');

/** The APIs that the probe writes for a test file whose body is `body`, run by `node --test`. */
function probe(body: string, env: Record<string, string> = {}): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-locale-'));
  try {
    const file = join(directory, 'planted.test.ts');
    writeFileSync(file, `import { it } from 'node:test';\nit('reads or not', () => {\n${body}\n});\n`);
    execFileSync(process.execPath, [`--import=${PROBE}`, '--test', file], {
      env: { ...process.env, ...env, FRUITBACK_LOCALE_PROBE: join(directory, 'out'), NODE_OPTIONS: '' },
      stdio: 'pipe',
    });
    const read = readProbe(join(directory, 'out'));
    assert.deepEqual(
      [...read.keys()].filter((name) => name !== file),
      [],
      'the probe named another file',
    );

    return [...(read.get(file) ?? [])].sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the probe of the locale', () => {
  it('writes each API of the language used with no locale given', () => {
    assert.deepEqual(probe('(1234.5).toLocaleString();'), ['Number#toLocaleString']);
    assert.deepEqual(probe('new Date(0).toLocaleDateString();'), ['Date#toLocaleDateString']);
    assert.deepEqual(probe("'a'.localeCompare('b');"), ['String#localeCompare']);
    assert.deepEqual(probe("'i'.toLocaleUpperCase();"), ['String#toLocaleUpperCase']);
    assert.deepEqual(probe('new Intl.DateTimeFormat().format(0);'), ['Intl.DateTimeFormat#format']);
    assert.deepEqual(probe('Intl.NumberFormat(undefined, { style: "percent" }).format(1);'), [
      'Intl.NumberFormat#format',
    ]);
    assert.deepEqual(probe("[...new Intl.Segmenter([], { granularity: 'word' }).segment('a b')];"), [
      'Intl.Segmenter#segment',
    ]);
    assert.deepEqual(probe('new Intl.Collator().compare("a", "b");'), ['Intl.Collator#compare']);
    assert.deepEqual(probe('navigator.language;'), ['navigator.language']);
  });

  it('leaves silent a locale given, a formatter never used, and code that reads none', () => {
    assert.deepEqual(probe("(1234.5).toLocaleString('en-US');"), []);
    assert.deepEqual(probe("'a'.localeCompare('b', 'fr');"), []);
    assert.deepEqual(probe("new Intl.DateTimeFormat('en-GB').format(0);"), []);
    // Made when a module loads, and never used: no dependence.
    assert.deepEqual(probe('new Intl.DateTimeFormat();'), []);
    assert.deepEqual(probe("'a' < 'b'; [3, 1].sort(); 'é'.toUpperCase(); new Date(0).toISOString();"), []);
  });

  it('writes nothing when no directory is given, and the run passes as before', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-locale-off-'));
    try {
      const file = join(directory, 'planted.test.ts');
      writeFileSync(file, "import { it } from 'node:test';\nit('reads', () => { (1).toLocaleString(); });\n");
      execFileSync(process.execPath, [`--import=${PROBE}`, '--test', file], {
        env: { ...process.env, FRUITBACK_LOCALE_PROBE: '', NODE_OPTIONS: '' },
        stdio: 'pipe',
      });
      assert.deepEqual(readdirSync(directory), ['planted.test.ts']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * The reads of PGlite are left out because its answers do not depend on the locale. Measured again
 * here under two locales: the day a version of PGlite answers otherwise, this fails, and its tests
 * have to run again in French.
 */
describe('PGlite under two locales', () => {
  it('answers the same collation, settings, order, formats and messages', () => {
    const script = `
      const { PGlite } = await import('@electric-sql/pglite');
      const db = await PGlite.create();
      const rows = async (sql) => (await db.query(sql)).rows;
      const out = {
        db: await rows("SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()"),
        settings: await rows("SELECT current_setting('lc_messages') m, current_setting('lc_numeric') n, current_setting('lc_time') t, current_setting('DateStyle') d"),
        order: (await rows("SELECT v FROM (VALUES ('b'),('B'),('a'),('é'),('e'),('Z')) t(v) ORDER BY v")).map((r) => r.v).join(''),
        formats: await rows("SELECT upper('é') u, to_char(1234.5, '9G999D9') n, to_char(timestamp '2026-10-21', 'TMMonth') m"),
      };
      try { await db.query('SELECT 1/0'); } catch (error) { out.error = error.message; }
      await db.close();
      console.log(JSON.stringify({ language: navigator.language, out }));`;
    const run = (locale: string) =>
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env: { ...process.env, LC_ALL: locale, LANG: locale, NODE_OPTIONS: '' },
          encoding: 'utf8',
        }),
      ) as { language: string; out: unknown };
    const english = run('en_US.UTF-8');
    const french = run('fr_FR.UTF-8');

    // Without two languages this compares a locale with itself.
    assert.equal(english.language, 'en-US');
    assert.equal(french.language, 'fr-FR');
    assert.deepEqual(french.out, english.out);
  });
});

describe('the code of the repository', () => {
  /** The variables of the environment that name a locale, which the probe does not watch. */
  it('reads no variable of the locale itself', () => {
    const readers: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', '.output', '.react-router', '.wxt', 'build'].includes(entry.name)) walk(path);
        } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
          if (/\benv(\.|\[['"])(LANG|LANGUAGE|LC_[A-Z]+)\b/.test(readFileSync(join(ROOT, path), 'utf8'))) {
            readers.push(path);
          }
        }
      }
    };
    for (const directory of ['apps', 'packages', 'tools']) walk(directory);

    assert.deepEqual(readers, [], 'these files read the locale from the environment, which the probe does not see');
  });
});

describe('the run again of what the probe wrote', () => {
  it('reads the lines of every process, once each, and the package and runner of each file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-locale-read-'));
    try {
      writeFileSync(
        join(directory, '1.tsv'),
        `/r/a.test.ts\tNumber#toLocaleString\n/r/a.test.ts\tnavigator.language\n`,
      );
      writeFileSync(
        join(directory, '2.tsv'),
        `/r/a.test.ts\tNumber#toLocaleString\n/r/b.test.ts\tIntl.Segmenter#segment\n\n`,
      );
      writeFileSync(join(directory, 'other.txt'), 'not a line of the probe\n');
      const read = readProbe(directory);

      assert.deepEqual([...read.keys()].sort(), ['/r/a.test.ts', '/r/b.test.ts']);
      assert.deepEqual([...(read.get('/r/a.test.ts') ?? [])].sort(), ['Number#toLocaleString', 'navigator.language']);
      assert.equal(readProbe(join(directory, 'absent')).size, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(packageOf(join(ROOT, 'apps/worker/src/cache.test.ts')), join(ROOT, 'apps/worker'));
    assert.equal(packageOf(join(ROOT, 'packages/widget/src/messages.test.ts')), join(ROOT, 'packages/widget'));
    assert.deepEqual(commandOf('vitest run', ['src/a.test.ts']), ['pnpm', ['exec', 'vitest', 'run', 'src/a.test.ts']]);
    assert.deepEqual(commandOf("node --test 'src/**/*.test.ts'", ['src/a.test.ts']), [
      'node',
      ['--test', 'src/a.test.ts'],
    ]);
  });
});
