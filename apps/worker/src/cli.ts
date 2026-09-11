import { type WorkerEnv, readConfig } from './env.ts';
import { PAIRING_TTL_SECONDS } from './session.ts';
import { createPairingCommand } from './app.ts';

/**
 * Minting a pairing code, as a command rather than a route (SKG-535).
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
