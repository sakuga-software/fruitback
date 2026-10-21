import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { git } from './git.fixture.ts';

/**
 * The journal of the migrations (FRU-180). It reads files only: no database.
 *
 * **Why.** `migrate` of drizzle-orm 0.45 reads the date of the last migration that a database has,
 * and applies only the entries with a later date. An entry with an older date is never applied to
 * that database, and nothing says so. Continuous integration starts from an empty database, so it
 * applies every entry and sees nothing. Two pull requests that each add a migration make this case:
 * the one that merges second can hold the older date. `postgres-migrate.ts` refuses such a folder
 * when the worker starts. This test refuses it before the merge.
 *
 * The rules:
 *
 * 1. Entry `n` has the index `n`, and its name starts with the index in four digits.
 * 2. Each entry has its SQL file and its snapshot, and each SQL file has its entry.
 * 3. The dates only go up.
 * 4. Each snapshot names the one before it: a migration is generated from the migration before it.
 * 5. Against a base: the entries of the base are the first entries, with the same date, and their
 *    SQL files have not changed. A database can already have them.
 */

type Entry = { idx: number; when: number; tag: string };
type Journal = { entries: Entry[] };

/** The migrations of a commit: its journal, and the SQL file of one of its entries. */
type Base = { journal: Journal | undefined; sql(tag: string): string | undefined };

const WORKER = fileURLToPath(new URL('..', import.meta.url));
const FOLDER = join(WORKER, 'drizzle');
/** The folder, as git names it from the root of the repository. */
const FOLDER_IN_GIT = 'apps/worker/drizzle';
/** The `prevId` of a first snapshot, as `drizzle-kit` writes it. */
const NO_SNAPSHOT_BEFORE = '00000000-0000-0000-0000-000000000000';

const number = (index: number): string => String(index).padStart(4, '0');

function journalOf(folder: string): Journal {
  return JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** What is wrong with a folder of migrations, one sentence for each problem. */
function problemsOf(folder: string, base?: Base): string[] {
  const problems: string[] = [];
  const { entries } = journalOf(folder);
  let snapshotBefore = NO_SNAPSHOT_BEFORE;

  for (const [position, entry] of entries.entries()) {
    if (entry.idx !== position) problems.push(`« ${entry.tag} » is entry ${position} and has the index ${entry.idx}`);
    if (!entry.tag.startsWith(`${number(position)}_`)) {
      problems.push(`« ${entry.tag} » is entry ${position}: its name must start with « ${number(position)}_ »`);
    }
    if (!existsSync(join(folder, `${entry.tag}.sql`))) problems.push(`« ${entry.tag} » has no file ${entry.tag}.sql`);

    const before = entries[position - 1];
    if (before !== undefined && entry.when <= before.when) {
      problems.push(
        `« ${entry.tag} » has a date (${entry.when}) that is not after the date of « ${before.tag} » (${before.when}): ` +
          'a database that has the second one never gets the first one. Generate the migration again after a rebase',
      );
    }

    const snapshot = join(folder, 'meta', `${number(position)}_snapshot.json`);
    if (!existsSync(snapshot)) {
      problems.push(`« ${entry.tag} » has no snapshot meta/${number(position)}_snapshot.json`);
      continue;
    }
    const { id, prevId } = JSON.parse(readFileSync(snapshot, 'utf8')) as { id: string; prevId: string };
    if (prevId !== snapshotBefore) {
      problems.push(
        `the snapshot of « ${entry.tag} » does not name the snapshot before it: it was generated from another base`,
      );
    }
    snapshotBefore = id;
  }

  const tags = new Set(entries.map((entry) => entry.tag));
  for (const file of readdirSync(folder)) {
    if (file.endsWith('.sql') && !tags.has(file.slice(0, -'.sql'.length))) {
      problems.push(`${file} is not in the journal: no database gets it`);
    }
  }

  for (const [position, old] of (base?.journal?.entries ?? []).entries()) {
    const entry = entries[position];
    if (entry === undefined || entry.tag !== old.tag || entry.when !== old.when) {
      problems.push(
        `entry ${position} of the base is « ${old.tag} » (${old.when}), and it is not entry ${position} here: ` +
          'a new migration goes after the migrations of the base',
      );
      continue;
    }
    const file = join(folder, `${old.tag}.sql`);
    if (existsSync(file) && base?.sql(old.tag) !== readFileSync(file, 'utf8')) {
      problems.push(
        `${old.tag}.sql changed since the base: a database that has it does not run it again. Add a migration`,
      );
    }
  }

  return problems;
}

/** The migrations of a commit of this repository. A commit with no journal is from before the first migration. */
function baseAt(commit: string): Base {
  // Through git.fixture.ts: under a hook, `GIT_DIR` names the repository of the hook (FRU-172).
  // A commit that this clone does not have must fail here, and not read as « no migration yet ».
  git(WORKER, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
  const files = new Set(
    git(WORKER, 'ls-tree', '-r', '--name-only', commit, '--', FOLDER_IN_GIT)
      .split('\n')
      .filter((line) => line !== ''),
  );
  const show = (path: string): string | undefined =>
    files.has(`${FOLDER_IN_GIT}/${path}`) ? git(WORKER, 'show', `${commit}:${FOLDER_IN_GIT}/${path}`) : undefined;
  const journal = show('meta/_journal.json');

  return {
    journal: journal === undefined ? undefined : (JSON.parse(journal) as Journal),
    sql: (tag) => show(`${tag}.sql`),
  };
}

const copies: string[] = [];

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/** A copy of the folder of the worker, to break. */
function copyOfTheFolder(): string {
  const copy = mkdtempSync(join(tmpdir(), 'fruitback-journal-'));
  copies.push(copy);
  cpSync(FOLDER, copy, { recursive: true });

  return copy;
}

/** One more migration at the end of a folder, as `drizzle-kit generate` adds one. */
function add(folder: string, added: { name: string; when: number; sql?: string }): Entry {
  const journal = journalOf(folder);
  const position = journal.entries.length;
  const entry = {
    idx: position,
    version: '7',
    when: added.when,
    tag: `${number(position)}_${added.name}`,
    breakpoints: true,
  };
  const snapshotBefore = JSON.parse(
    readFileSync(join(folder, 'meta', `${number(position - 1)}_snapshot.json`), 'utf8'),
  ) as { id: string };

  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: [...journal.entries, entry] }),
  );
  writeFileSync(join(folder, `${entry.tag}.sql`), added.sql ?? `CREATE TABLE ${added.name} (id TEXT PRIMARY KEY);`);
  writeFileSync(
    join(folder, 'meta', `${number(position)}_snapshot.json`),
    JSON.stringify({ id: `snapshot-${position}`, prevId: snapshotBefore.id }),
  );

  return entry;
}

