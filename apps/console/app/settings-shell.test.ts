import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The navigation of the settings (FRU-692).
 *
 * It lists the pages of the mockup in its order, and shows an entry only for a page that exists:
 * `built` in `ACCOUNT_PAGES` and `WORKSPACE_PAGES`. The console has no DOM under `node --test`, so
 * the guard reads the sources, as `frame.test.ts` does; `e2e/console-account.spec.ts` reads the
 * browser.
 */
const APP = new URL('./', import.meta.url);
const shell = readFileSync(new URL('routes/settings-shell.tsx', APP), 'utf8');

type Listed = { path?: string; file?: string; children?: Listed[] };

/** The routes of a build, with the layout each one is under. */
async function routes(): Promise<{ path: string; shell: boolean }[]> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    // A query makes the import a new evaluation of the module, in the mode set above.
    const config = (await import(`./routes.ts?settings=${process.env.NODE_ENV}`)) as { default: Listed[] };
    const flat = (list: Listed[], inShell: boolean): { path: string; shell: boolean }[] =>
      list.flatMap((each) => {
        const under = inShell || each.file === 'routes/settings-shell.tsx';

        return [
          ...(each.path === undefined ? [] : [{ path: each.path, shell: under }]),
          ...flat(each.children ?? [], under),
        ];
      });

    return flat(config.default, false);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/** The pages a source declares, in its order: the path, the English label, and whether it is built. */
function pages(source: string): { path: string; label: string; built: boolean }[] {
  return [
    ...source.matchAll(/\{ path: '([a-z/-]+)', label: msg\('([^']+)'\), icon: '[a-z]+', built: (true|false) \}/g),
  ].map(([, path, label, built]) => ({ path: path as string, label: label as string, built: built === 'true' }));
}

/** The pages whose `built` does not say whether a route of a build has their path. */
function dead(list: readonly { path: string; built: boolean }[], built: readonly string[]): string[] {
  return list
    .filter(({ path, built: shown }) => shown !== built.includes(`w/:workspace/${path}`))
    .map(({ path }) => path);
}

describe('the navigation of the settings (FRU-692)', () => {
  it('lists the ten pages of the mockup, in its order', () => {
    assert.deepEqual(
      pages(shell).map(({ label }) => label),
      [
        'Profile',
        'Sign-in and addresses',
        'Sessions',
        'Appearance',
        'Notifications',
        'General',
        'AI',
        'Agents',
        'Members',
        'Connectors',
      ],
    );
  });

  it('shows an entry for each page of a build, and for no page that does not exist', async () => {
    const built = (await routes()).map(({ path }) => path);

    assert.deepEqual(dead(pages(shell), built), []);
    // The control: an entry shown with no route is found, and so is a route with no entry shown.
    assert.deepEqual(dead([{ path: 'account/notifications', built: true }], built), ['account/notifications']);
    assert.deepEqual(dead([{ path: 'account', built: false }], built), ['account']);
  });

  it('puts the pages of the person and the settings of the workspace in the shell', async () => {
    const all = await routes();
    const inShell = all.filter((route) => route.shell).map(({ path }) => path);

    assert.deepEqual(inShell, [
      'w/:workspace/account',
      'w/:workspace/account/sessions',
      'w/:workspace/account/appearance',
      'w/:workspace/settings',
      'w/:workspace/settings/ai',
      'w/:workspace/settings/agents',
    ]);
    // Every page of the shell is an entry of its navigation.
    const shown = pages(shell)
      .filter(({ built }) => built)
      .map(({ path }) => `w/:workspace/${path}`);
    assert.deepEqual(
      inShell.filter((path) => !shown.includes(path)),
      [],
    );
  });
});
