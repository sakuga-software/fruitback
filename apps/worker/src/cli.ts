import { type WorkerEnv, readConfig } from './env.ts';
import { PAIRING_TTL_SECONDS } from './session.ts';
import { createPairingCommand } from './app.ts';
import { CACHE_TTL_MS } from './cache.ts';
import { pairingLink } from './pair-page.ts';
import type { ForgetSelector, ForgottenSeed } from './store.ts';

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

export type PairArgs = { subject: string; name?: string; email?: string; endpoint?: string };

export type PairArgsResult = { ok: true; args: PairArgs } | { ok: false; error: string };

const USAGE = 'usage: pair --subject <id> [--name "<full name>"] [--email <address>] [--endpoint <worker URL>]';

const KNOWN_FLAGS = new Set(['subject', 'name', 'email', 'endpoint']);

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
      // The stable id for this person, and what lands in `reporter.id` on every seed they file.
      subject: subject.trim(),
      ...(name === undefined || name === '' ? {} : { name }),
      ...(email === undefined || email === '' ? {} : { email }),
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

export type PairOutcome = { ok: true; lines: string[] } | { ok: false; lines: string[] };

/**
 * Reads the same configuration the server reads, so a container that cannot serve cannot mint
 * either — and says which variable is missing rather than failing on the database.
 */
export async function runPair(argv: readonly string[], env: WorkerEnv): Promise<PairOutcome> {
  const parsed = parsePairArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };

  let minted: { code: string; expiresAt: number };
  try {
    minted = await createPairingCommand(config.config, parsed.args);
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

  return {
    ok: true,
    lines: [
      `pairing code for ${parsed.args.subject}${who === '' ? '' : ` (${who})`}:`,
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
 *
 * It always lists what it found before it says what it did. A typed address is a claim: a reporter
 * can type somebody else's, and two reporters can type the same one. A typed name is a weaker claim,
 * so `--name` only lists. Run it with `--dry-run` first, read the list, and delete by `--id`.
 */

export type ForgetArgs = { which: ForgetSelector; dryRun: boolean };

export type ForgetArgsResult = { ok: true; args: ForgetArgs } | { ok: false; error: string };

const FORGET_USAGE =
  'usage: forget (--email <address> | --name <name> --dry-run | --id <FB-n> [--id <FB-n> ...]) [--dry-run]';

const VALUE_FLAGS = ['--email', '--name', '--id'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** A note excerpt long enough to recognise it, short enough to keep one note on one line. */
const NOTE_EXCERPT_LENGTH = 60;

export function parseForgetArgs(argv: readonly string[]): ForgetArgsResult {
  const refuse = (reason: string): ForgetArgsResult => ({ ok: false, error: `${FORGET_USAGE}\n${reason}` });
  const given: Record<ValueFlag, string[]> = { '--email': [], '--name': [], '--id': [] };
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
  if (kinds.length === 0) return refuse('one of --email, --name and --id is required');
  // Two selectors in one command have two readings, all of them or any of them. Neither is asked for.
  if (kinds.length > 1) return refuse(`use one of ${kinds.join(' and ')}, not both`);

  const [kind] = kinds;
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

export async function runForget(argv: readonly string[], env: WorkerEnv): Promise<ForgetOutcome> {
  const parsed = parseForgetArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };

  const { which, dryRun } = parsed.args;
  const { that, none, search } = describe(which);
  const store = config.config.store.create();
  if (store.forget === undefined) {
    const provider = config.config.store.provider;

    return {
      ok: false,
      lines: [
        `the ${provider} store does not delete notes from this command.`,
        provider === 'memory'
          ? 'Its notes are in the memory of the worker, and they go when the worker stops.'
          : `They are issues in your tracker: search them for ${search}, read them, and delete the ones that are this reporter's.`,
      ],
    };
  }

  let found: ForgottenSeed[];
  try {
    // Listed first, whatever was asked: an identifier that names no note stops the deletion of the
    // others, because a list with a typing error in it is not the list the operator read.
    found = await store.forget(which, { dryRun: true });
    const missing =
      'identifiers' in which ? which.identifiers.filter((id) => !found.some((seed) => seed.identifier === id)) : [];
    if (missing.length > 0) {
      return { ok: false, lines: [`no note is ${missing.join(', ')}. Nothing was deleted.`] };
    }
    if (!dryRun && found.length > 0) found = await store.forget(which, { dryRun: false });
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }

  if (found.length === 0) return { ok: true, lines: [none] };

  const listed = found.map((seed) => `  ${seed.identifier}  ${seed.createdAt}  ${seed.pageUrl}  ${excerpt(seed.note)}`);

  return {
    ok: true,
    lines: dryRun
      ? [`${found.length} note(s) ${that}. Nothing was deleted (--dry-run):`, ...listed]
      : [
          `deleted ${found.length} note(s), with their replies, that ${that}:`,
          ...listed,
          // The worker caches a read for this long, so a page can still show the note for a moment.
          `A page can still show them for ${Math.round(CACHE_TTL_MS / 1000)} seconds. Your backups still hold them.`,
        ],
  };
}

function excerpt(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim();

  return line.length > NOTE_EXCERPT_LENGTH ? `${line.slice(0, NOTE_EXCERPT_LENGTH - 1)}…` : line;
}
