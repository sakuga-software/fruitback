import { startServer } from './server.ts';
import { runPair } from './cli.ts';

/**
 * Container entry point, kept apart from `server.ts` so importing the server in a test does not bind
 * a port as a side effect.
 *
 * One subcommand, `pair`, which mints a pairing code for the extension (SKG-535). Anything else
 * starts the server, so the image's `CMD` is unchanged and a deployment that knows nothing about
 * sessions behaves exactly as before.
 */
if (process.argv[2] === 'pair') {
  const outcome = await runPair(process.argv.slice(3), process.env);

  for (const line of outcome.lines) (outcome.ok ? console.log : console.error)(line);
  process.exitCode = outcome.ok ? 0 : 1;
} else {
  startServer();
}
