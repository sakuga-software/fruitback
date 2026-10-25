import { appendFileSync, existsSync } from 'node:fs';
import { workspacesOf } from './clients.ts';
import { DATABASE_SCHEMA_REFUSED, type WorkerEnv, readConfig } from './env.ts';
import { PAIRING_TTL_SECONDS, type SessionStore } from './session.ts';
import type { AccountStore } from './accounts.ts';
import { accountStoreFor, adminLinksFor, createPairingCommand, noteIndexFor } from './app.ts';
import { type AdminLinkOutcome, type AdminLinks, adminLinkFor } from './first-admin.ts';
import type { IndexedNote, NoteIndex } from './notes-index.ts';
import { CACHE_TTL_MS } from './cache.ts';
import { pairingLink } from './pair-page.ts';
import { createPgDatabase, readDatabaseSchema, readDatabaseUrl } from './postgres.ts';
import { copyNotesFile, copySqliteFiles } from './postgres-stores.ts';
import type { ForgetSelector, ForgottenNote, NoteStore } from './store.ts';

/**
 * Minting a pairing code, as a command rather than a route (FRU-42).
 *
 * Vouching for a person is the one privileged operation this worker has. Behind an endpoint it
 * would need an admin credential of its own — a second secret to distribute, rotate and get wrong —
 * and it would be reachable from the internet for ever after. As a command it is reachable by
 * whoever can already run things in the container, which is the same person who set the secrets.
 *
 * `docker exec <container> node server.mjs pair --subject alice --name "Alice Martin"`
 *
 * `server.mjs` and not `src/main.ts`: the image copies the bundle and nothing else, so the source
 * path is a command an operator cannot run. Raised in review, and checked against a real build.
 */

export type PairArgs = { subject: string; name?: string; email?: string; endpoint?: string; workspace?: string };

export type PairArgsResult = { ok: true; args: PairArgs } | { ok: false; error: string };

const USAGE =
  'usage: pair --subject <id> [--workspace <id>] [--name "<full name>"] [--email <address>] [--endpoint <worker URL>]';

const KNOWN_FLAGS = new Set(['subject', 'workspace', 'name', 'email', 'endpoint']);

/**
 * `--flag value` only.
 *
 * `--flag=value` is not accepted, and saying so is better than half-supporting it: a name with a
 * space in it is the common case here, and `--name=Alice Martin` is the spelling that silently
 * drops the surname.
 */
export function parsePairArgs(argv: readonly string[]): PairArgsResult {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === undefined || !flag.startsWith('--')) return { ok: false, error: `${USAGE}\nunexpected: ${flag}` };
    if (value === undefined) return { ok: false, error: `${USAGE}\n${flag} needs a value` };

    values.set(flag.slice(2), value);
  }

  // An unknown flag is refused rather than ignored. `--emali alice@acme.dev` would otherwise mint a
  // code whose session carries no address, and the operator would believe it did. Raised in review.
  const unknown = [...values.keys()].filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) return { ok: false, error: `${USAGE}\nunknown: --${unknown.join(', --')}` };

  const subject = values.get('subject');
  if (subject === undefined || subject.trim() === '') return { ok: false, error: `${USAGE}\n--subject is required` };

  const name = values.get('name')?.trim();
  const email = values.get('email')?.trim();
  const workspace = values.get('workspace')?.trim();

  // The address the reviewer reaches this worker at. The container does not know it, so the
  // operator gives it, and the command then prints a link instead of a code to copy (FRU-92).
  const endpoint = publicEndpoint(values.get('endpoint'));
  if (endpoint === null) {
    return {
      ok: false,
      error: `${USAGE}\n--endpoint must be an https:// URL, or http:// on localhost: a pairing code must not cross plain http`,
    };
  }

  return {
    ok: true,
    args: {
      // The stable id for this person, and what lands in `reporter.id` on every note they file.
      subject: subject.trim(),
      ...(name === undefined || name === '' ? {} : { name }),
      ...(email === undefined || email === '' ? {} : { email }),
      ...(workspace === undefined || workspace === '' ? {} : { workspace }),
      ...(endpoint === undefined ? {} : { endpoint }),
    },
  };
}

