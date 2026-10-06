import { type WorkerEnv, readConfig } from './env.ts';
import { PAIRING_TTL_SECONDS } from './session.ts';
import { createPairingCommand } from './app.ts';
import { CACHE_TTL_MS } from './cache.ts';
import type { ForgottenSeed } from './store.ts';

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

export type PairArgs = { subject: string; name?: string; email?: string };

export type PairArgsResult = { ok: true; args: PairArgs } | { ok: false; error: string };

const USAGE = 'usage: pair --subject <id> [--name "<full name>"] [--email <address>]';

const KNOWN_FLAGS = new Set(['subject', 'name', 'email']);

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

  return {
    ok: true,
    args: {
      // The stable id for this person, and what lands in `reporter.id` on every seed they file.
      subject: subject.trim(),
      ...(name === undefined || name === '' ? {} : { name }),
      ...(email === undefined || email === '' ? {} : { email }),
    },
  };
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

  return {
    ok: true,
    lines: [
      `pairing code for ${parsed.args.subject}${who === '' ? '' : ` (${who})`}:`,
      '',
      `    ${minted.code}`,
      '',
      // Said out loud because the store keeps only a digest: there is no command that reads it back.
      `Valid for ${Math.round(PAIRING_TTL_SECONDS / 60)} minutes, and usable once.`,
      'It is not stored and cannot be shown again — mint another if it is lost.',
    ],
  };
}

/**
 * Deleting the notes of one reporter, as a command for the same reason as `pair` (FRU-85).
 *
 * `docker exec <container> node server.mjs forget --email alice@acme.dev --dry-run`
 *
 * It always lists what it found before it says what it did. A typed address is a claim: a reporter
 * can type somebody else's, and two reporters can type the same one. Run it with `--dry-run` first,
 * and read the list.
 */

export type ForgetArgs = { email: string; dryRun: boolean };

export type ForgetArgsResult = { ok: true; args: ForgetArgs } | { ok: false; error: string };

const FORGET_USAGE = 'usage: forget --email <address> [--dry-run]';

/** A note excerpt long enough to recognise it, short enough to keep one note on one line. */
const NOTE_EXCERPT_LENGTH = 60;

export function parseForgetArgs(argv: readonly string[]): ForgetArgsResult {
  let email: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--email') {
      email = argv[index + 1];
      // `--email --dry-run` would otherwise read the flag as the address and run a real deletion.
      if (email === undefined || email.startsWith('--')) {
        return { ok: false, error: `${FORGET_USAGE}\n--email needs a value` };
      }
      index += 1;
    } else {
      // Refused rather than ignored: `--dryrun` must not delete what `--dry-run` would only list.
      return { ok: false, error: `${FORGET_USAGE}\nunexpected: ${flag}` };
    }
  }

  if (email === undefined || email.trim() === '') return { ok: false, error: `${FORGET_USAGE}\n--email is required` };

  return { ok: true, args: { email: email.trim(), dryRun } };
}

export type ForgetOutcome = { ok: boolean; lines: string[] };

export async function runForget(argv: readonly string[], env: WorkerEnv): Promise<ForgetOutcome> {
  const parsed = parseForgetArgs(argv);
  if (!parsed.ok) return { ok: false, lines: [parsed.error] };

  const config = readConfig(env);
  if (!config.ok) return { ok: false, lines: [`misconfigured: ${config.missing.join(', ')}`] };

  const store = config.config.store.create();
  if (store.forgetReporter === undefined) {
    const provider = config.config.store.provider;

    return {
      ok: false,
      lines: [
        `the ${provider} store does not delete notes from this command.`,
        provider === 'memory'
          ? 'Its notes are in the memory of the worker, and they go when the worker stops.'
          : `They are issues in your tracker: search them for ${parsed.args.email}, read them, and delete the ones that are this reporter's.`,
      ],
    };
  }

  let found: ForgottenSeed[];
  try {
    found = await store.forgetReporter(parsed.args.email, { dryRun: parsed.args.dryRun });
  } catch (error) {
    return { ok: false, lines: [String(error instanceof Error ? error.message : error)] };
  }

  if (found.length === 0) return { ok: true, lines: [`no note gives ${parsed.args.email} as its reporter's address.`] };

  const listed = found.map((seed) => `  ${seed.identifier}  ${seed.createdAt}  ${seed.pageUrl}  ${excerpt(seed.note)}`);

  return {
    ok: true,
    lines: parsed.args.dryRun
      ? [`${found.length} note(s) give ${parsed.args.email}. Nothing was deleted (--dry-run):`, ...listed]
      : [
          `deleted ${found.length} note(s), with their replies, that give ${parsed.args.email}:`,
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
