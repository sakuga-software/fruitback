import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The mutants of source files, as StrykerJS 10.0.0 would make them, with no test run (FRU-347).
 *
 * It calls the instrumenter of StrykerJS, which the mutation job installs in `tools/mutation/`, and
 * names the function that holds each mutant. Use it to measure a change to a mutated file: the
 * number of mutants before and after, by mutator and by function.
 *
 *   pnpm install --frozen-lockfile --ignore-workspace --dir tools/mutation
 *   node tools/mutation-study/count.ts [--json] <source file>…
 *
 * `--json` prints each mutant (file, function, mutator, line, replacement) instead of the tables.
 */

type Location = { start: { line: number; column: number }; end: { line: number; column: number } };
type Mutant = { fileName: string; mutatorName: string; replacement: string; location: Location };
type Node = {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  id?: Node | null;
  key?: Node;
  name?: string;
  [key: string]: unknown;
};

const ROOT = new URL('../mutation/node_modules/', import.meta.url);
// pnpm links each package from `.pnpm/`: resolve from the real path of the core, beside which its
// own dependencies sit.
const coreRequire = createRequire(realpathSync(new URL('@stryker-mutator/core/package.json', ROOT)));
const instrumenterPath = coreRequire.resolve('@stryker-mutator/instrumenter');
const babelRequire = createRequire(instrumenterPath);

/** Where a function starts and ends, and its name. */
type Scope = { name: string; start: number; end: number };

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
]);

function nameOf(node: Node, parent: Node | undefined): string {
  if (node.id?.name !== undefined) return node.id.name;
  if (node.key?.name !== undefined) return node.key.name;
  if (parent?.type === 'VariableDeclarator' && (parent.id as Node | undefined)?.name !== undefined) {
    return (parent.id as Node).name as string;
  }
  if (parent?.type === 'ObjectProperty' && (parent.key as Node | undefined)?.name !== undefined) {
    return (parent.key as Node).name as string;
  }
  return '(anonymous)';
}

/** The top-level functions of a file and the named functions they hold, by offset. */
export function scopes(ast: Node, offsetOf: (line: number, column: number) => number): Scope[] {
  const found: Scope[] = [];
  const walk = (node: Node, parent: Node | undefined) => {
    if (FUNCTIONS.has(node.type) && node.loc !== undefined) {
      const name = nameOf(node, parent);
      if (name !== '(anonymous)') {
        found.push({
          name,
          start: offsetOf(node.loc.start.line, node.loc.start.column),
          end: offsetOf(node.loc.end.line, node.loc.end.column),
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object' && 'type' in child) walk(child as Node, node);
      } else if (value && typeof value === 'object' && 'type' in value && (value as Node).type !== undefined) {
        walk(value as Node, node);
      }
    }
  };
  walk(ast, undefined);
  return found;
}

/** The innermost named function that holds a position, or `(module)` for top-level code. */
export function holder(found: Scope[], offset: number): string {
  let best: Scope | undefined;
  for (const scope of found) {
    if (scope.start <= offset && offset <= scope.end && (best === undefined || scope.start >= best.start)) {
      best = scope;
    }
  }
  return best?.name ?? '(module)';
}

async function main(args: string[]) {
  const json = args.includes('--json');
  const files = args.filter((arg) => arg !== '--json');
  if (files.length === 0) {
    console.error('usage: node tools/mutation-study/count.ts [--json] <source file>…');
    process.exit(2);
  }
  const { Instrumenter } = (await import(pathToFileURL(instrumenterPath).href)) as {
    Instrumenter: new (logger: unknown) => {
      instrument(
        files: { name: string; content: string; mutate: true }[],
        options: { plugins: null; excludedMutations: string[]; ignorers: string[] },
      ): Promise<{ mutants: Mutant[] }>;
    };
  };
  const { parse } = babelRequire('@babel/parser') as { parse(code: string, options: object): { program: Node } };
  const quiet = () => undefined;
  const logger = {
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    trace: quiet,
    fatal: quiet,
    isDebugEnabled: () => false,
    isTraceEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => false,
    isErrorEnabled: () => false,
    isFatalEnabled: () => false,
  };

  const input = files.map((file) => ({
    name: resolve(file),
    content: readFileSync(file, 'utf8'),
    mutate: true as const,
  }));
  const { mutants } = await new Instrumenter(logger).instrument(input, {
    plugins: null,
    excludedMutations: [],
    ignorers: [],
  });

  const rows: { file: string; fn: string; mutator: string; line: number; replacement: string }[] = [];
  for (const { name, content } of input) {
    const lineStarts = [0];
    for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) lineStarts.push(at + 1);
    const offsetOf = (line: number, column: number) => (lineStarts[line - 1] ?? 0) + column;
    const ast = parse(content, { sourceType: 'module', plugins: ['typescript'] }).program;
    const found = scopes(ast, offsetOf);
    const file = files[input.findIndex((entry) => entry.name === name)] ?? name;
    for (const mutant of mutants.filter((m) => m.fileName === name)) {
      // The instrumenter counts lines from 0 and Babel from 1.
      const line = mutant.location.start.line + 1;
      rows.push({
        file,
        fn: holder(found, offsetOf(line, mutant.location.start.column)),
        mutator: mutant.mutatorName,
        line,
        replacement: mutant.replacement,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 1));
    return;
  }
  const tally = (key: (row: (typeof rows)[number]) => string, within: typeof rows) => {
    const count = new Map<string, number>();
    for (const row of within) count.set(key(row), (count.get(key(row)) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]);
  };
  console.log(`| File | Mutants |\n| --- | --- |`);
  for (const [file, n] of tally((row) => row.file, rows)) console.log(`| \`${file}\` | ${n} |`);
  console.log(`| **Total** | **${rows.length}** |\n`);
  console.log(`| Mutator | Mutants |\n| --- | --- |`);
  for (const [mutator, n] of tally((row) => row.mutator, rows)) console.log(`| ${mutator} | ${n} |`);
  console.log(`\n| File | Function | Mutants |\n| --- | --- | --- |`);
  for (const [key, n] of tally((row) => `${row.file}\t${row.fn}`, rows)) {
    const [file, fn] = key.split('\t');
    console.log(`| \`${file}\` | \`${fn}\` | ${n} |`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