/**
 * The hosts where plain http is not on a wire. `new URL` keeps the brackets on an IPv6 host.
 *
 * The extension pairs on the same hosts and no other (`isSecureWorkerEndpoint`). A test compares the
 * two lists: a link printed for a host the extension refuses is a link that pairs nothing.
 */
export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The worker's public address with no query, no fragment and no slash at the end, or `undefined`
 * when none was given, or `null` when the value cannot carry a pairing code.
 *
 * A path is kept: a worker behind `https://example.com/fruitback` is an ordinary deployment.
 */
function publicEndpoint(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value.trim());
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname));
    if (!secure || url.username !== '' || url.password !== '') return null;

    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Why this workspace cannot carry a session on this worker, or nothing when it can (FRU-95).
 *
 * On a worker with workspaces, a session must name one: a session with none reaches no client. On a
 * worker with none, a workspace is a word that nothing reads, and the operator would believe it did.
 *
 * With a database, `declared` is the workspaces that have a site (FRU-277). Every site belongs to a
 * workspace there, so a session with no workspace reads nothing, even before the first site.
 */
export function checkWorkspace(
  workspace: string | undefined,
  declared: readonly string[],
  database = false,
): string | undefined {
  if (database && declared.length === 0) {
    return 'no workspace of this worker has a site yet: add a site in the console, then pair for its workspace';
  }
  if (declared.length === 0) {
    return workspace === undefined ? undefined : '--workspace needs FRUITBACK_CLIENTS with a client that declares it';
  }
  if (workspace === undefined) return `--workspace is required: one of ${declared.join(', ')}`;
  if (!declared.includes(workspace))
    return `${database ? 'no site belongs to' : 'no client declares'} the workspace ${workspace}: one of ${declared.join(', ')}`;

  return undefined;
}

export type PairOutcome = { ok: true; lines: string[] } | { ok: false; lines: string[] };

/**
 * Reads the same configuration the server reads, so a container that cannot serve cannot mint
 * either — and says which variable is missing rather than failing on the database.
 */
export async function runPair(
  argv: readonly string[],
  env: WorkerEnv,
  /** The store a test opened. Absent, the one of the environment. */
  held?: SessionStore,
  /** The accounts a test opened. Absent, the ones of the environment. */
  heldAccounts?: AccountStore,
): Promise<PairOutcome> {
  const parsed = parsePairArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };

  // With a database, the workspaces are in it, and FRUITBACK_CLIENTS is refused (FRU-225, FRU-277).
  const accounts = heldAccounts ?? accountStoreFor(config.config);
  let declared: string[];
  try {
    declared = workspacesOf(accounts === undefined ? config.config.clients : await accounts.clientMap());
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }

  const workspaceProblem = checkWorkspace(parsed.args.workspace, declared, accounts !== undefined);
  if (workspaceProblem !== undefined) return { ok: false, lines: [`${USAGE}\n${workspaceProblem}`] };

  // The route ends a session whose person is not a member of its workspace (FRU-149). A code for
  // somebody else is refused here, before it is printed: printed, it reads as a code that works.
  if (accounts !== undefined && parsed.args.workspace !== undefined) {
    // A suspended account has no role (FRU-281): the operator reads why, and gets no code.
    if ((await accounts.account(parsed.args.subject))?.suspended === true) {
      return { ok: false, lines: [`The account ${parsed.args.subject} is suspended: it gets no pairing code`] };
    }
    const role = await accounts.role(parsed.args.workspace, parsed.args.subject);
    if (role === undefined) {
      return {
        ok: false,
        lines: [
          `${USAGE}\n--subject must be the id of an account that is a member of the workspace ${parsed.args.workspace}`,
        ],
      };
    }
  }

  let minted: { code: string; expiresAt: number };
  try {
    minted = await createPairingCommand(config.config, parsed.args, held);
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }

  const who = [parsed.args.name, parsed.args.email].filter((part) => part !== undefined).join(' ');

  const link =
    parsed.args.endpoint === undefined
      ? ['To get a link the reviewer only has to open, add --endpoint <the address of this worker>.', '']
      : [
          'Or send this link. The reviewer opens it, then clicks the Fruitback icon:',
          '',
          `    ${pairingLink(parsed.args.endpoint, minted.code)}`,
          '',
        ];

  const where = parsed.args.workspace === undefined ? '' : ` in the workspace ${parsed.args.workspace}`;

  return {
    ok: true,
    lines: [
      `pairing code for ${parsed.args.subject}${who === '' ? '' : ` (${who})`}${where}:`,
      '',
      `    ${minted.code}`,
      '',
      ...link,
      // Said out loud because the store keeps only a digest: there is no command that reads it back.
      `Valid for ${Math.round(PAIRING_TTL_SECONDS / 60)} minutes, and usable once.`,
      'It is not stored and cannot be shown again — mint another if it is lost.',
    ],
  };
}