/** The folder as it is now, as a base: what a database may already have. It is read here, before a test breaks it. */
function asBase(folder: string): Base {
  const journal = journalOf(folder);
  const files = new Map(
    journal.entries.map((entry) => [entry.tag, readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')]),
  );

  return { journal, sql: (tag) => files.get(tag) };
}

describe('the journal of the migrations (FRU-180)', () => {
  const last = journalOf(FOLDER).entries.at(-1) as Entry;
  // Where the next migration goes, and the one after it: a test that adds one names it from here,
  // so the cases hold whatever number of migrations the worker has.
  const next = journalOf(FOLDER).entries.length;
  const [NEXT, AFTER, LAST] = [number(next), number(next + 1), number(next - 1)];

  it('is in order: an index, a name, a file and a snapshot for each entry, and dates that only go up', () => {
    assert.ok(journalOf(FOLDER).entries.length > 0, 'the journal has no entry, so nothing was checked');
    assert.deepEqual(problemsOf(FOLDER), []);
  });

  it('has the migrations of the base of this pull request first, and unchanged', (t) => {
    const commit = process.env.FRUITBACK_MIGRATIONS_BASE;
    if (commit === undefined || commit === '') {
      // The job `test` of CI sets it. `HEAD^1` there is the base of the pull request.
      t.skip('FRUITBACK_MIGRATIONS_BASE is not set: give it a commit, « origin/main » on a developer machine');

      return;
    }

    assert.deepEqual(problemsOf(FOLDER, baseAt(commit)), []);
  });

  it('refuses a base that this clone does not have, and does not read it as a base with no migration', () => {
    assert.throws(() => baseAt('0000000000000000000000000000000000000001'));
    // The control: a commit that is here is read, and it is the folder as it is committed or older.
    assert.doesNotThrow(() => baseAt('HEAD'));
  });

  describe('each rule fails on a folder that breaks it', () => {
    it('accepts a migration that is added after the others, with a later date', () => {
      const folder = copyOfTheFolder();
      const base = asBase(folder);
      add(folder, { name: 'more', when: last.when + 1 });

      assert.deepEqual(problemsOf(folder, base), []);
    });

    it('refuses a migration dated before the one before it: the one a rebase leaves behind', () => {
      const folder = copyOfTheFolder();
      add(folder, { name: 'merged_first', when: last.when + 2_000 });
      const late = add(folder, { name: 'rebased', when: last.when + 1_000 });

      const problems = problemsOf(folder);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0] ?? '', new RegExp(`« ${late.tag} » has a date .* that is not after the date of`));
    });

    it('refuses two migrations of one date', () => {
      const folder = copyOfTheFolder();
      add(folder, { name: 'same', when: last.when });

      assert.match(problemsOf(folder).join('\n'), /is not after the date of/);
    });

    it('refuses an entry whose index is not its place, and a name that does not start with it', () => {
      const folder = copyOfTheFolder();
      const journal = journalOf(folder);
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.map((entry) => ({ ...entry, idx: entry.idx + 1 })) }),
      );

      assert.match(problemsOf(folder).join('\n'), /is entry 0 and has the index 1/);

      const renamed = copyOfTheFolder();
      const added = add(renamed, { name: 'more', when: last.when + 1 });
      const entries = journalOf(renamed).entries.map((entry) =>
        entry.tag === added.tag ? { ...entry, tag: '9997_more' } : entry,
      );
      writeFileSync(join(renamed, 'meta', '_journal.json'), JSON.stringify({ entries }));

      assert.match(problemsOf(renamed).join('\n'), new RegExp(`its name must start with « ${NEXT}_ »`));
    });

    it('refuses an entry with no SQL file, and one with no snapshot', () => {
      const folder = copyOfTheFolder();
      const added = add(folder, { name: 'more', when: last.when + 1 });
      rmSync(join(folder, `${added.tag}.sql`));
      rmSync(join(folder, 'meta', `${NEXT}_snapshot.json`));

      const problems = problemsOf(folder).join('\n');
      assert.match(problems, new RegExp(`has no file ${NEXT}_more\\.sql`));
      assert.match(problems, new RegExp(`has no snapshot meta/${NEXT}_snapshot\\.json`));
    });

    it('refuses a SQL file that the journal does not name', () => {
      const folder = copyOfTheFolder();
      writeFileSync(join(folder, `${NEXT}_by_hand.sql`), 'CREATE TABLE by_hand (id TEXT PRIMARY KEY);');

      assert.deepEqual(problemsOf(folder), [`${NEXT}_by_hand.sql is not in the journal: no database gets it`]);
    });

    it('refuses a migration that was generated from another base than the one before it', () => {
      const folder = copyOfTheFolder();
      add(folder, { name: 'theirs', when: last.when + 1 });
      add(folder, { name: 'mine', when: last.when + 2 });
      // Two branches each generated a migration from the same snapshot, and the journal was merged by hand.
      const shared = JSON.parse(readFileSync(join(folder, 'meta', `${LAST}_snapshot.json`), 'utf8')) as { id: string };
      writeFileSync(join(folder, 'meta', `${AFTER}_snapshot.json`), JSON.stringify({ id: 'mine', prevId: shared.id }));

      assert.match(
        problemsOf(folder).join('\n'),
        new RegExp(`the snapshot of « ${AFTER}_mine » does not name the snapshot before it`),
      );
    });

    it('refuses a migration of the base that was edited', () => {
      const folder = copyOfTheFolder();
      const base = asBase(folder);
      const file = join(folder, `${last.tag}.sql`);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nALTER TABLE accounts ADD COLUMN more TEXT;`);

      assert.deepEqual(problemsOf(folder, base), [
        `${last.tag}.sql changed since the base: a database that has it does not run it again. Add a migration`,
      ]);
      // Without a base, nothing can know: that is why CI gives one.
      assert.deepEqual(problemsOf(folder), []);
    });

    it('refuses a migration that is put before one of the base, and one of the base whose date changed', () => {
      const folder = copyOfTheFolder();
      add(folder, { name: 'theirs', when: last.when + 2_000 });
      const base = asBase(folder);

      // The same folder, with another migration in the place of theirs.
      const mine = copyOfTheFolder();
      add(mine, { name: 'mine', when: last.when + 1_000 });
      add(mine, { name: 'theirs', when: last.when + 2_000 });
      assert.match(
        problemsOf(mine, base).join('\n'),
        new RegExp(`entry ${next} of the base is « ${NEXT}_theirs » .* it is not entry ${next} here`),
      );

      const dated = copyOfTheFolder();
      add(dated, { name: 'theirs', when: last.when + 3_000 });
      assert.match(problemsOf(dated, base).join('\n'), new RegExp(`entry ${next} of the base is « ${NEXT}_theirs »`));
    });
  });
});
