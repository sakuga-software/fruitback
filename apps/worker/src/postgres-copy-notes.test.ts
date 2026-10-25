import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Note, NOTE_STAGES, canonicalizePageUrl } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { IDENTITY_SECRET, envWith } from './auth-worker.fixture.ts';
import { parseMigrateArgs } from './cli.ts';
import type { ClientPolicy } from './clients.ts';
import { createMemoryKv } from './kv.ts';
import { type PgDatabase, createPgDatabase } from './postgres.ts';
import { NOTES_FILE_VERSION, copyNotesFile } from './postgres-copy.ts';
import { closeFrozenFiles, frozenFile, issuesOfFile, writeNote } from './postgres-copy.fixture.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, createRealDatabase, ownDatabase, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * The copy of the switch n° 1 bis (FRU-220): the notes of the SQLite file of a worker, into the
 * database of a worker of this image.
 *
 * The file is the frozen file of `postgres-copy.fixture.ts`, and its connection stays open while the
 * copy runs: the rows are in the `-wal`, as on a worker that was just stopped. A note is written as
 * the SQLite store wrote it. A stage that is not the first and a reply are written with a statement.
 */

const run = promisify(execFile);
const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};
const SITE = 'https://staging.acme.test';
const PAGES = ['/pricing', '/checkout'].map((path) => canonicalizePageUrl(`${SITE}${path}`));

const folders: string[] = [];

afterAll(() => {
  closeFrozenFiles();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function noteFixtureOf(id: string, page: string, client: string | undefined, note: string): Note {
  const made = noteFixture({ id, text: note, page: { url: page, path: new URL(page).pathname, title: 'A page' } });
  const { client: _own, ...rest } = made;

  return { ...rest, ...(client === undefined ? {} : { client: { id: client, name: client } }) };
}

/**
 * The file of a worker that has served: seven notes of two clients and of none, on two pages, at
 * each of the five stages, two of them answered, and one that was deleted since.
 */
async function fileOfAWorker() {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-copy-seeds-test-'));
  folders.push(folder);
  const notesPath = join(folder, 'fb.db');
  const store = frozenFile(notesPath, 'seeds');
  const notes: [string, string | undefined, string][] = [
    [PAGES[0] ?? '', 'acme', 'Le bouton « Commander » est trop petit'],
    [PAGES[0] ?? '', 'acme', 'Une note avec une apostrophe : l’été, et un emoji 🍓'],
    [PAGES[1] ?? '', 'acme', 'Le total ne tient pas sur une ligne'],
    [PAGES[0] ?? '', 'globex', 'La note d’un autre client, sur la même page'],
    [PAGES[0] ?? '', undefined, 'Une note qui ne nomme aucun client'],
    [PAGES[1] ?? '', 'acme', 'Une note que quelqu’un a fait supprimer'],
    [PAGES[1] ?? '', 'acme', 'La dernière'],
  ];
  for (const [index, [page, client, note]] of notes.entries()) {
    writeNote(store, noteFixtureOf(`sd_${index + 1}`, page, client, note));
  }
  // A second connection, as `sqlite3` beside a worker: the store keeps its own open.
  const file = new DatabaseSync(notesPath);
  for (const [index, stage] of NOTE_STAGES.entries()) {
    file
      .prepare('UPDATE seeds SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, `2026-09-0${index + 1}T08:00:00.000Z`, index + 1);
  }
  const reply = file.prepare('INSERT INTO comments (seed_id, author, body, created_at) VALUES (?, ?, ?, ?)');
  reply.run(1, 'Alice', 'Bien vu, on regarde ça.', '2026-09-02T09:00:00.000Z');
  reply.run(1, null, 'Corrigé en préprod.', '2026-09-03T09:00:00.123Z');
  reply.run(3, 'Bruno', 'Une réponse puis sa note supprimée ? Non : celle-ci reste.', '2026-09-04T09:00:00.000Z');
  reply.run(6, 'Bruno', 'Cette réponse part avec sa note.', '2026-09-05T09:00:00.000Z');
  file.exec('PRAGMA foreign_keys = ON');
  // The last note but one, and its reply: the numbers 6 and 4 were given, and must not be given again.
  file.prepare('DELETE FROM seeds WHERE id = 6').run();
  file.close();

  return { folder, notesPath };
}

type Read = (query: { url: string; clientId: string | undefined }) => Promise<unknown>;

/** What a reader of each page and each client gets. */
async function everyRead(read: Read, clients: readonly (string | undefined)[]) {
  const answers: Record<string, unknown> = {};
  for (const url of PAGES) {
    for (const clientId of clients) answers[`${url} ${clientId ?? '(none)'}`] = await read({ url, clientId });
  }

  return answers;
}

function fingerprint(folder: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(folder).sort()) {
    hash.update(name).update(readFileSync(join(folder, name)));
    hash.update(String(statSync(join(folder, name)).mtimeMs));
  }

  return hash.digest('hex');
}

const counts = async (database: PgDatabase) =>
  (
    await rowsOf(
      database,
      `SELECT (SELECT count(*)::int FROM notes) AS notes, (SELECT count(*)::int FROM note_comments) AS comments`,
    )
  )[0];

const NO_RENAME = new Map<string | null, string>();
const SUBJECTS: { label: string; open: () => Promise<PgDatabase>; skip: string | false }[] = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: () => createRealDatabase(), skip: NO_REAL_POSTGRES },
  // FRU-219: the notes go to the schema of the worker, and their numbers go on there.
  {
    label: 'a real server, in a schema of its own',
    open: () => createRealDatabase('fruitback_notes'),
    skip: NO_REAL_POSTGRES,
  },
];