/**
 * Deleting notes, as a command for the same reason as `pair` (FRU-85, FRU-111).
 *
 * `docker exec <container> node server.mjs forget --email alice@acme.dev --dry-run`
 * `docker exec <container> node server.mjs forget --name "Alice" --dry-run`
 * `docker exec <container> node server.mjs forget --id FB-12 --id FB-13`
 * `docker exec <container> node server.mjs forget --note sd_2f8c1a90 --dry-run`
 *
 * `--note` is for a note that went to a tracker (FRU-237): the worker does not hold it, and cannot
 * find it by an address or a name. Its issue holds the note, and the note its `id`. The command then
 * removes what the worker holds of it, its row in the index of the notes with its excerpt, whatever
 * the store; the issue itself is deleted in the tracker.
 *
 * It always lists what it found before it says what it did. A typed address is a claim: a reporter
 * can type somebody else's, and two reporters can type the same one. A typed name is a weaker claim,
 * so `--name` only lists. Run it with `--dry-run` first, read the list, and delete by `--id`.
 */

export type ForgetArgs = { which: ForgetSelector | { ids: readonly string[] }; dryRun: boolean };

export type ForgetArgsResult = { ok: true; args: ForgetArgs } | { ok: false; error: string };

const FORGET_USAGE =
  'usage: forget (--email <address> | --name <name> --dry-run | --id <FB-n> [--id <FB-n> ...] | --note <id> [--note <id> ...]) [--dry-run]';

const VALUE_FLAGS = ['--email', '--name', '--id', '--note'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** A note excerpt long enough to recognise it, short enough to keep one note on one line. */
const NOTE_EXCERPT_LENGTH = 60;

export function parseForgetArgs(argv: readonly string[]): ForgetArgsResult {
  const refuse = (reason: string): ForgetArgsResult => ({ ok: false, error: `${FORGET_USAGE}\n${reason}` });
  const given: Record<ValueFlag, string[]> = { '--email': [], '--name': [], '--id': [], '--note': [] };
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--dry-run') {
      dryRun = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      const value = argv[index + 1];
      // `--email --dry-run` would otherwise read the flag as the address and run a real deletion.
      if (value === undefined || value.startsWith('--') || value.trim() === '') return refuse(`${flag} needs a value`);
      given[flag as ValueFlag].push(value.trim());
      index += 1;
    } else {
      // Refused rather than ignored: `--dryrun` must not delete what `--dry-run` would only list.
      return refuse(`unexpected: ${flag}`);
    }
  }

  const kinds = VALUE_FLAGS.filter((flag) => given[flag].length > 0);
  if (kinds.length === 0) return refuse('one of --email, --name, --id and --note is required');
  // Two selectors in one command have two readings, all of them or any of them. Neither is asked for.
  if (kinds.length > 1) return refuse(`use one of ${kinds.join(' and ')}, not both`);

  const [kind] = kinds;
  if (kind === '--note') return { ok: true, args: { which: { ids: [...new Set(given['--note'])] }, dryRun } };
  if (kind === '--id') {
    const malformed = given['--id'].filter((identifier) => !/^FB-[1-9]\d*$/.test(identifier));
    if (malformed.length > 0) return refuse(`not an identifier of this store: ${malformed.join(', ')}`);

    return { ok: true, args: { which: { identifiers: [...new Set(given['--id'])] }, dryRun } };
  }

  const values = given[kind as '--email' | '--name'];
  if (values.length > 1) return refuse(`${kind} takes one value`);
  const [value = ''] = values;

  if (kind === '--name') {
    // A name is not an identity: two reporters sign with the same one. It finds notes, and no more.
    if (!dryRun) return refuse('--name only lists. Add --dry-run, read the list, then delete with --id');

    return { ok: true, args: { which: { name: value }, dryRun } };
  }

  return { ok: true, args: { which: { email: value }, dryRun } };
}

