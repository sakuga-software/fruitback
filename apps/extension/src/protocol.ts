/**
 * What the two worlds say to each other (SKG-534).
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
 * An identity token (SKG-498) is a secret, which is why none is sent: SKG-535 gives the main world a
 * relay through the isolated script instead.
 */

import { isWorkerEndpoint } from './endpoint.ts';

export const CHANNEL = 'fruitback-extension';

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

export type BridgeMessage = MountMessage | UnmountMessage | ReadyMessage;

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