for (const subject of SUBJECTS) {
  describe(
    `the copy of the notes of a SQLite file, on ${subject.label} (FRU-220)`,
    { skip: subject.skip !== false },
    () => {
      let database: PgDatabase | undefined;

      afterEach(async () => {
        await database?.close();
        database = undefined;
      });

      it('gives each reader the notes the file gave, byte for byte, with their numbers, stages and replies', async () => {
        const { notesPath } = await fileOfAWorker();
        assert.ok(existsSync(`${notesPath}-wal`), 'the rows are not in a journal: this case would prove less');
        database = await subject.open();
        const clients = ['acme', 'globex', undefined];
        const before = await everyRead(async (query) => issuesOfFile(notesPath, query, POLICY), clients);

        const outcome = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });

        assert.equal(outcome.ok, true, outcome.lines.join('\n'));
        assert.match(outcome.lines.join('\n'), /notes\s+6\s+6\s+same/);
        assert.match(outcome.lines.join('\n'), /note_comments\s+3\s+3\s+same/);
        const store = createPostgresNoteStore(database);
        const after = await everyRead((query) => store.findForPage(query, undefined, POLICY), clients);
        // The SQLite store gives a reader that names no client every note of the page, and the store of
        // the database gives it the notes that name none (FRU-218): that read is compared apart.
        for (const key of Object.keys(before).filter((key) => !key.endsWith('(none)'))) {
          assert.deepEqual(after[key], before[key], key);
        }
        assert.deepEqual(
          (after[`${PAGES[0]} (none)`] as { identifier: string }[]).map((issue) => issue.identifier),
          ['FB-5'],
        );
        // The five stages came through, and the text of a note is the text of the file.
        assert.deepEqual(
          (await rowsOf(database, 'SELECT stage FROM notes ORDER BY id')).map((row) => row.stage),
          [...NOTE_STAGES, 'new'],
        );
        const file = new DatabaseSync(notesPath, { readOnly: true });
        const texts = file.prepare('SELECT id, seed AS note FROM seeds ORDER BY id').all() as {
          id: number;
          note: string;
        }[];
        file.close();
        assert.deepEqual(
          (await rowsOf(database, 'SELECT id, payload FROM notes ORDER BY id')).map((row) => ({
            id: Number(row.id),
            note: row.payload,
          })),
          texts.map((row) => ({ id: row.id, note: row.note })),
        );
      });

      it('goes on after the largest number the file ever gave, a deleted note included', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();

        const outcome = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });

        assert.match(outcome.lines.at(-1) ?? '', /^copied: the counts are equal\. The next note is FB-8\./);
        const store = createPostgresNoteStore(database);
        const next = await store.create(
          noteFixtureOf('sd_new', PAGES[0] ?? '', 'acme', 'Une note d’après'),
          undefined,
          POLICY,
        );
        // FB-6 was a note that somebody had deleted: nobody gets its number.
        assert.deepEqual(next, { id: '8', identifier: 'FB-8' });
        // And a reply: 4 was given to the reply that went with FB-6.
        await rowsOf(database, `INSERT INTO note_comments (note_id, body, created_at) VALUES (8, 'Vu.', 1)`);
        assert.deepEqual(await rowsOf(database, 'SELECT max(id)::int AS last FROM note_comments'), [{ last: 5 }]);
      });

      it('serves the copied notes through GET /feedback of a worker with a database, to the site that --client names', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();
        await migrate(database);
        // The operator made the site in the console first: its id is the one of the database.
        const accounts = createPostgresAccountStore(database);
        const owner = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
        const workspace = await accounts.createWorkspace('Acme', owner.id);
        const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });

        const outcome = await copyNotesFile({
          notesPath,
          clients: new Map<string | null, string>([
            ['acme', site.id],
            [null, site.id],
          ]),
          database,
          dryRun: false,
        });

        assert.equal(outcome.ok, true, outcome.lines.join('\n'));
        const said = outcome.lines.join('\n');
        assert.match(said, new RegExp(`4 note\\(s\\) of « acme » go to « ${site.id} »$`, 'm'));
        assert.match(said, new RegExp(`1 note\\(s\\) of no client go to « ${site.id} »$`, 'm'));
        // The notes of the other client keep its name, which is no site here: said, and copied.
        assert.match(said, /1 note\(s\) of « globex » go to « globex »: NOT A SITE of this database/);

        const read = async (page: string) =>
          (await (
            await handleRequest(
              new Request(`https://api.acme.test/feedback?url=${encodeURIComponent(page)}&client=${site.id}`, {
                headers: { Origin: SITE },
              }),
              envWith({ ALLOWED_ORIGINS: SITE }),
              {
                clientIp: '198.51.100.9',
                accounts,
                sessionStore: createPostgresSessionStore(database as PgDatabase),
                kv: createMemoryKv(),
                store: createPostgresNoteStore(database as PgDatabase),
              },
            )
          ).json()) as { issues: { identifier: string; stage: string; note: { text: string } }[] };
        assert.deepEqual((await read(PAGES[0] ?? '')).issues.map((issue) => [issue.identifier, issue.stage]).sort(), [
          ['FB-1', 'new'],
          ['FB-2', 'todo'],
          ['FB-5', 'closed'],
        ]);
        assert.deepEqual((await read(PAGES[1] ?? '')).issues.map((issue) => issue.identifier).sort(), ['FB-3', 'FB-7']);
      });

      it('writes nothing beside the file, and leaves it as it was', async () => {
        const { folder, notesPath } = await fileOfAWorker();
        database = await subject.open();
        const before = fingerprint(folder);

        assert.equal((await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false })).ok, true);

        assert.equal(fingerprint(folder), before);
      });

      it('keeps nothing on a dry run, not even a number, and says what the next one would be', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();

        const outcome = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: true });

        assert.equal(outcome.ok, true, outcome.lines.join('\n'));
        assert.match(
          outcome.lines.at(-1) ?? '',
          /^dry run: the counts are equal, and nothing was kept\. The next note would be FB-8\./,
        );
        assert.deepEqual(await counts(database), { notes: 0, comments: 0 });
        const first = await createPostgresNoteStore(database).create(
          noteFixtureOf('sd_first', PAGES[0] ?? '', 'acme', 'La première note de cette base'),
          undefined,
          POLICY,
        );
        assert.equal(first.identifier, 'FB-1');
      });

      it('writes nothing again when it runs a second time, and refuses once a note was planted since', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();
        assert.equal((await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false })).ok, true);

        const again = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });
        assert.equal(again.ok, true);
        assert.match(again.lines[0] ?? '', /already holds exactly these notes: nothing is written/);
        assert.deepEqual(await counts(database), { notes: 6, comments: 3 });

        await createPostgresNoteStore(database).create(
          noteFixtureOf('sd_since', PAGES[0] ?? '', 'acme', 'Depuis'),
          undefined,
          POLICY,
        );
        const late = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });
        assert.equal(late.ok, false);
        assert.match(
          late.lines.at(-1) ?? '',
          /^refused: PostgreSQL already holds notes, and they are not the ones of the file/,
        );
        assert.deepEqual(await counts(database), { notes: 7, comments: 3 });
      });

      it('holds the same rows under another name of site as other rows: a second run with another --client is refused', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();
        assert.equal((await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false })).ok, true);

        const renamed = await copyNotesFile({
          notesPath,
          clients: new Map<string | null, string>([['acme', 'site_other']]),
          database,
          dryRun: false,
        });

        assert.equal(renamed.ok, false);
        assert.deepEqual(
          await rowsOf(database, `SELECT count(*)::int AS n FROM notes WHERE client_id = 'site_other'`),
          [{ n: 0 }],
        );
      });

      it('leaves nothing when it stops in the middle, and gives the same result when it runs again', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();
        await migrate(database);
        await rowsOf(
          database,
          `CREATE FUNCTION stop_the_copy() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN RAISE EXCEPTION 'the copy stops here'; END $$`,
        );
        await rowsOf(
          database,
          'CREATE TRIGGER stop_the_copy BEFORE INSERT ON note_comments EXECUTE FUNCTION stop_the_copy()',
        );

        await assert.rejects(
          copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false }),
          /the copy stops here/,
        );
        assert.deepEqual(await counts(database), { notes: 0, comments: 0 });

        await rowsOf(database, 'DROP TRIGGER stop_the_copy ON note_comments');
        const again = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });
        assert.equal(again.ok, true, again.lines.join('\n'));
        assert.deepEqual(await counts(database), { notes: 6, comments: 3 });
      });

      it('fails its final count when a note goes missing in the target, and keeps nothing', async () => {
        const { notesPath } = await fileOfAWorker();
        database = await subject.open();
        await migrate(database);
        // The violation: one note disappears as soon as the notes are written.
        await rowsOf(
          database,
          `CREATE FUNCTION lose_a_note() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN DELETE FROM notes WHERE id = (SELECT max(id) FROM notes); RETURN NULL; END $$`,
        );
        await rowsOf(
          database,
          'CREATE TRIGGER lose_a_note AFTER INSERT ON notes FOR EACH STATEMENT EXECUTE FUNCTION lose_a_note()',
        );

        const outcome = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });

        assert.equal(outcome.ok, false);
        assert.match(outcome.lines.join('\n'), /notes\s+6\s+5\s+DIFFERENT/);
        assert.match(outcome.lines.at(-1) ?? '', /^refused: a table of PostgreSQL differs from the file/);
        assert.deepEqual(await counts(database), { notes: 0, comments: 0 });
      });

      it('refuses a file of another version, a column it does not know, a date it cannot keep, a note of before 0.4.0, and a client the file does not name', async () => {
        const cases: [string, (file: DatabaseSync) => void, Map<string | null, string>, RegExp][] = [
          [
            'another version',
            (file) => file.exec(`PRAGMA user_version = ${NOTES_FILE_VERSION + 1}`),
            NO_RENAME,
            /the seeds file is at version 2, and this worker reads version 1/,
          ],
          [
            'a column',
            (file) => file.exec('ALTER TABLE seeds ADD COLUMN assignee TEXT'),
            NO_RENAME,
            /the table seeds differs: assignee is not in PostgreSQL/,
          ],
          [
            'a date',
            (file) => file.exec(`UPDATE seeds SET updated_at = '2026-09-01 08:00:00' WHERE id = 2`),
            NO_RENAME,
            /the row 2 of seeds holds a date that the database would not give back as it is written/,
          ],
          [
            // FRU-449: no worker after 0.4.0 reads the kind of before, and rewrite-notes is gone.
            'a note of before 0.4.0',
            (file) =>
              file.exec(
                `UPDATE seeds SET seed = json_set(seed, '$.kind', 'fruitback.seed', '$.v', 2) WHERE id IN (2, 3)`,
              ),
            NO_RENAME,
            /2 note\(s\) of the file \(row 2, 3\) are not a note that this worker reads, the kind of before 0\.4\.0: copy this file with the worker 0\.4\.0, and run rewrite-notes there/,
          ],
          [
            'a client',
            () => {},
            new Map<string | null, string>([['acmee', 'site_1']]),
            /no note of the file names « acmee »: the file names « acme », « globex », no client/,
          ],
        ];
        for (const [label, change, clients, said] of cases) {
          const { notesPath } = await fileOfAWorker();
          closeFrozenFiles();
          const file = new DatabaseSync(notesPath);
          change(file);
          file.close();
          database = await subject.open();

          const outcome = await copyNotesFile({ notesPath, clients, database, dryRun: false });

          assert.equal(outcome.ok, false, label);
          assert.match(outcome.lines.at(-1) ?? '', said, label);
          assert.match(outcome.lines.at(-1) ?? '', /Nothing was written\.$/, label);
          await database.close();
          database = undefined;
        }
      });

      it('copies a file that holds no note, and the first note is FB-1', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'fruitback-copy-seeds-test-'));
        folders.push(folder);
        const notesPath = join(folder, 'fb.db');
        frozenFile(notesPath, 'seeds');
        assert.deepEqual(issuesOfFile(notesPath, { url: PAGES[0] ?? '', clientId: undefined }, POLICY), []);
        database = await subject.open();

        const outcome = await copyNotesFile({ notesPath, clients: NO_RENAME, database, dryRun: false });

        assert.equal(outcome.ok, true, outcome.lines.join('\n'));
        const first = await createPostgresNoteStore(database).create(
          noteFixtureOf('sd_first', PAGES[0] ?? '', 'acme', 'La première'),
          undefined,
          POLICY,
        );
        assert.equal(first.identifier, 'FB-1');
      });
    },
  );
}

