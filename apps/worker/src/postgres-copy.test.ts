import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import {
  ACCOUNTS_FILE_VERSION as VERSION_OF_THE_FILE_STORE,
  closeAccountConnections,
  createSqliteAccountStore,
} from './accounts-sqlite.fixture.ts';
import { parseMigrateArgs } from './cli.ts';
import { type Database, createPgDatabase } from './postgres.ts';
import { ACCOUNTS_FILE_VERSION, COPY_SCHEMA, copySqliteFiles } from './postgres-copy.ts';
import {
  NO_REAL_POSTGRES,
  appliedDates,
  createPgliteDatabase,
  createRealDatabase,
  journalDates,
  journalTags,
  ownDatabase,
  rowsOf,
} from './postgres.fixture.ts';
import { open, seal } from './secrets.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing, redeemPairing, refreshSession } from './session.ts';

/**
 * The copy of the switch n° 1 (FRU-145): the two SQLite files of a worker, into an empty PostgreSQL.
 *
 * The files are made by the stores of the worker, with their real migrations, and their connections
 * stay open while the copy runs: the rows are in the `-wal`, as on a worker that was just stopped.
 *
 * **The copy leaves the database at the migration `COPY_SCHEMA`** (FRU-146), where the tables are the
 * ones of the files. A store of PostgreSQL applies the migrations after it at its first call, as a
 * worker does when it starts: a case that plants a row beside the copy writes it with a statement,
 * and not through a store, which would move the rows first.
 */

const run = promisify(execFile);
const SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123';
const API_KEY = 'lin_api_not_a_real_key';

const folders: string[] = [];

after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** The two files of a worker that has served: what the copy must carry, and what proves it did. */
async function filesOfAWorker() {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-copy-test-'));
  folders.push(folder);
  const accountsPath = join(folder, 'accounts.db');
  const sessionsPath = join(folder, 'sessions.db');
  const accounts = createSqliteAccountStore(accountsPath);
  const sessions = createSqliteSessionStore(sessionsPath);

  const alice = await accounts.signIn({ provider: 'github', subject: '1', email: 'alice@acme.dev', name: 'Alice' });
  await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev', locale: 'fr' });
  const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
  const workspace = await accounts.createWorkspace('Acme', alice.id);
  await accounts.createWorkspace('Bob and co', bob.id);
  const site = await accounts.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'members' });
  const tracker = await accounts.addConnector(workspace.id, {
    kind: 'linear',
    label: 'Linear',
    sealed: seal(API_KEY, SECRETS_KEY),
  });
  const hook = await accounts.addConnector(workspace.id, {
    kind: 'rest',
    label: 'Hook',
    sealed: seal('h', SECRETS_KEY),
  });
  assert.equal(
    await accounts.setDestinations(workspace.id, site.id, [
      { connector: tracker.id, teamId: 'team-1', label: 'Bugs' },
      { connector: hook.id },
    ]),
    true,
  );
  await accounts.noteConnector(hook.id, 'key-refused', 1_000);
  const delivery = await accounts.enqueueDelivery(hook.id, '{"n":1}', 2_000);
  await accounts.settleDelivery(delivery, { delivered: false, attempts: 0, at: 3_000, status: 503 });
  await accounts.enqueueDelivery(hook.id, '{"n":2}', 4_000);
  // A link of the sign-in of before, which waits in the file: the store no longer writes one (FRU-150).
  const file = new DatabaseSync(accountsPath);
  file
    .prepare('INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('digest-1', 'carol@acme.dev', Date.now(), Date.now() + 60_000);
  file.close();

  const redeemed = await redeemPairing(
    sessions,
    (await createPairing(sessions, { subject: alice.id, name: 'Alice', workspace: workspace.id })).code,
    SECRET,
  );
  assert.ok(redeemed.ok);
  await createPairing(sessions, { subject: bob.id });

  return {
    folder,
    accountsPath,
    sessionsPath,
    refreshToken: redeemed.session.refreshToken,
    tracker: tracker.id,
    workspace: workspace.id,
    alice: alice.id,
  };
}

/** The SHA-256 of every file of the folder: a file, its `-wal` and its `-shm`. */
function digests(folder: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(folder, name)))
          .digest('hex'),
      ]),
  );
}

/** The count of each table of the target. */
async function counts(database: Database): Promise<Record<string, number>> {
  const tables = [
    'accounts',
    'logins',
    'workspaces',
    'members',
    'connectors',
    'sites',
    'site_destinations',
    'deliveries',
    'email_links',
    'pairings',
    'sessions',
  ];
  const found: Record<string, number> = {};
  for (const table of tables) {
    found[table] = Number((await rowsOf(database, `SELECT count(*) AS n FROM ${table}`))[0]?.n);
  }

  return found;
}

