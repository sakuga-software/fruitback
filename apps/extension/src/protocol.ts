/**
 * What the two worlds say to each other (SKG-534, SKG-596).
 *
 * A content script in the **isolated** world can read `chrome.storage` and talk to the background,
 * but it cannot see `__reactFiber$` — React sets that in the page's world, and expando properties do
 * not cross. A content script in the **main** world sees the fibers and has no `chrome.*` at all.
 * So the widget runs in the main world and is told what to do from the isolated one, and
 * `window.postMessage` is the only channel the two share.
 *
 * **The page is on that channel too.** It receives everything we post and can post anything back, so
 * nothing secret may travel here and every message must be parsed rather than trusted. The endpoint
 * and the client id are not secrets — the `<script>` tag mode writes both into the client's own DOM.
 * An identity token (SKG-498) is a secret, which is why none is sent: the relay below carries the
 * request and the background attaches the credential, out of the page's reach.
 */

import type { TransportRequest, TransportResponse } from '@fruitback/widget';
import { isWorkerEndpoint } from './endpoint.ts';

export const CHANNEL = 'fruitback-extension';

/**
 * The request the page asks the extension to make for it, and the answer.
 *
 * The widget's own transport seam (SKG-595), named here rather than re-declared: the relay exists to
 * fill it, and two copies of the shape would drift. Both are plain objects, because neither
 * `Request` nor `Response` survives `postMessage`.
 */
export type RelayRequest = TransportRequest;
export type RelayResponse = TransportResponse;

/**
 * The headers the page is allowed to name, and it is a list of one.
 *
 * An allowlist, so a header a page invents is dropped by default. `Authorization` is the reason:
 * the background builds it from the session, and a page that could name it would choose what
 * credential its own request carries. It is absent from this list rather than refused by it, so
 * there is no spelling to get wrong.
 */
const ALLOWED_HEADERS = ['Content-Type'];

/** The worker refuses a body over 64 KiB (`MAX_BODY_BYTES` in `apps/worker/src/app.ts`). */
const MAX_BODY_BYTES = 64 * 1_024;

/** Long enough for a UUID, short enough that a page cannot post a megabyte of it. */
const MAX_ID_LENGTH = 100;

/**
 * How long the background lets one relayed call run before it aborts it.
 *
 * **The abort is the point, not the deadline.** Without it a worker that accepts a connection and
 * never answers leaves the request in flight while the page is told the call failed — and a reviewer
 * told their note failed presses send again, which plants it twice. The worker cannot tell the two
 * apart (SKG-498 gives a seed its own id, which dedupes a retry of the *same* request, not a second
 * one). Raised in review.
 */
export const RELAY_CALL_TIMEOUT_MS = 20 * 1_000;

/**
 * How long the page waits for any answer at all.
 *
 * Deliberately longer than the call above, so the ordinary slow worker becomes a refusal the
 * background sends rather than a timeout the page invents. What is left for this one to catch is a
 * service worker that was stopped mid-call and a channel nobody is on.
 */
export const RELAY_ANSWER_TIMEOUT_MS = RELAY_CALL_TIMEOUT_MS + 5 * 1_000;

export type MountMessage = {
  channel: typeof CHANNEL;
  kind: 'mount';
  endpoint: string;
  clientId: string;
  label?: string;
};

export type UnmountMessage = {
  channel: typeof CHANNEL;
  kind: 'unmount';
};

/**
 * The main world announcing it can receive, sent the other way.
 *
 * Nothing orders the two content scripts against each other, so the isolated one can decide to mount
 * before the listener in the page's world exists — and a `postMessage` with nobody listening is
 * simply lost. The main world therefore says when it is there, rather than the isolated one guessing
 * with a timeout.
 *
 * The page can forge this, and the cost of that is one extra mount of the widget it is already
 * looking at, with a config it can already read. Worth naming, not worth defending against.
 */
export type ReadyMessage = {
  channel: typeof CHANNEL;
  kind: 'ready';
};

/**
 * Team mode: the extension is here, and it is not mounting anything (SKG-596).
 *
 * The other half of `mount`, sent for a site that embeds its own widget. The main world answers it
 * by putting a transport on the page, so the site's dormant widget has something to call. Nothing
 * travels with it: the endpoint and the client id are the site's own, which is what separates this
 * mode from the private one.
 */
export type AnnounceMessage = {
  channel: typeof CHANNEL;
  kind: 'announce';
};

/**
 * A call the page cannot make itself, on its way to the background (SKG-596).
 *
 * `id` pairs it with its answer. The page shares this channel, so it can send one of these and read
 * the answer to it — which buys it a call to a worker it can already reach, with a credential it
 * never sees. What stops it going further is `relay.ts`, in the background: the origin comes from
 * the sender and the endpoint from storage, neither of them from this message.
 */
