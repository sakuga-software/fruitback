import type { MountOptions } from './embed.ts';
import { type FruitbackTransport, type TransportRequest, type TransportResponse, fetchTransport } from './transport.ts';
import { VISITOR_HEADER } from './visitor-key.ts';
import { TURNSTILE_HEADER } from './bot-check.ts';

/**
 * The calls of the widget to the worker (FRU-509): the transport, the token and the headers, written
 * once. `embed.ts` says what each call sends and what its answer means.
 */

/** What a call needs of the options of `init`. */
export type WorkerOptions = Pick<MountOptions, 'endpoint' | 'clientId' | 'identityToken' | 'transport' | 'visitor'>;

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

/**
 * A call: its address, its method, and its body. `contentType` goes with a body. `asAuthor`: the call
 * sends a note, so the key of the browser is made first when there is none (FRU-700). `turnstile`: the
 * token of the check the worker asked for (FRU-704), on the note sent again.
 */
export type WorkerRequest = Omit<TransportRequest, 'headers'> & {
  contentType?: string;
  asAuthor?: true;
  turnstile?: string;
};

/**
 * Sends one call, with the token of the host when it gives one, and the key of a visitor's browser
 * when it has one (FRU-700).
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
  { contentType, asAuthor, turnstile, ...request }: WorkerRequest,
  stillWanted: () => boolean = () => true,
): Promise<TransportResponse | undefined> {
  const token = await options.identityToken?.();
  if (!stillWanted()) return undefined;
  // FRU-700: the key of this browser, with each call once a note made it. Only a mount of `init`
  // with no token and no transport of a host has one.
  const visitor = asAuthor === true ? options.visitor?.ensure() : options.visitor?.current();

  return transportFor(options)({
    ...request,
    headers: {
      ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(visitor === undefined ? {} : { [VISITOR_HEADER]: visitor }),
      ...(turnstile === undefined ? {} : { [TURNSTILE_HEADER]: turnstile }),
    },
  });
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
