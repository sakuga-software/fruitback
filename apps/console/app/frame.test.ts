import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The sections of the rail of a workspace (FRU-234).
 *
 * The rail lists the sections in the order of the mockup of 2026-10-13, and shows an entry only for
 * a screen that exists: `built` in `SECTIONS`. The console has no DOM under `node --test`, so the
 * guard reads the sources, like `messages.test.ts`; `e2e/console-frame.spec.ts` reads the browser.
 */
const APP = new URL('./', import.meta.url);
const frame = readFileSync(new URL('routes/workspace.tsx', APP), 'utf8');

type Listed = { path?: string; children?: Listed[] };

async function paths(mode: string): Promise<string[]> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    // A query makes each import a new evaluation of the module, in the mode set above.
    const routes = (await import(`./routes.ts?frame=${mode}`)) as { default: Listed[] };
    const flat = (list: Listed[]): string[] =>
      list.flatMap((each) => [...(each.path === undefined ? [] : [each.path]), ...flat(each.children ?? [])]);

    return flat(routes.default);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/** The sections a source declares: the path, the English label, and whether its screen is built. */
function sections(source: string): { path: string; label: string; built: boolean }[] {
  return [...source.matchAll(/\{ path: '([a-z]+)', label: msg\('([^']+)'\), built: (true|false) \}/g)].map(
    ([, path, label, built]) => ({ path: path as string, label: label as string, built: built === 'true' }),
  );
}

describe('the sections of the rail (FRU-234)', () => {
  it('are the five of the mockup, in its order, with « Settings » before « My account » (FRU-503)', () => {
    assert.deepEqual(
      sections(frame).map(({ label }) => label),
      ['Sites', 'Notes', 'Connectors', 'Members', 'Settings', 'My account'],
    );
  });

  it('show an entry for each screen of a build, and for no screen that does not exist', async () => {
    const built = await paths('production');
    const dead = (list: { path: string; built: boolean }[], routes: string[]) =>
      list
        .filter(({ path, built: shown }) => shown !== routes.includes(`w/:workspace/${path}`))
        .map(({ path }) => path);

    assert.deepEqual(dead(sections(frame), built), []);
    // The control: an entry that is shown with no route is found, and so is a route with no entry.
    assert.deepEqual(dead([{ path: 'reports', built: true }], built), ['reports']);
    assert.deepEqual(dead([{ path: 'sites', built: false }], built), ['sites']);
    // Every screen of a workspace is a section: a route the rail does not know has no entry. The
    // settings are one since FRU-503, and the name of the workspace still leads to them (FRU-414).
    const screens = built.filter((path) => path.startsWith('w/:workspace/')).map((path) => path.split('/')[2]);
    assert.ok(frame.includes('/settings`'), 'the name of the workspace leads to the settings');
    assert.deepEqual(
      screens.filter((path) => !sections(frame).some((section) => section.path === path)),
      [],
    );
    assert.ok(screens.length >= 4, built.join(', '));
  });

  it('has the page that shows them all on the development server only', async () => {
    assert.equal((await paths('production')).includes('kit/frame'), false);
    assert.ok((await paths('development')).includes('kit/frame'));
  });
});
