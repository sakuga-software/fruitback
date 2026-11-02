import type { FruitbackOptions } from './embed.ts';
import { type FruitbackTransport, type TransportRequest, type TransportResponse, fetchTransport } from './transport.ts';

/**
 * The calls of the widget to the worker (FRU-509): the transport, the token and the headers, written
 * once. `embed.ts` says what each call sends and what its answer means.
 */

/** What a call needs of the options of `init`. */
export type WorkerOptions = Pick<FruitbackOptions, 'endpoint' | 'clientId' | 'identityToken' | 'transport'>;

/**
 * The transport of this mount: the host's, or `fetch` from this page.
 *
 * The only place that names the default, so a call site added later cannot take it and leave the
 * relay of a host out. `embed.test.ts` counts its mentions in this file, this comment included: do
 * not spell it here.
 */
function transportFor(options: WorkerOptions): FruitbackTransport {
  return options.transport ?? fetchTransport;
}

/** A call: its address, its method, and its body. `contentType` goes with a body. */
export type WorkerRequest = Omit<TransportRequest, 'headers'> & { contentType?: string };

/**
 * Sends one call, with the token of the host when it gives one.
 *
 * The token is asked for at each call: a short-lived token that expired mid-session would otherwise
 * refuse every later call until the page is reloaded. It goes in a header and never in a body: a note
 * is stored as it came in the description of an issue (FRU-9).
 *
 * `stillWanted` is asked after the token: `false`, nothing is sent and the answer is `undefined`.
 */
export function callWorker(options: WorkerOptions, request: WorkerRequest): Promise<TransportResponse>;
export function callWorker(
  options: WorkerOptions,
  request: WorkerRequest,
  stillWanted: () => boolean,
): Promise<TransportResponse | undefined>;
export async function callWorker(
  options: WorkerOptions,
  { contentType, ...request }: WorkerRequest,
  stillWanted: () => boolean = () => true,
): Promise<TransportResponse | undefined> {
  const token = await options.identityToken?.();
  if (!stillWanted()) return undefined;

  return transportFor(options)({
    ...request,
    headers: {
      ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
  });
}

/** The address of a route about one note: `/feedback/<id>/replies`, `/text` or `/check`. */
export function noteRoute(options: WorkerOptions, id: string, route: 'replies' | 'text' | 'check'): string {
  return `${options.endpoint}/feedback/${encodeURIComponent(id)}/${route}?client=${encodeURIComponent(options.clientId)}`;
}

/** The `error` of an answer of the worker, or `undefined` for a body that is not JSON. */
export function errorOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/**
 * Why a write about one note did not go — a reply, an edit, a verdict — or `undefined` when it went.
 * `wait` for a `429`, `signed-out` for a `401`, `refused` when `refuses` says so, and `retry` for any
 * other failure.
 */
export function noteWriteFailure(response: TransportResponse): 'wait' | 'signed-out' | 'retry' | undefined;
export function noteWriteFailure(
  response: TransportResponse,
  refuses: (response: TransportResponse) => boolean,
): 'wait' | 'signed-out' | 'refused' | 'retry' | undefined;
export function noteWriteFailure(
  response: TransportResponse,
  refuses: (response: TransportResponse) => boolean = () => false,
): 'wait' | 'signed-out' | 'refused' | 'retry' | undefined {
  if (response.status === 429) return 'wait';
  if (response.status === 401) return 'signed-out';
  if (refuses(response)) return 'refused';

  return response.ok ? undefined : 'retry';
}