export type ForgetOutcome = { ok: boolean; lines: string[] };

/** The selector in the words of the three sentences that name it. */
function describe(which: ForgetSelector): { that: string; none: string; search: string } {
  if ('identifiers' in which) {
    const listed = which.identifiers.join(', ');

    return { that: `are ${listed}`, none: `no note is ${listed}.`, search: listed };
  }
  if ('name' in which) {
    return { that: `are signed ${which.name}`, none: `no note is signed ${which.name}.`, search: which.name };
  }

  return {
    that: `give ${which.email}`,
    none: `no note gives ${which.email} as its reporter's address.`,
    search: which.email,
  };
}

export async function runForget(
  argv: readonly string[],
  env: WorkerEnv,
  /** The store a test opened. Absent, the one of the environment. */
  held?: NoteStore,
  /**
   * The index a test opened (FRU-237). Absent, the one of the environment when the store is the one
   * of the environment too: a test that hands a store hands its index, or none.
   */
  heldIndex?: NoteIndex,
  /**
   * The accounts a test opened (FRU-450). Absent, the ones of the environment when the store is the one
   * of the environment too. An address of an account forgets the notes of every address of it.
   */
  heldAccounts?: Pick<AccountStore, 'ownerOfAddress' | 'account' | 'addresses'>,
): Promise<ForgetOutcome> {
  const parsed = parseForgetArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };

  const { which, dryRun } = parsed.args;
  // The index of the environment when the store is the one of the environment too: a test that
  // hands a store hands its index, or none.
  const index = heldIndex ?? (held === undefined ? noteIndexFor(config.config) : undefined);
  if ('ids' in which) return forgetNotes(which.ids, dryRun, index);

  // FRU-450: the address of an account names every address of it, its primary one and the others:
  // a note was signed with the primary address of its day, and a person asks with any of them.
  const accounts = heldAccounts ?? (held === undefined ? accountStoreFor(config.config) : undefined);
  let addresses: string[] = [];
  if ('email' in which) {
    try {
      addresses = await addressesOfAccount(accounts, which.email);
    } catch (error) {
      return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
    }
  }
  const { that, none, search } = describe(addresses.length > 1 ? { email: addresses.join(', ') } : which);
  const store = held ?? config.config.store.create();
  if (store.forget === undefined) {
    const provider = config.config.store.provider;

    return {
      ok: false,
      lines: [
        `the ${provider} store does not delete notes from this command.`,
        provider === 'memory'
          ? 'Its notes are in the memory of the worker, and they go when the worker stops.'
          : `They are issues in your tracker: search them for ${search}, read them, and delete the ones that are this reporter's.`,
        ...(index === undefined ? [] : [TRACKER_NOTES]),
      ],
    };
  }

  const forget = store.forget.bind(store);
  // Each address in turn: a note gives one address as its reporter's.
  const forgetAll = async (options: { dryRun: boolean }): Promise<ForgottenNote[]> => {
    if (addresses.length <= 1) return forget(which, options);
    const all: ForgottenNote[] = [];
    for (const email of addresses) all.push(...(await forget({ email }, options)));

    return all;
  };
  let found: ForgottenNote[];
  try {
    // Listed first, whatever was asked: an identifier that names no note stops the deletion of the
    // others, because a list with a typing error in it is not the list the operator read.
    found = await forgetAll({ dryRun: true });
    const missing =
      'identifiers' in which ? which.identifiers.filter((id) => !found.some((note) => note.identifier === id)) : [];
    if (missing.length > 0) {
      return { ok: false, lines: [`no note is ${missing.join(', ')}. Nothing was deleted.`] };
    }
    if (!dryRun && found.length > 0) {
      // FRU-237: the index of these notes goes first, its excerpt of their text included. An index
      // that does not answer stops the command before a note is deleted: run it again, and nothing
      // of a note is left behind in the index.
      const notes = { notes: found.map(({ identifier, id }) => ({ identifier, note: id })) };
      await index?.forget(notes);
      found = await forgetAll({ dryRun: false });
      // Again, once the notes are gone: a read of their page that asked the store before the
      // deletion may have written their rows back since (FRU-237). A read that starts now does not
      // find them, and writes nothing of them. The notes are deleted by now, so a failure here is
      // said as what it is, with the command that ends it: a second run would find no note.
      // The notes the deletion took, with the ones listed: a note of the same reporter that arrived
      // between the list and the deletion went too, and so does its row.
      const deleted = {
        notes: [...notes.notes, ...found.map(({ identifier, id }) => ({ identifier, note: id }))].filter(
          (note, at, all) =>
            all.findIndex((other) => other.identifier === note.identifier && other.note === note.note) === at,
        ),
      };
      try {
        await index?.forget(deleted);
      } catch (error) {
        const again = deleted.notes.map((note) => `--note ${note.note}`).join(' ');

        return {
          ok: false,
          lines: [
            `deleted ${found.length} note(s) that ${that}, but the index of the notes did not answer after: ${String(error instanceof Error ? error.message : error)}`,
            `A row of them may be left in the index, with up to 64 characters of their text. Run: forget ${again}`,
          ],
        };
      }
    }
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }

  if (found.length === 0) return { ok: true, lines: [none, ...(index === undefined ? [] : [TRACKER_NOTES])] };

  const listed = found.map((note) => `  ${note.identifier}  ${note.createdAt}  ${note.pageUrl}  ${excerpt(note.text)}`);

  return {
    ok: true,
    lines: dryRun
      ? [`${found.length} note(s) ${that}. Nothing was deleted (--dry-run):`, ...listed]
      : [
          `deleted ${found.length} note(s), with their replies, that ${that}:`,
          ...listed,
          // The worker caches a read for this long, so a page can still show the note for a moment.
          `A page can still show them for ${Math.round(CACHE_TTL_MS / 1000)} seconds. Your backups still hold them.`,
          ...(index === undefined ? [] : [TRACKER_NOTES]),
        ],
  };
}

