import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `/kit` mounts every component of the kit once, for `e2e/console-kit.spec.ts` (FRU-232). It is a
 * page of the development server: a build of the console has no such route.
 */
type Listed = { path?: string; children?: Listed[] };

async function paths(mode: string): Promise<string[]> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    // A query makes each import a new evaluation of the module, in the mode set above.
    const routes = (await import(`./routes.ts?mode=${mode}`)) as { default: Listed[] };
    const flat = (list: Listed[]): string[] =>
      list.flatMap((each) => [...(each.path === undefined ? [] : [each.path]), ...flat(each.children ?? [])]);

    return flat(routes.default);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

describe('the page of the kit (FRU-232)', () => {
  it('is no route of a build', async () => {
    const built = await paths('production');

    assert.equal(built.includes('kit'), false);
    // The control: the routes were read, and the screens are among them.
    assert.ok(built.includes('setup') && built.includes('w/:workspace/sites'), built.join(', '));
  });

  it('is a route of the development server', async () => {
    assert.ok((await paths('development')).includes('kit'));
  });
});
