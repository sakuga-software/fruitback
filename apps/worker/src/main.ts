import { startServer } from './server.ts';
import { runForget, runPair } from './cli.ts';

/**
 * Container entry point, kept apart from `server.ts` so importing the server in a test does not bind
 * a port as a side effect.
 *
 * Two subcommands: `pair` mints a pairing code for the extension (FRU-42), and `forget` deletes the
 * notes of one reporter (FRU-85). Anything else starts the server, so the image's `CMD` is unchanged
 * and a deployment that knows nothing about sessions behaves exactly as before.
 */
// A Map and not an object literal: `COMMANDS.constructor` would be a function, and the server would not start.
const COMMANDS = new Map<string | undefined, typeof runPair | typeof runForget>([
  ['pair', runPair],
  ['forget', runForget],
]);
const command = COMMANDS.get(process.argv[2]);

if (command !== undefined) {
  const outcome = await command(process.argv.slice(3), process.env);

  for (const line of outcome.lines) (outcome.ok ? console.log : console.error)(line);
  process.exitCode = outcome.ok ? 0 : 1;
} else {
  startServer();
}