const COPIED_COUNTS = {
  accounts: 2,
  logins: 3,
  workspaces: 2,
  members: 2,
  connectors: 2,
  sites: 1,
  site_destinations: 2,
  deliveries: 2,
  email_links: 0,
  pairings: 2,
  sessions: 1,
};

const EMPTY = Object.fromEntries(Object.keys(COPIED_COUNTS).map((table) => [table, 0]));

const SUBJECTS: { label: string; open: () => Promise<Database>; skip: string | false }[] = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
  // FRU-219: the copy writes where the worker of that database reads, and names no schema.
  {
    label: 'a real server, in a schema of its own',
    open: () => createRealDatabase('fruitback_copy'),
    skip: NO_REAL_POSTGRES,
  },
];

for (const subject of SUBJECTS) {
  describe(`the copy of the two SQLite files, on ${subject.label} (FRU-145)`, { skip: subject.skip }, () => {
    let database: Database | undefined;

    afterEach(async () => {
      closeAccountConnections();
      closeSessionConnections();
      await database?.close();
      database = undefined;
    });

    it('copies every row: a session opened before refreshes after, and a sealed connector opens', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, true, outcome.lines.join('\n'));
      assert.match(outcome.lines.at(-1) ?? '', /^copied/);
      assert.deepEqual(await counts(database), COPIED_COUNTS);

      const refreshed = await refreshSession(createPostgresSessionStore(database), files.refreshToken, SECRET);
      assert.ok(refreshed.ok, 'the session of the file refreshes on PostgreSQL');
      assert.equal(refreshed.identity.subject, files.alice);
      assert.equal(refreshed.identity.workspace, files.workspace);

      const accounts = createPostgresAccountStore(database);
      const sealed = await accounts.sealedKey(files.tracker);
      assert.equal(open(sealed?.sealed ?? '', SECRETS_KEY), API_KEY);
      assert.deepEqual(await accounts.memberships(files.alice), [
        { workspace: { id: files.workspace, name: 'Acme' }, role: 'owner' },
      ]);
      // The first call of a store moved the people into the tables of better-auth (FRU-146): the same
      // person, under the same id, by each way she signed in with.
      assert.deepEqual(await accounts.account(files.alice), {
        id: files.alice,
        email: 'alice@acme.dev',
        name: 'Alice',
        locale: 'fr',
      });
      for (const [provider, subject] of [
        ['github', '1'],
        ['email', 'alice@acme.dev'],
      ] as const) {
        const again = await accounts.signIn({ provider, subject, email: 'alice@acme.dev' });
        assert.equal(again.id, files.alice);
      }
      assert.deepEqual(await rowsOf(database, 'SELECT count(*)::int AS n FROM "account"'), [{ n: 3 }]);
      const [site] = await accounts.sites(files.workspace);
      assert.deepEqual(
        site?.destinations.map((destination) => destination.connector),
        [files.tracker, (await accounts.connectors(files.workspace)).find((c) => c.kind === 'rest')?.id],
      );
    });

    it('writes nothing beside the two files, and leaves them as they were', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      // The rows are in the journal: the file alone, copied without it, holds no account.
      assert.ok(statSync(`${files.accountsPath}-wal`).size > 0);
      const aloneFolder = mkdtempSync(join(tmpdir(), 'fruitback-copy-alone-'));
      folders.push(aloneFolder);
      const alone = join(aloneFolder, 'accounts.db');
      copyFileSync(files.accountsPath, alone);
      const control = new DatabaseSync(alone);
      const tables = control.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'accounts'").get();
      control.close();
      assert.deepEqual({ ...tables }, { n: 0 });

      const before = digests(files.folder);
      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, true, outcome.lines.join('\n'));
      assert.deepEqual(digests(files.folder), before);
    });

    it('reads the two files in a folder that it cannot write', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      const names = readdirSync(files.folder);
      for (const name of names) chmodSync(join(files.folder, name), 0o444);
      chmodSync(files.folder, 0o555);
      try {
        const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

        assert.equal(outcome.ok, true, outcome.lines.join('\n'));
        assert.deepEqual(await counts(database), COPIED_COUNTS);
        assert.deepEqual(readdirSync(files.folder), names);
      } finally {
        chmodSync(files.folder, 0o755);
      }
    });

    it('keeps nothing on a dry run, and says the counts are equal', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();

      const outcome = await copySqliteFiles({ ...files, database, dryRun: true });

      assert.equal(outcome.ok, true, outcome.lines.join('\n'));
      assert.match(outcome.lines.at(-1) ?? '', /^dry run/);
      assert.equal(outcome.lines.filter((line) => line.includes(' same ')).length, 10);
      assert.deepEqual(await counts(database), EMPTY);
    });

    it('writes nothing again when it runs a second time', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: false })).ok, true);

      const again = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(again.ok, true, again.lines.join('\n'));
      assert.match(again.lines[0] ?? '', /already holds exactly these rows/);
      assert.deepEqual(await counts(database), COPIED_COUNTS);
    });

    it('refuses a database that holds these rows and a sign-in link made since', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: false })).ok, true);
      // The links are not copied, and this one is new.
      await rowsOf(
        database,
        "INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES ('digest-2', 'dave@acme.dev', 1, 2)",
      );

      const again = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(again.ok, false, again.lines.join('\n'));
      assert.match(again.lines.join('\n'), /PostgreSQL is not empty, and does not hold these rows/);
      assert.deepEqual(await counts(database), { ...COPIED_COUNTS, email_links: 1 });
    });

    it('refuses a database that holds other rows, and writes nothing', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      // The schema first: a dry run leaves the tables, and no row.
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: true })).ok, true);
      await rowsOf(database, "INSERT INTO accounts (id, email, created_at) VALUES ('acc_x', 'x@y.dev', 1)");
      await rowsOf(
        database,
        "INSERT INTO logins (provider, subject, account_id, created_at) VALUES ('email', 'x@y.dev', 'acc_x', 1)",
      );

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, false);
      assert.match(outcome.lines.join('\n'), /PostgreSQL is not empty.*rows in accounts, logins\./);
      assert.deepEqual(await counts(database), { ...EMPTY, accounts: 1, logins: 1 });
    });

    it('refuses a database that holds a person in the tables of better-auth, where the copy writes nothing', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: true })).ok, true);
      // The migration after the copy puts the people there: a row of before would meet them.
      await rowsOf(
        database,
        `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('acc_x', '', 'alice@acme.dev', true)`,
      );

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, false);
      assert.match(outcome.lines.join('\n'), /PostgreSQL is not empty.*rows in user\./);
      assert.deepEqual(await counts(database), EMPTY);
    });

    it('stops the database at the migration whose tables are the ones of the files, and a worker applies the rest', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();

      assert.equal((await copySqliteFiles({ ...files, database, dryRun: false })).ok, true);

      const journal = journalDates();
      const last = journalTags().indexOf(COPY_SCHEMA);
      assert.ok(last >= 0 && last < journal.length - 1, 'a migration comes after the one of the copy');
      assert.deepEqual(await appliedDates(database), journal.slice(0, last + 1));

      await createPostgresAccountStore(database).account(files.alice);
      assert.deepEqual(await appliedDates(database), journal);
    });

    it('refuses a database on which a worker started since the copy, and says why', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: false })).ok, true);
      // What a worker does at its first call: the migrations after the copy, which move the accounts.
      await createPostgresAccountStore(database).account(files.alice);

      for (const dryRun of [true, false]) {
        const again = await copySqliteFiles({ ...files, database, dryRun });

        assert.equal(again.ok, false, again.lines.join('\n'));
        assert.match(again.lines.join('\n'), /refused: a worker already started on this database/);
      }
      assert.deepEqual(await rowsOf(database, 'SELECT count(*)::int AS n FROM "user"'), [{ n: 2 }]);
      assert.deepEqual(await rowsOf(database, 'SELECT count(*)::int AS n FROM sessions'), [{ n: 1 }]);
    });

    it('leaves nothing when it stops in the middle, and gives the same result when it runs again', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      // The schema first, then a trigger that stops the copy at its last table.
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: true })).ok, true);
      await rowsOf(
        database,
        `CREATE FUNCTION stop_the_copy() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN RAISE EXCEPTION 'the copy stops here'; END $$`,
      );
      await rowsOf(database, 'CREATE TRIGGER stop_the_copy BEFORE INSERT ON sessions EXECUTE FUNCTION stop_the_copy()');

      await assert.rejects(copySqliteFiles({ ...files, database, dryRun: false }), /the copy stops here/);
      assert.deepEqual(await counts(database), EMPTY);

      await rowsOf(database, 'DROP TRIGGER stop_the_copy ON sessions');
      const again = await copySqliteFiles({ ...files, database, dryRun: false });
      assert.equal(again.ok, true, again.lines.join('\n'));
      assert.deepEqual(await counts(database), COPIED_COUNTS);
    });

    it('fails its final count when a row goes missing in the target, and keeps nothing', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      assert.equal((await copySqliteFiles({ ...files, database, dryRun: true })).ok, true);
      // The violation: one row of the pairings disappears as soon as they are written.
      await rowsOf(
        database,
        `CREATE FUNCTION lose_a_pairing() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN DELETE FROM pairings WHERE code_hash = (SELECT min(code_hash) FROM pairings); RETURN NULL; END $$`,
      );
      await rowsOf(
        database,
        'CREATE TRIGGER lose_a_pairing AFTER INSERT ON pairings FOR EACH STATEMENT EXECUTE FUNCTION lose_a_pairing()',
      );

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, false);
      assert.match(outcome.lines.join('\n'), /pairings\s+2\s+1\s+DIFFERENT/);
      assert.match(outcome.lines.at(-1) ?? '', /^refused: a table of PostgreSQL differs/);
      assert.deepEqual(await counts(database), EMPTY);
    });

    it('refuses a file with a column that PostgreSQL does not have', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      closeAccountConnections();
      const file = new DatabaseSync(files.accountsPath);
      file.exec('ALTER TABLE accounts ADD COLUMN nickname TEXT');
      file.close();

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, false);
      assert.match(outcome.lines[0] ?? '', /the table accounts differs: nickname is not in PostgreSQL/);
    });

    it('refuses a file that a worker of another version wrote', async () => {
      const files = await filesOfAWorker();
      database = await subject.open();
      closeSessionConnections();
      const file = new DatabaseSync(files.sessionsPath);
      file.exec('PRAGMA user_version = 2');
      file.close();

      const outcome = await copySqliteFiles({ ...files, database, dryRun: false });

      assert.equal(outcome.ok, false);
      assert.match(outcome.lines[0] ?? '', /the sessions file is at version 2, and this worker writes version 3/);
      assert.deepEqual(await counts(database).catch(() => EMPTY), EMPTY);
    });
  });
}

