import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleRequest, storeFor } from './app.ts';
import type { SeedStore } from './store.ts';
import { openReadClients } from './clients.ts';
import { DEFAULT_HOST, DEFAULT_TRUSTED_PROXY_HOPS, type WorkerEnv, readConfig, readPort } from './env.ts';
import { fakeLinearDeprecationNotice, fakeLinearIgnoredReason } from './store-config.ts';
import { isDevOnlyProvider } from './stores.ts';
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

export function createFruitbackServer(env: WorkerEnv, provided?: SeedStore): Server {
  const config = readConfig(env);
  // A misconfigured service still answers /health and the 500 diagnostic, so it still needs a hop
  // count to key the limiter with.
  const trustedProxyHops = config.ok ? config.config.trustedProxyHops : DEFAULT_TRUSTED_PROXY_HOPS;
  /**
   * Built here, once, and handed to every request (SKG-522).
   *
   * `app.ts` would build one per call otherwise. That is free for Linear and the in-memory store —
   * both are stateless closures — and would open a SQLite connection per request as soon as SKG-524
   * lands. A misconfigured process has no store: it only ever answers `/health` and the diagnostic.
   */
  const store = provided ?? (config.ok ? storeFor(config.config) : undefined);

  return createServer((incoming, response) => {
    void respond(incoming, response, env, trustedProxyHops, store);
  });
}

async function respond(
  incoming: IncomingMessage,
  response: ServerResponse,
  env: WorkerEnv,
  trustedProxyHops: number,
  store: SeedStore | undefined,
): Promise<void> {
  try {
    const request = toWebRequest(incoming);
    const clientIp = resolveClientIp(
      incoming.headers['x-forwarded-for'] as string | undefined,
      incoming.socket.remoteAddress,
      trustedProxyHops,
    );

    const result = await handleRequest(request, env, { clientIp, store });
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
  // Constructed here and handed to the server, so the boot log names the very object serving
  // requests rather than a second one built to be described. One store per process, once.
  const store = config.ok ? storeFor(config.config) : undefined;
  const server = createFruitbackServer(env, store);

  // The reason comes from the env rather than being spelled here, because the flag can lose two
  // ways and this line used to claim it was always production. An explicit FRUITBACK_STORE=memory is
  // refused at boot instead of ignored — see `readStoreConfig`.
  const flagIgnored = fakeLinearIgnoredReason(env);
  if (flagIgnored !== undefined) {
    console.error(`[fruitback] FRUITBACK_FAKE_LINEAR ignored: ${flagIgnored}`);
  }

  // The other half, and the one an operator with something to migrate actually hears (SKG-581):
  // warning only when the flag *loses* reaches everybody except the deployments still relying on it.
  // A warning rather than an error, because nothing is wrong here — the flag worked. The two are
  // mutually exclusive by construction, so this never doubles the line above.
  const flagDeprecated = fakeLinearDeprecationNotice(env);
  if (flagDeprecated !== undefined) {
    console.warn(`[fruitback] FRUITBACK_FAKE_LINEAR is deprecated: ${flagDeprecated}`);
  }

  server.listen(port, host, () => {
    if (config.ok) {
      // Never log the API key. Everything else is worth having in `docker logs` on day one.
      console.log(
        // The store's name rather than a team id (SKG-522): "which store is this process on" is the
        // thing an operator cannot tell from their own env, and naming a team here was the last
        // place the worker's own logging assumed one.
        `[fruitback] listening on ${host}:${port} · store ${store?.name ?? 'none'} · ` +
          `origins ${config.config.allowedOrigins.join(', ')} · trusted proxy hops ${config.config.trustedProxyHops}`,
      );
      // Asked of the registry rather than of a provider name spelled here, so a second dev-only
      // store (a fixture, a demo) warns without this line having to hear about it.
      if (isDevOnlyProvider(config.config.store.provider)) {
        console.warn(
          `[fruitback] store ${config.config.store.provider} is dev-only: nothing is written to a ` +
            'workspace, and it all dies with this process',
        );
      }

      // `public` stays the default so an upgrade never blanks a working deployment — but an operator
      // should not have to infer their exposure from a field they did not write (SKG-533). Named
      // here, where only they can see it; `/health` carries a count and no ids.
      const openRead = openReadClients({ read: config.config.read, clients: config.config.clients });
      if (openRead.length > 0) {
        console.warn(
          `[fruitback] read is public for ${openRead.join(', ')}: their pins, authors and replies ` +
            'are readable by anyone who can reach this worker. Set FRUITBACK_READ=authenticated, ' +
            'or "read": "authenticated" per client, to require a token.',
        );
      }
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
