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
    seedFixture({ note: 'Le bouton ne répond pas', reporter: { name: 'Alice', email: 'alice@example.com' } }),
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

  it('takes one selector, and refuses two of them (FRU-111)', () => {
    assert.deepEqual(parseForgetArgs(['--id', 'FB-2', '--id', 'FB-7', '--id', 'FB-2']), {
      ok: true,
      args: { which: { identifiers: ['FB-2', 'FB-7'] }, dryRun: false },
    });
    assert.equal(parseForgetArgs(['--email', 'alice@example.com', '--id', 'FB-2']).ok, false);
    assert.equal(parseForgetArgs(['--name', 'Alice', '--email', 'alice@example.com', '--dry-run']).ok, false);
    assert.equal(parseForgetArgs(['--email', 'a@example.com', '--email', 'b@example.com']).ok, false);
    assert.equal(parseForgetArgs([]).ok, false);
  });

  it('refuses an identifier that this store does not write', () => {
    for (const identifier of ['12', 'FB-0', 'FB-', 'fb-12', 'FB-1 OR 1=1', 'FRU-12']) {
      assert.equal(parseForgetArgs(['--id', identifier]).ok, false, identifier);
    }
    assert.equal(parseForgetArgs(['--id', '--dry-run']).ok, false);
  });

  it('lists by name and never deletes by name, because a name is not an identity', () => {
    assert.deepEqual(parseForgetArgs(['--name', ' Alice ', '--dry-run']), {
      ok: true,
      args: { which: { name: 'Alice' }, dryRun: true },
    });

    const refused = parseForgetArgs(['--name', 'Alice']);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.error, /--name only lists[\s\S]*--id/);
  });

  it('finds a note by the name it is signed with, then deletes it by its identifier (FRU-111)', async () => {
    const path = await storeWithAlice();

    const named = await runForget(['--name', 'alice', '--dry-run'], sqliteEnv(path));
    assert.ok(named.ok);
    assert.match(named.lines.join('\n'), /1 note\(s\) are signed alice\. Nothing was deleted[\s\S]*FB-1 /);

    const dry = await runForget(['--id', 'FB-1', '--dry-run'], sqliteEnv(path));
    assert.match(dry.lines.join('\n'), /Nothing was deleted[\s\S]*FB-1 /);

    const done = await runForget(['--id', 'FB-1'], sqliteEnv(path));
    assert.ok(done.ok);
    assert.match(done.lines.join('\n'), /deleted 1 note\(s\), with their replies, that are FB-1/);

    const again = await runForget(['--name', 'Alice', '--dry-run'], sqliteEnv(path));
    assert.deepEqual(again.lines, ['no note is signed Alice.']);
  });

  it('deletes nothing when one identifier of the list names no note', async () => {
    const path = await storeWithAlice();

    const refused = await runForget(['--id', 'FB-1', '--id', 'FB-99'], sqliteEnv(path));

    assert.equal(refused.ok, false);
    assert.deepEqual(refused.lines, ['no note is FB-99. Nothing was deleted.']);
    // FB-1 is still there: the same command without the wrong identifier finds it.
    const still = await runForget(['--id', 'FB-1', '--dry-run'], sqliteEnv(path));
    assert.match(still.lines.join('\n'), /1 note\(s\) are FB-1/);
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