describe('the version of the accounts file that the copy takes (FRU-150)', () => {
  it('is the one of the store that wrote the files, which is a fixture now', () => {
    assert.equal(ACCOUNTS_FILE_VERSION, VERSION_OF_THE_FILE_STORE);
  });
});

describe('the arguments of migrate-to-postgres (FRU-145)', () => {
  it('takes the two files, and --dry-run', () => {
    assert.deepEqual(parseMigrateArgs(['--accounts', 'a.db', '--sessions', 's.db', '--dry-run']), {
      ok: true,
      args: { copy: 'accounts', accountsPath: 'a.db', sessionsPath: 's.db', dryRun: true },
    });
  });

  it('refuses a flag it does not know, a flag with no file, and a missing file', () => {
    for (const argv of [
      ['--accounts', 'a.db', '--sessions', 's.db', '--dryrun'],
      ['--accounts', '--dry-run', '--sessions', 's.db'],
      ['--accounts', 'a.db'],
      ['--accounts', 'a.db', '--accounts', 'b.db', '--sessions', 's.db'],
    ]) {
      assert.equal(parseMigrateArgs(argv).ok, false, argv.join(' '));
    }
  });
});

describe('the command migrate-to-postgres, as a process (FRU-145)', () => {
  it(
    'copies, ends with 0, and never prints the address of the database',
    { skip: NO_REAL_POSTGRES, timeout: 30_000 },
    async () => {
      const files = await filesOfAWorker();
      closeAccountConnections();
      closeSessionConnections();
      const own = await ownDatabase();
      try {
        const env = { PATH: process.env.PATH, FRUITBACK_DATABASE_URL: own.url };
        const argv = [
          'src/main.ts',
          'migrate-to-postgres',
          '--accounts',
          files.accountsPath,
          '--sessions',
          files.sessionsPath,
        ];
        const cwd = fileURLToPath(new URL('..', import.meta.url));

        const dry = await run(process.execPath, [...argv, '--dry-run'], { cwd, env, timeout: 15_000 });
        assert.match(dry.stdout, /dry run: the counts are equal/);
        const real = await run(process.execPath, argv, { cwd, env, timeout: 15_000 });
        assert.match(real.stdout, /copied: the counts are equal/);
        const again = await run(process.execPath, argv, { cwd, env, timeout: 15_000 });
        assert.match(again.stdout, /already holds exactly these rows/);

        const password = decodeURIComponent(new URL(own.url).password);
        for (const output of [dry, real, again]) {
          assert.ok(!`${output.stdout}${output.stderr}`.includes(password));
        }

        const database = createPgDatabase(own.url, 'public', { max: 1 });
        assert.deepEqual(await counts(database), COPIED_COUNTS);
        await database.close();

        const missing = await run(
          process.execPath,
          [...argv.slice(0, 3), join(files.folder, 'nothing.db'), ...argv.slice(4)],
          {
            cwd,
            env,
            timeout: 15_000,
          },
        ).then(
          () => assert.fail('a missing file must end with 1'),
          (error: { code?: number; stderr?: string }) => error,
        );
        assert.equal(missing.code, 1);
        assert.match(missing.stderr ?? '', /no file at .*nothing\.db/);
        assert.ok(!existsSync(join(files.folder, 'nothing.db')));
      } finally {
        await own.drop();
      }
    },
  );
});
