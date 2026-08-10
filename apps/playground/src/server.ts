import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

/**
 * The dev playground (SKG-511).
 *
 * The widget is a library with nowhere to live until the Shadow DOM host lands (SKG-492), and a
 * library with nowhere to live cannot be looked at — which is how SKG-494 ended up verified by a
 * throwaway script. This serves a deliberately hostile page with the widget mounted on it, so the
 * capture, the pins and the colours can be seen, clicked, and driven by the E2E suite.
 *
 * No bundler config and no build step: `client.ts` goes through esbuild **per request**, which takes
 * a few milliseconds and is always in sync with the sources — same reason the tests run the
 * TypeScript directly.
 */

/** Fixed on purpose: CLAUDE.md names it, so the browser skills find the server instead of guessing. */
export const DEFAULT_PLAYGROUND_PORT = 5177;

/**
 * Where the worker answers in the dev loop, on its in-memory Linear. Not 8080: that is the
 * container's port, and something else is usually squatting it on a developer's machine.
 */
export const DEFAULT_WORKER_ORIGIN = 'http://localhost:8788';

const SOURCE_DIR = import.meta.dirname;

export type PlaygroundOptions = { workerOrigin?: string };

export function createPlaygroundServer(options: PlaygroundOptions = {}): Server {
  const workerOrigin = options.workerOrigin ?? process.env.FRUITBACK_WORKER_ORIGIN ?? DEFAULT_WORKER_ORIGIN;

  return createServer((request, response) => {
    void serve(request.url ?? '/', workerOrigin, response).catch((error: unknown) => {
      console.error('[playground] failed to serve', request.url, error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('playground failed to build the page — see the terminal');
    });
  });
}

async function serve(url: string, workerOrigin: string, response: import('node:http').ServerResponse): Promise<void> {
  const { pathname } = new URL(url, 'http://localhost');

  if (pathname === '/' || pathname === '/index.html') {
    const html = await readFile(join(SOURCE_DIR, 'page.html'), 'utf8');

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html.replace('%WORKER_ORIGIN%', workerOrigin));
    return;
  }

  if (pathname === '/client.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await bundleClient());
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('not found');
}

async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [join(SOURCE_DIR, 'client.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    // Kept in memory: nothing about the playground should leave a build artefact behind.
    write: false,
  });

  return result.outputFiles[0]?.text ?? '';
}

/**
 * A malformed `PORT` falls back to the default rather than reaching `listen` as `NaN` and killing
 * the process on boot. Same shape as the worker's `readPort`, and the same reasoning: this is a dev
 * server, so refusing to start over a typo helps nobody.
 */
export function readPlaygroundPort(value: string | undefined = process.env.PORT): number {
  const parsed = Number(value ?? '');

  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PLAYGROUND_PORT;
}

export function startPlayground(): Server {
  const port = readPlaygroundPort();
  const server = createPlaygroundServer();

  server.listen(port, '127.0.0.1', () => {
    console.log(
      `[playground] http://localhost:${port} · worker ${process.env.FRUITBACK_WORKER_ORIGIN ?? DEFAULT_WORKER_ORIGIN}`,
    );
  });

  return server;
}