/**
 * Every address of the account that has `email` (FRU-450), the typed one first, or that one alone when
 * no account has it. A worker with no accounts reads none.
 */
async function addressesOfAccount(
  accounts: Pick<AccountStore, 'ownerOfAddress' | 'account' | 'addresses'> | undefined,
  email: string,
): Promise<string[]> {
  const typed = email.trim().toLowerCase();
  if (accounts === undefined) return [email];
  const owner = await accounts.ownerOfAddress(typed);
  if (owner === undefined) return [email];
  const account = await accounts.account(owner);
  const all = [
    typed,
    ...(account === undefined ? [] : [account.email]),
    ...(await accounts.addresses(owner)).map((row) => row.email),
  ];

  return [...new Set(all)];
}

/** What `forget` says of the notes it does not see, on a worker with an index (FRU-237). */
const TRACKER_NOTES =
  'Notes that went to a tracker are not found by an address or a name here: delete each issue in its tracker, and remove what the worker holds of it, its row in the index with up to 64 characters of its text, with --note <id> (the "id" of the note in the issue).';

/** `--note`: the rows of the index of these notes, whatever the store (FRU-237). */
async function forgetNotes(
  notes: readonly string[],
  dryRun: boolean,
  index: NoteIndex | undefined,
): Promise<ForgetOutcome> {
  if (index === undefined) {
    return {
      ok: false,
      lines: ['this worker has no index of the notes (no FRUITBACK_DATABASE_URL): nothing of a note to remove.'],
    };
  }
  let rows: IndexedNote[];
  try {
    rows = await index.forget({ ids: notes }, { dryRun });
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }
  const missing = notes.filter((note) => !rows.some((row) => row.note === note));
  const listed = rows.map(
    (row) =>
      `  ${row.note}  ${row.reference ?? '-'}  ${new Date(row.createdAt).toISOString()}  ${row.pageUrl}  ${row.excerpt}`,
  );

  return {
    ok: true,
    lines: [
      dryRun
        ? `${rows.length} row(s) of the index name these notes. Nothing was removed (--dry-run):`
        : `removed ${rows.length} row(s) of the index, with their excerpt:`,
      ...listed,
      ...(missing.length === 0 ? [] : [`no row of the index names ${missing.join(', ')}.`]),
      'The notes themselves are where they went: delete each issue in its tracker.',
    ],
  };
}

function excerpt(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim();

  return line.length > NOTE_EXCERPT_LENGTH ? `${line.slice(0, NOTE_EXCERPT_LENGTH - 1)}…` : line;
}

