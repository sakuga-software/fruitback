import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { parseForgetArgs, runForget } from './cli.ts';
import { closeSqliteConnections, createSqliteStore } from './sqlite.ts';

let directories: string[] = [];

afterEach(() => {
  closeSqliteConnections();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

async function storeWithAlice(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-forget-'));
  directories.push(directory);
  const path = join(directory, 'fruitback.db');
  await createSqliteStore({ path }).create(
    seedFixture({ note: 'Le bouton ne répond pas', reporter: { email: 'alice@example.com' } }),
    undefined,
    { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' },
  );
  closeSqliteConnections();

  return path;
}

function sqliteEnv(path: string) {
  return { FRUITBACK_STORE: 'sqlite', FRUITBACK_SQLITE_PATH: path, ALLOWED_ORIGINS: '*' };
}

describe('node server.mjs forget (FRU-85)', () => {
  it('refuses a flag it does not know, so a typo cannot delete what --dry-run would only list', () => {
    const parsed = parseForgetArgs(['--email', 'alice@example.com', '--dryrun']);

    assert.equal(parsed.ok, false);
  });

  it('requires an address', () => {
    assert.equal(parseForgetArgs(['--dry-run']).ok, false);
    assert.equal(parseForgetArgs(['--email', '  ']).ok, false);
  });

  it('never reads a flag as the address, so a dry run cannot turn into a deletion', () => {
    assert.equal(parseForgetArgs(['--email', '--dry-run']).ok, false);
    assert.equal(parseForgetArgs(['--email', '--dry-run', 'alice@example.com']).ok, false);
  });

  it('lists on a dry run, then deletes, and says so', async () => {
    const path = await storeWithAlice();

    const dry = await runForget(['--email', 'alice@example.com', '--dry-run'], sqliteEnv(path));
    assert.ok(dry.ok);
    assert.match(dry.lines.join('\n'), /Nothing was deleted[\s\S]*FB-1 .*Le bouton ne répond pas/);

    const done = await runForget(['--email', 'alice@example.com'], sqliteEnv(path));
    assert.ok(done.ok);
    assert.match(done.lines.join('\n'), /deleted 1 note[\s\S]*FB-1/);

    const again = await runForget(['--email', 'alice@example.com'], sqliteEnv(path));
    assert.match(again.lines.join('\n'), /no note gives alice@example.com/);
  });

  it('refuses a store that cannot delete from here, and says where the notes are', async () => {
    const memory = await runForget(['--email', 'alice@example.com'], {
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: '*',
    });
    assert.equal(memory.ok, false);
    assert.match(memory.lines.join('\n'), /the memory store does not delete[\s\S]*memory of the worker/);

    const linear = await runForget(['--email', 'alice@example.com'], {
      LINEAR_API_KEY: 'lin_api_test',
      LINEAR_TEAM_ID: 'team',
      ALLOWED_ORIGINS: '*',
    });
    assert.equal(linear.ok, false);
    assert.match(
      linear.lines.join('\n'),
      /the linear store does not delete[\s\S]*issues in your tracker: search them for alice@example.com/,
    );
  });
});
