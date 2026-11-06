import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * `routes/` holds the routes, and only them (FRU-614). A part of a screen is in `parts/`: 16 parts
 * sat beside the routes, and nothing said which file a URL opens.
 */
const APP = new URL('./', import.meta.url);
const config = readFileSync(new URL('routes.ts', APP), 'utf8');

/** The files of `routes/` that `routes.ts` does not name. */
function notRoutes(files: readonly string[], routes: string): string[] {
  return files.filter((name) => !routes.includes(`'routes/${name}'`));
}

describe('the folder of the routes (FRU-614)', () => {
  it('holds no file that routes.ts does not name', () => {
    const files = readdirSync(new URL('routes/', APP));

    assert.deepEqual(notRoutes(files, config), []);
    assert.ok(files.length > 20, `only ${files.length} files were read`);
  });

  it('finds a part left among the routes: the control', () => {
    assert.deepEqual(notRoutes(['notes.tsx', 'notes-board.tsx'], "route('w/:workspace/notes', 'routes/notes.tsx')"), [
      'notes-board.tsx',
    ]);
  });

  it('names no route that is not in routes/', () => {
    const named = [...config.matchAll(/'routes\/([\w-]+\.tsx)'/g)].map((match) => match[1]);
    const files = new Set(readdirSync(new URL('routes/', APP)));

    assert.deepEqual(
      named.filter((name) => !files.has(name as string)),
      [],
    );
  });
});