/**
 * The copy of the switch n° 1, as a command for the same reason as `pair` (FRU-145).
 *
 * `node server.mjs migrate-to-postgres --accounts /data/accounts.db --sessions /data/sessions.db --dry-run`
 *
 * It copies the accounts and the sessions of the two SQLite files into the database of
 * `FRUITBACK_DATABASE_URL`, and never writes the two files: `postgres-copy.ts` says how. The runbook
 * of the switch is in `cloud/README.md`.
 *
 * `node server.mjs migrate-to-postgres --notes /data/fb.db --dry-run` copies the notes of the file
 * of `FRUITBACK_STORE=sqlite` (FRU-220, the switch n° 1 bis), in a run of its own. The notes of the
 * file are of the kind of before FRU-378, which only `rewrite-notes` of 0.4.0 reads: copy them on
 * 0.4.0 (`docs/self-hosting/upgrade.md`). This worker refuses a file that holds one.
 */

/**
 * What the command copies: the two files of the switch n° 1 (FRU-145), or the file of the notes
 * (FRU-220). Never both in one run: the first copy goes into a database that no worker started on,
 * and the second into the database of a worker of this image.
 */
export type MigrateArgs =
  | { copy: 'accounts'; accountsPath: string; sessionsPath: string; dryRun: boolean }
  | { copy: 'notes'; notesPath: string; clients: Map<string | null, string>; dryRun: boolean };

export type MigrateArgsResult = { ok: true; args: MigrateArgs } | { ok: false; error: string };

const MIGRATE_USAGE = [
  'usage: migrate-to-postgres --accounts <file> --sessions <file> [--dry-run]',
  '       migrate-to-postgres --notes <file> [--client <id in the file>=<id of the site>]... [--no-client <id of the site>] [--dry-run]',
].join('\n');

const FILE_FLAGS = ['--accounts', '--sessions', '--notes'];

export function parseMigrateArgs(argv: readonly string[]): MigrateArgsResult {
  const refuse = (reason: string): MigrateArgsResult => ({ ok: false, error: `${MIGRATE_USAGE}\n${reason}` });
  const paths = new Map<string, string>();
  const clients = new Map<string | null, string>();
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    const valued = value !== undefined && !value.startsWith('--') && value.trim() !== '';
    if (FILE_FLAGS.includes(flag)) {
      // `--accounts --dry-run` would otherwise read the flag as the file, and copy for good.
      if (!valued) return refuse(`${flag} needs a file`);
      if (paths.has(flag)) return refuse(`${flag} takes one file`);
      paths.set(flag, value.trim());
    } else if (flag === '--client') {
      // The first `=`: an id of a site has none, and an id of `FRUITBACK_CLIENTS` is a key of JSON.
      const at = valued ? value.indexOf('=') : -1;
      const before = at === -1 ? '' : (value ?? '').slice(0, at).trim();
      const site = at === -1 ? '' : (value ?? '').slice(at + 1).trim();
      if (before === '' || site === '') return refuse('--client needs <id in the file>=<id of the site>');
      if (clients.has(before)) return refuse(`--client names « ${before} » twice`);
      clients.set(before, site);
    } else if (flag === '--no-client') {
      if (!valued) return refuse('--no-client needs the id of a site');
      if (clients.has(null)) return refuse('--no-client takes one site');
      clients.set(null, value.trim());
    } else {
      // Refused rather than ignored: `--dryrun` must not copy for good what `--dry-run` would only try.
      return refuse(`unexpected: ${flag}`);
    }
    index += 1;
  }

  const accountsPath = paths.get('--accounts');
  const sessionsPath = paths.get('--sessions');
  const notesPath = paths.get('--notes');
  if (notesPath !== undefined) {
    if (accountsPath !== undefined || sessionsPath !== undefined) {
      return refuse('--notes is a run of its own: copy the accounts and the sessions first, then the notes');
    }

    return { ok: true, args: { copy: 'notes', notesPath, clients, dryRun } };
  }
  if (clients.size > 0) return refuse('--client and --no-client go with --notes');
  if (accountsPath === undefined || sessionsPath === undefined) {
    return refuse('--accounts and --sessions are required, or --notes');
  }

  return { ok: true, args: { copy: 'accounts', accountsPath, sessionsPath, dryRun } };
}