/**
 * Why `--sessions` alone is not offered for a worker that had no accounts (FRU-220). The ticket asks
 * for it only if a session of before can be given to a member. This is the measure: such a session
 * names a person the operator typed, and a workspace of `FRUITBACK_CLIENTS` or none. On a worker
 * with a database, a site for members is read by a session of its workspace, held by a member.
 */
describe('a session of a worker that had no accounts, on a worker with a database (FRU-220)', () => {
  it('reads no site for members, whatever workspace it names: each reviewer pairs again, once', async () => {
    const database = await createPgliteDatabase();
    try {
      await migrate(database);
      const accounts = createPostgresAccountStore(database);
      const sessions = createPostgresSessionStore(database);
      const owner = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const workspace = await accounts.createWorkspace('Acme', owner.id);
      const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'members' });
      const env = envWith({ ALLOWED_ORIGINS: SITE });
      const read = async (identity: { subject: string; workspace?: string }): Promise<number> => {
        const redeemed = await redeemPairing(
          sessions,
          (await createPairing(sessions, { ...identity, name: 'A reviewer' })).code,
          IDENTITY_SECRET,
        );
        assert.ok(redeemed.ok);
        const answer = await handleRequest(
          new Request(`https://api.acme.test/feedback?url=${encodeURIComponent(PAGES[0] ?? '')}&client=${site.id}`, {
            headers: { Origin: SITE, Authorization: `Bearer ${redeemed.session.accessToken}` },
          }),
          env,
          { clientIp: '198.51.100.9', accounts, sessionStore: sessions, kv: createMemoryKv() },
        );

        if (identity.workspace !== workspace.id || identity.subject === owner.id) return answer.status;
        // A session whose workspace was rewritten to the one of the site reads until its access
        // token ends (FRU-149 says why), and its first refresh ends it: the person is no member.
        const refreshed = await handleRequest(
          new Request('https://api.acme.test/session/refresh', {
            method: 'POST',
            headers: { Origin: SITE, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: redeemed.session.refreshToken }),
          }),
          env,
          { clientIp: '198.51.100.9', accounts, sessionStore: sessions, kv: createMemoryKv() },
        );

        return refreshed.status;
      };

      assert.deepEqual(
        {
          // As the files of before hold them: the name the operator gave, and no workspace, or its own.
          noWorkspace: await read({ subject: 'e2e-reviewer' }),
          workspaceOfBefore: await read({ subject: 'e2e-reviewer', workspace: 'acme' }),
          // What a copy that rewrote the workspace would give: a person who is no member of it.
          rewrittenThenRefreshed: await read({ subject: 'e2e-reviewer', workspace: workspace.id }),
          // The control: the session of a member, as the console and `pair` make one today.
          member: await read({ subject: owner.id, workspace: workspace.id }),
        },
        { noWorkspace: 401, workspaceOfBefore: 401, rewrittenThenRefreshed: 401, member: 200 },
      );
    } finally {
      await database.close();
    }
  });
});

