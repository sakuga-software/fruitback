import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleRequest } from './app.ts';
import { DEFAULT_HOST, DEFAULT_TRUSTED_PROXY_HOPS, type WorkerEnv, readConfig, readPort } from './env.ts';
import { resolveClientIp } from './rate-limit.ts';

/**
 * Node entry point: adapts `node:http` onto the web-standard handler in `app.ts`.
 *
 * Deployed as a container (Dokploy → Docker on a VPS), so two things matter here that do not matter
 * in a dev script: the process must listen on every interface, and it must shut down on SIGTERM
 * without dropping in-flight requests.
 */

/** How long to let in-flight requests finish before giving up on a graceful stop. */
const SHUTDOWN_GRACE_MS = 10_000;

export function createFruitbackServer(env: WorkerEnv): Server {
  const config = readConfig(env);
  // A misconfigured service still answers /health and the 500 diagnostic, so it still needs a hop
  // count to key the limiter with.
  const trustedProxyHops = config.ok ? config.config.trustedProxyHops : DEFAULT_TRUSTED_PROXY_HOPS;

  return createServer((incoming, response) => {
    void respond(incoming, response, env, trustedProxyHops);
  });
}

async function respond(
  incoming: IncomingMessage,
  response: ServerResponse,
  env: WorkerEnv,
  trustedProxyHops: number,
): Promise<void> {
  try {
    const request = toWebRequest(incoming);
    const clientIp = resolveClientIp(
      incoming.headers['x-forwarded-for'] as string | undefined,
      incoming.socket.remoteAddress,
      trustedProxyHops,
    );

    const result = await handleRequest(request, env, { clientIp });
    await writeWebResponse(result, response);
  } catch (error) {
    // Never leak an internal message to a client site; the details belong in the container logs.
    console.error('[fruitback] request failed', error);

    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal' }));
      return;
    }

    response.destroy();
  }
}

function toWebRequest(incoming: IncomingMessage): Request {
  // The proxy terminates TLS, so the scheme here is always http; only the path and host matter.
  const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`);
  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(url, {
    method,
    headers: toWebHeaders(incoming),
    // Streamed, not buffered: `app.ts` aborts an oversized upload mid-flight, and that only works
    // if the body is still a stream by the time it gets there.
    body: hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null,
    duplex: 'half',
  } as RequestInit);
}

function toWebHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;

    // Node collapses most repeated headers, except a few it hands back as an array.
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }

  return headers;
}

async function writeWebResponse(result: Response, response: ServerResponse): Promise<void> {
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.writeHead(result.status);

  if (result.body === null) {
    response.end();
    return;
  }

  await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]), response);
}

export function startServer(env: WorkerEnv = process.env): Server {
  const config = readConfig(env);
  const port = readPort(env);
  const host = env.HOST || DEFAULT_HOST;
  const server = createFruitbackServer(env);

  server.listen(port, host, () => {
    if (config.ok) {
      // Never log the API key. Everything else is worth having in `docker logs` on day one.
      console.log(
        `[fruitback] listening on ${host}:${port} · team ${config.config.linearTeamId} · ` +
          `origins ${config.config.allowedOrigins.join(', ')} · trusted proxy hops ${config.config.trustedProxyHops}`,
      );
    } else {
      // Loud, but still serving: /health reports 503 with the same list, so the platform can see it.
      console.error(`[fruitback] misconfigured, missing: ${config.missing.join(', ')} — /health will report 503`);
    }
  });

  installGracefulShutdown(server);

  return server;
}

function installGracefulShutdown(server: Server): void {
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;

    console.log(`[fruitback] ${signal} received, draining`);
    server.close(() => process.exit(0));

    // Docker waits 10s before SIGKILL; beat it so the exit is ours and the logs say why.
    setTimeout(() => {
      console.error('[fruitback] grace period elapsed, exiting with connections open');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
