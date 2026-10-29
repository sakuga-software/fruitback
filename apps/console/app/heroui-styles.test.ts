import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `app.css` imports the styles of the HeroUI components that the kit draws, and no other (FRU-492).
 * HeroUI's index imports the 85 of them: 386 kB of the 478 kB of the stylesheet, which every screen
 * loads before its first paint.
 *
 * A component of the kit with no style would be drawn bare, and no unit test sees that. So the
 * list is read from `ui.tsx`, the one file that imports `@heroui/react` (`messages.test.ts`), and
 * from the components of HeroUI that each of its imports imports in turn.
 */
const app = new URL('..', import.meta.url).pathname;
const require = createRequire(join(app, 'package.json'));
const react = join(dirname(require.resolve('@heroui/react/package.json')), 'dist');
const stylesPackage = dirname(require.resolve('@heroui/styles/package.json'));
const styles = join(stylesPackage, 'dist', 'components');
const css = readFileSync(join(app, 'app', 'app.css'), 'utf8');

/** The style files of HeroUI that a kit importing `names` from `@heroui/react` draws with. */
function needed(names: readonly string[]): string[] {
  const index = readFileSync(join(react, 'index.js'), 'utf8');
  const directories = new Set<string>();
  const visit = (directory: string): void => {
    if (directories.has(directory)) return;
    directories.add(directory);
    for (const file of readdirSync(join(react, 'components', directory)).filter((each) => each.endsWith('.js'))) {
      const source = readFileSync(join(react, 'components', directory, file), 'utf8');
      for (const found of source.matchAll(/from '\.\.\/([a-z-]+)\//g)) visit(found[1] as string);
    }
  };
  for (const name of names) {
    const found = new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./components/([a-z-]+)/`).exec(index);
    assert.ok(found, `@heroui/react exports no ${name}`);
    visit(found[1] as string);
  }

  return [...directories].filter((directory) => existsSync(join(styles, `${directory}.css`))).sort();
}

/**
 * The components that `source` imports from `@heroui/react`, from every import statement of the
 * package. Any other form of import from it (default, namespace, `export … from`) throws: its
 * components could not be listed.
 */
function importedBy(source: string): string[] {
  const statements = [...source.matchAll(/^import (type )?\{([^}]*)\} from '@heroui\/react';$/gm)];
  const mentions = source.match(/from '@heroui\/react'/g)?.length ?? 0;
  assert.equal(mentions, statements.length, 'ui.tsx imports @heroui/react in a form this guard cannot list');

  return statements
    .filter((statement) => statement[1] === undefined)
    .flatMap((statement) => (statement[2] as string).split(','))
    .map((each) => each.trim().split(/\s+as\s+/)[0] as string)
    .filter((each) => each !== '' && !each.startsWith('type '));
}

function importedByKit(): string[] {
  return importedBy(readFileSync(join(app, 'app', 'ui.tsx'), 'utf8'));
}

/** The component styles that `app.css` imports, in its order. */
const imported = [
  ...css.matchAll(/^@import '@heroui\/styles\/components\/([a-z-]+)\.css' layer\(components\);$/gm),
].map((found) => found[1] as string);

describe('the styles of HeroUI in the console (FRU-492)', () => {
  it('reads the components of ui.tsx only, because no other file of the console imports HeroUI', () => {
    // A component imported elsewhere would get no style, and the list above would not name it.
    const files = (readdirSync(join(app, 'app'), { recursive: true }) as string[]).filter(
      (file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'),
    );
    const others = files.filter(
      (file) => file !== 'ui.tsx' && /from '@heroui\/(react|styles)/.test(readFileSync(join(app, 'app', file), 'utf8')),
    );
    assert.ok(files.includes('ui.tsx') && files.includes(join('routes', 'home.tsx')), 'the walk found no screen');
    assert.deepEqual(others, []);
  });

  it('imports the style of each component the kit draws, and of no other', () => {
    assert.deepEqual([...imported].sort(), needed(importedByKit()));
  });

  it('imports them in the order of the index of HeroUI, which its rules rely on', () => {
    const order = [
      ...readFileSync(join(styles, 'index.css'), 'utf8').matchAll(/^@import "\.\/([a-z-]+)\.css";$/gm),
    ].map((found) => found[1] as string);
    assert.deepEqual(
      imported,
      order.filter((each) => imported.includes(each)),
    );
  });

  it('does not import the index of HeroUI, which holds them all', () => {
    assert.doesNotMatch(css, /@import '@heroui\/(react\/styles|styles)';/);
  });

  it('reads the styles of the version of HeroUI that draws the components', () => {
    const wanted = (
      JSON.parse(readFileSync(join(react, '..', 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['@heroui/styles'];
    const ours = (
      JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    ).dependencies['@heroui/styles'];
    assert.equal(ours, wanted);
  });

  it('lists the components of every import statement of @heroui/react, not of the first only', () => {
    const two =
      "import { Button, Input } from '@heroui/react';\nimport { x } from 'react';\nimport {\n  Tabs as HeroTabs,\n  type Key,\n} from '@heroui/react';\n";
    assert.deepEqual(importedBy(two), ['Button', 'Input', 'Tabs']);
    assert.deepEqual(importedBy("import type { Key } from '@heroui/react';"), []);
  });

  it('refuses a form of import of @heroui/react that it cannot list', () => {
    for (const form of [
      "import * as Hero from '@heroui/react';",
      "import Hero from '@heroui/react';",
      "export { Tabs } from '@heroui/react';",
    ]) {
      assert.throws(() => importedBy(`import { Button } from '@heroui/react';\n${form}`), /cannot list/);
    }
  });

  it('asks for the style of a component that the kit would start to import (the control)', () => {
    assert.ok(!needed(importedByKit()).includes('tabs'));
    assert.ok(needed([...importedByKit(), 'Tabs']).includes('tabs'));
  });
});