describe('the arguments of migrate-to-postgres, for the notes (FRU-220)', () => {
  it('takes the file, each --client, --no-client, and --dry-run', () => {
    assert.deepEqual(
      parseMigrateArgs([
        '--notes',
        'fb.db',
        '--client',
        'acme=site_1',
        '--client',
        'a=b=c',
        '--no-client',
        'site_2',
        '--dry-run',
      ]),
      {
        ok: true,
        args: {
          copy: 'notes',
          notesPath: 'fb.db',
          clients: new Map<string | null, string>([
            ['acme', 'site_1'],
            ['a', 'b=c'],
            [null, 'site_2'],
          ]),
          dryRun: true,
        },
      },
    );
    assert.deepEqual(parseMigrateArgs(['--notes', 'fb.db']), {
      ok: true,
      args: { copy: 'notes', notesPath: 'fb.db', clients: new Map(), dryRun: false },
    });
  });

  it('refuses the notes in the run of the accounts, a --client with no site, twice the same one, and a --client with no notes', () => {
    for (const argv of [
      ['--notes', 'fb.db', '--accounts', 'a.db', '--sessions', 's.db'],
      ['--notes', 'fb.db', '--sessions', 's.db'],
      ['--notes', 'fb.db', '--client', 'acme'],
      ['--notes', 'fb.db', '--client', 'acme='],
      ['--notes', 'fb.db', '--client', '=site_1'],
      ['--notes', 'fb.db', '--client', '--dry-run'],
      ['--notes', 'fb.db', '--client', 'acme=site_1', '--client', 'acme=site_2'],
      ['--notes', 'fb.db', '--no-client', 'site_1', '--no-client', 'site_2'],
      ['--notes', 'fb.db', '--no-client'],
      ['--notes', '--dry-run'],
      ['--notes', 'fb.db', '--notes', 'other.db'],
      ['--notes', 'fb.db', '--dryrun'],
      ['--accounts', 'a.db', '--sessions', 's.db', '--client', 'acme=site_1'],
      ['--client', 'acme=site_1'],
    ]) {
      assert.equal(parseMigrateArgs(argv).ok, false, argv.join(' '));
    }
  });

  it('takes one file, and refuses --notes given twice', () => {
    assert.equal(parseMigrateArgs(['--notes', 'fb.db', '--notes', 'fb.db']).ok, false);
    const empty = parseMigrateArgs(['--notes', '--dry-run']);
    assert.match(empty.ok ? '' : empty.error, /--notes needs a file$/);
  });

  it('says --notes in its usage', () => {
    const refused = parseMigrateArgs([]);

    assert.match(refused.ok ? '' : refused.error, /migrate-to-postgres --notes <file>/);
  });
});

