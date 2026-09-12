import { CHANNEL, type BridgeMessage, type RelayRequestMessage, type RelayResponse, relayRefusal } from './protocol.ts';
import type { FruitbackTransport } from '@fruitback/widget';

/**
 * The transport the page's dormant widget is handed, in the main world (SKG-596).
 *
 * It posts the request on the bridge and waits for the answer that carries the same `id`. Extracted
 * from `page.content.ts` so `node --test` can reach it: an entrypoint binds `window` at import, and
 * the three things that can go wrong here — the wrong answer, a late answer, two calls at once —
 * are invisible from the outside. Same split `bridge.ts` made for SKG-534.
 */
export type RelayTransportSeams = {
  post: (message: RelayRequestMessage) => void;
  subscribe: (listener: (message: BridgeMessage) => void) => void;
  newId: () => string;
  /** Runs `run` after `delayMs`, and answers with the function that cancels it. */
  setTimer: (run: () => void, delayMs: number) => () => void;
};

/**
 * How long a relayed call may take before it is called a failure.
 *
 * **A promise that never settles is the failure this constant exists for.** The composer disables
 * its send button while a submit is in flight, so a relay nobody answers leaves a reviewer looking
 * at a dead button with their note inside it — and losing a written note is the one failure this
 * widget cannot afford. Well past a slow worker on a slow connection, and far short of forever.
 */
export const RELAY_TIMEOUT_MS = 20 * 1_000;

export function createRelayTransport({ post, subscribe, newId, setTimer }: RelayTransportSeams): FruitbackTransport {
  const pending = new Map<string, (response: RelayResponse) => void>();

  // One listener for every call, and the `id` is what tells them apart. The widget reads and writes
  // independently, so two can be in flight, and a listener per call would make each of them see the
  // other's answer.
  subscribe((message) => {
    if (message.kind !== 'relay-response') return;

    const settle = pending.get(message.id);
    if (settle === undefined) return;

    pending.delete(message.id);
    settle(message.response);
  });

  return (request) =>
    new Promise<RelayResponse>((resolve) => {
      const id = newId();
      const cancel = setTimer(() => {
        pending.delete(id);
        resolve(relayRefusal('relay-timeout'));
      }, RELAY_TIMEOUT_MS);

      pending.set(id, (response) => {
        cancel();
        resolve(response);
      });

      post({ channel: CHANNEL, kind: 'relay-request', id, request });
    });
}
