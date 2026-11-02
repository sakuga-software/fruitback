import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The French map is loaded only when French is asked for (FRU-494). It is 110 kB of the chunk that
 * every page loaded, and a person who reads English did not need it: 150 ms of LCP on a phone.
 *
 * The bundler puts a module in a chunk of its own when every way to it is an `import()`. One static
 * import, from any file the console ships, puts it back in the chunk of that file. So this follows
 * the static imports from the routes, as the bundler does, and fails when it reaches the map.
 */
const APP = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(APP, 'messages.fr.ts');

/** The files a static `import … from`, `export … from` or `import '…'` of `source` names, in the app. */
function staticImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const named = [
    ...source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ]
    // `import type` is erased: it puts nothing in a chunk.
    .filter((match) => !/^\s*(?:import|export)\s+type\s/.test(match[0]))
    .map((match) => match[1] as string)
    .filter((path) => path.startsWith('.'));

  return named.flatMap((path) => {
    const base = join(dirname(file), path);
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
      (candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate),
    );

    return found === undefined ? [] : [found];
  });
}

/** Each file the bundler reaches from `entries` by static imports, with the path that reached it. */
function reached(entries: string[]): Map<string, string[]> {
  const paths = new Map(entries.map((entry) => [entry, [entry]]));
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const next of staticImports(file)) {
      if (paths.has(next)) continue;
      paths.set(next, [...(paths.get(file) ?? []), next]);
      queue.push(next);
    }
  }

  return paths;
}

/** `root.tsx` and every module that `routes.ts` names: the entries of the build. */
function entries(): string[] {
  const routes = readFileSync(join(APP, 'routes.ts'), 'utf8');
  const modules = [...routes.matchAll(/\b(?:index|route|layout)\(\s*(?:'[^']*',\s*)?'([^']+\.tsx)'/g)].map((match) =>
    join(APP, match[1] as string),
  );

  return [join(APP, 'root.tsx'), ...modules];
}

describe('the French map (FRU-494)', () => {
  it('is reached from no screen by a static import, so an English page never downloads it', () => {
    const graph = reached(entries());
    const way = graph.get(CATALOG)?.map((file) => relative(APP, file));

    assert.equal(way, undefined, `a static import puts the French map in a shared chunk: ${way?.join(' → ')}`);
  });

  it('is read by the graph above: the screens, the kit and i18n.ts are in it', () => {
    // The control: a graph that read nothing would never reach the map either.
    const graph = reached(entries());
    for (const file of ['root.tsx', 'routes/sites.tsx', 'ui.tsx', 'i18n.ts']) {
      assert.ok(graph.has(join(APP, file)), `${file} is not reached`);
    }
    assert.ok(graph.size > 40, `only ${graph.size} files were reached`);
  });

  it('is loaded by an import() in i18n.ts', () => {
    assert.match(readFileSync(join(APP, 'i18n.ts'), 'utf8'), /import\(\s*'\.\/messages\.fr\.ts'\s*\)/);
  });
});