export type RelayRequestMessage = {
  channel: typeof CHANNEL;
  kind: 'relay-request';
  id: string;
  request: RelayRequest;
};

export type RelayResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'relay-response';
  id: string;
  response: RelayResponse;
};

export type BridgeMessage =
  | MountMessage
  | UnmountMessage
  | ReadyMessage
  | AnnounceMessage
  | RelayRequestMessage
  | RelayResponseMessage;

/**
 * Recognise one of our messages, or return `undefined`.
 *
 * Tolerant on purpose and in one direction only: anything that is not exactly a message we sent is
 * refused. The page shares this channel, so a listener that trusted the shape would let any site
 * mount our widget against a worker of its choosing.
 */
export function parseBridgeMessage(data: unknown): BridgeMessage | undefined {
  if (!isRecord(data) || data.channel !== CHANNEL) return undefined;

  if (data.kind === 'unmount') return { channel: CHANNEL, kind: 'unmount' };
  if (data.kind === 'ready') return { channel: CHANNEL, kind: 'ready' };
  if (data.kind === 'announce') return { channel: CHANNEL, kind: 'announce' };
  if (data.kind === 'relay-request') return parseRelayRequestMessage(data);
  if (data.kind === 'relay-response') return parseRelayResponseMessage(data);
  if (data.kind !== 'mount') return undefined;

  const { endpoint, clientId, label } = data;
  if (!isWorkerEndpoint(endpoint) || !isNonEmptyString(clientId)) return undefined;

  return {
    channel: CHANNEL,
    kind: 'mount',
    endpoint,
    clientId,
    ...(isNonEmptyString(label) ? { label } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRelayRequestMessage(data: Record<string, unknown>): RelayRequestMessage | undefined {
  const id = parseId(data.id);
  const request = parseRelayRequest(data.request);
  if (id === undefined || request === undefined) return undefined;

  return { channel: CHANNEL, kind: 'relay-request', id, request };
}

/**
 * The request, rebuilt field by field.
 *
 * Never a spread of what arrived. The page writes this object, the background reads it, and a field
 * that travelled because nobody named it is a field nobody checked.
 */
export function parseRelayRequest(value: unknown): RelayRequest | undefined {
  if (!isRecord(value)) return undefined;

  const { url, method, headers, body } = value;
  if (!isWorkerEndpoint(url)) return undefined;
  if (method !== 'GET' && method !== 'POST') return undefined;
  if (body !== undefined && !isWithinBodyCap(body)) return undefined;

  return {
    url,
    method,
    headers: allowedHeaders(headers),
    ...(typeof body === 'string' ? { body } : {}),
  };
}

function parseRelayResponseMessage(data: Record<string, unknown>): RelayResponseMessage | undefined {
  const id = parseId(data.id);
  const response = parseRelayResponse(data.response);
  if (id === undefined || response === undefined) return undefined;

  return { channel: CHANNEL, kind: 'relay-response', id, response };
}

export function parseRelayResponse(value: unknown): RelayResponse | undefined {
  if (!isRecord(value)) return undefined;

  const { ok, status, body } = value;
  if (typeof ok !== 'boolean' || typeof status !== 'number' || !Number.isFinite(status)) return undefined;
  if (typeof body !== 'string') return undefined;

  return { ok, status, body };
}

function allowedHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const headers: Record<string, string> = {};
  for (const name of ALLOWED_HEADERS) {
    const given = Object.entries(value).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (typeof given === 'string') headers[name] = given;
  }

  return headers;
}

function isWithinBodyCap(body: unknown): body is string {
  return typeof body === 'string' && new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES;
}

function parseId(value: unknown): string | undefined {
  return isNonEmptyString(value) && value.length <= MAX_ID_LENGTH ? value : undefined;
}

/**
 * The status a refusal carries: no worker answered, so there is no HTTP status to report.
 *
 * Also how the background tells its own refusals from a worker's `4xx` when it logs one — the only
 * place a reason is ever read.
 */
export const REFUSED_STATUS = 0;

/**
 * A refusal, in the shape the widget already treats as a failed call.
 *
 * `embed.ts` reads `ok` and nothing else, so a refusal and an unreachable worker are the same event
 * to it: the pins on screen stay, and a note keeps its text. The reason is for whoever reads the
 * console, never for the widget.
 */
export function relayRefusal(reason: string): RelayResponse {
  return { ok: false, status: REFUSED_STATUS, body: reason };
}