describe('the command migrate-to-postgres --notes, as a process (FRU-220)', () => {
  it(
    'tries, copies, ends with 0, never prints the address of the database, and ends with 1 on a refusal',
    { skip: NO_REAL_POSTGRES !== false, timeout: 60_000 },
    async () => {
      const { folder, notesPath } = await fileOfAWorker();
      closeFrozenFiles();
      const own = await ownDatabase();
      try {
        const env = { PATH: process.env.PATH, FRUITBACK_DATABASE_URL: own.url };
        const argv = ['src/main.ts', 'migrate-to-postgres', '--notes', notesPath, '--client', 'acme=site_1'];
        const cwd = fileURLToPath(new URL('..', import.meta.url));

        const dry = await run(process.execPath, [...argv, '--dry-run'], { cwd, env, timeout: 15_000 });
        assert.match(dry.stdout, /dry run: the counts are equal/);
        const real = await run(process.execPath, argv, { cwd, env, timeout: 15_000 });
        assert.match(real.stdout, /copied: the counts are equal\. The next note is FB-8\./);
        const again = await run(process.execPath, argv, { cwd, env, timeout: 15_000 });
        assert.match(again.stdout, /already holds exactly these notes/);

        const password = decodeURIComponent(new URL(own.url).password);
        for (const output of [dry, real, again]) {
          assert.ok(!`${output.stdout}${output.stderr}`.includes(password));
        }
        const database = createPgDatabase(own.url, 'public', { max: 1 });
        assert.deepEqual(await counts(database), { notes: 6, comments: 3 });
        assert.deepEqual(await rowsOf(database, `SELECT count(*)::int AS n FROM notes WHERE client_id = 'site_1'`), [
          { n: 4 },
        ]);
        await database.close();

        for (const [refused, said] of [
          [[...argv.slice(0, 3), join(folder, 'nothing.db')], /no file at .*nothing\.db/],
          [[...argv.slice(0, 4), '--client', 'acme=site_2'], /refused: PostgreSQL already holds notes/],
        ] as const) {
          const outcome = await run(process.execPath, [...refused], { cwd, env, timeout: 15_000 }).then(
            () => assert.fail('a refusal must end with 1'),
            (error: { code?: number; stderr?: string }) => error,
          );
          assert.equal(outcome.code, 1);
          assert.match(outcome.stderr ?? '', said);
        }
      } finally {
        await own.drop();
      }
    },
  );
});