export async function runMigrateToPostgres(
  argv: readonly string[],
  env: WorkerEnv,
): Promise<{ ok: boolean; lines: string[] }> {
  const parsed = parseMigrateArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  // Named by its variable, never quoted: the address holds the password.
  const url = readDatabaseUrl(env.FRUITBACK_DATABASE_URL);
  if (url === undefined)
    return { ok: false, lines: ['FRUITBACK_DATABASE_URL (a postgres:// address with a host) is required'] };

  const { args } = parsed;
  const files = args.copy === 'notes' ? [args.notesPath] : [args.accountsPath, args.sessionsPath];
  // Checked here: `node:sqlite` makes an empty database of a path that names no file.
  const absent = files.filter((path) => !existsSync(path));
  if (absent.length > 0) return { ok: false, lines: [`no file at ${absent.join(', ')}. Nothing was written.`] };

  const schema = readDatabaseSchema(env.FRUITBACK_DATABASE_SCHEMA);
  if (schema === undefined) return { ok: false, lines: [`${DATABASE_SCHEMA_REFUSED} is required`] };

  const database = createPgDatabase(url, schema, { max: 1 });
  try {
    return args.copy === 'notes'
      ? await copyNotesFile({ notesPath: args.notesPath, clients: args.clients, database, dryRun: args.dryRun })
      : await copySqliteFiles({ ...args, database });
  } catch (error) {
    return { ok: false, lines: [`${String(error instanceof Error ? error.message : error)}. Nothing was written.`] };
  } finally {
    await database.close();
  }
}

/**
 * The sign-in link of an administrator, as a command (FRU-221), for the same reason as `pair`.
 *
 * `docker compose exec worker node server.mjs admin-link --email ana@acme.dev`
 *
 * For an instance that has no owner yet, or for an owner who lost their session: `first-admin.ts`
 * says what it refuses. The link is written on the terminal and nowhere else. **A line that says who
 * the link is for, with no link, goes to the log of the worker**, so a link made by somebody who got
 * into the container is not made in silence.
 */
const ADMIN_LINK_USAGE = 'usage: admin-link --email <address>';

export function parseAdminLinkArgs(
  argv: readonly string[],
): { ok: true; email: string } | { ok: false; error: string } {
  const [flag, value, ...rest] = argv;
  if (flag !== '--email' || value === undefined || value.startsWith('--') || rest.length > 0) {
    return {
      ok: false,
      error: `${ADMIN_LINK_USAGE}\n${argv.length === 0 ? '--email is required' : `unexpected: ${argv.join(' ')}`}`,
    };
  }

  return { ok: true, email: value };
}

/**
 * Writes a line where `docker logs` reads it. A command started with `docker exec` writes on the
 * terminal of whoever started it, and not in the log of the container: the log is the output of the
 * first process, which Linux gives a path. `false` where there is no such path, or no right to it.
 */
export function writeInTheLogOfTheWorker(line: string, path = '/proc/1/fd/1'): boolean {
  try {
    appendFileSync(path, `${line}\n`);

    return true;
  } catch {
    return false;
  }
}

export async function runAdminLink(
  argv: readonly string[],
  env: WorkerEnv,
  held?: AdminLinks,
  leave: (line: string) => boolean = writeInTheLogOfTheWorker,
): Promise<{ ok: boolean; lines: string[] }> {
  const parsed = parseAdminLinkArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };
  const links = held ?? adminLinksFor(config.config);
  if (links === undefined) {
    return {
      ok: false,
      lines: [
        'this worker signs nobody in to the console: set FRUITBACK_DATABASE_URL, FRUITBACK_AUTH_SECRET, FRUITBACK_PUBLIC_URL and FRUITBACK_CONSOLE_URL. Nothing was written.',
      ],
    };
  }

  let outcome: AdminLinkOutcome;
  try {
    outcome = await adminLinkFor(links, parsed.email);
  } catch (error) {
    return { ok: false, lines: [`${String(error instanceof Error ? error.message : error)}. No link was made.`] };
  }
  if (outcome.log === undefined) return { ok: outcome.ok, lines: outcome.lines };

  const logged = leave(`[fruitback] ${new Date().toISOString()} ${outcome.log}`);

  return {
    ok: outcome.ok,
    lines: [
      ...outcome.lines,
      logged
        ? 'A line in the log of the worker says that this link was made, and for whom. It does not hold the link.'
        : 'The log of the worker could not be written from here: nothing there says that this link was made.',
    ],
  };
}
