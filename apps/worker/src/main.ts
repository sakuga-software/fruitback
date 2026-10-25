import { startServer } from './server.ts';
import { runAdminLink, runForget, runMigrateToPostgres, runPair } from './cli.ts';
import { closeDatabases } from './postgres.ts';
import { runRewriteNotes } from './rewrite-notes.ts';

/**
 * Container entry point, kept apart from `server.ts` so importing the server in a test does not bind
 * a port as a side effect.
 *
 * `admin-link` writes the sign-in link of an administrator (FRU-221). Three more subcommands: `pair` mints a pairing code for the extension (FRU-42), `forget` deletes the
 * notes of one reporter (FRU-85), and `migrate-to-postgres` copies the accounts and the sessions of
 * the SQLite files into PostgreSQL (FRU-145). Anything else starts the server, so the image's `CMD` is unchanged
 * and a deployment that knows nothing about sessions behaves exactly as before.
 */
// A Map and not an object literal: `COMMANDS.constructor` would be a function, and the server would not start.
const COMMANDS = new Map<
  string | undefined,
  (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; lines: string[] }>
>([
  ['admin-link', runAdminLink],
  ['pair', runPair],
  ['forget', runForget],
  ['migrate-to-postgres', runMigrateToPostgres],
  // FRU-378: the notes of before, rewritten once into the note of now.
  ['rewrite-notes', runRewriteNotes],
]);
const command = COMMANDS.get(process.argv[2]);

if (command !== undefined) {
  const outcome = await command(process.argv.slice(3), process.env);

  for (const line of outcome.lines) (outcome.ok ? console.log : console.error)(line);
  process.exitCode = outcome.ok ? 0 : 1;
  // `pair` writes its code in the database when the worker has one (FRU-142). An open pool keeps the
  // process up until its connections time out, so a command would end ten seconds after its answer.
  await closeDatabases();
} else {
  startServer();
}
