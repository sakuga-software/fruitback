import {
  CHANNEL,
  RELAY_ANSWER_TIMEOUT_MS,
  type BridgeMessage,
  type RelayRequestMessage,
  type RelayResponse,
  relayRefusal,
} from './protocol.ts';
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
 * An id for one call, without needing a secure context.
 *
 * **`crypto.randomUUID` is secure-context only, and this script runs on `http://` too** — a staging
 * site on plain http is exactly the audience, and `registration.ts` registers there. Requiring it
 * would throw inside every call and leave team mode dead on those pages with nothing in a console
 * to explain it. `capture.ts` already carries this fallback for the seed id, and the same trap was
 * walked back into here. Raised in review.
 *
 * It only has to be unique among this page's own calls. The page shares the channel and can forge
 * an answer whatever the id, so there is nothing here for unpredictability to buy.
 */
export function randomId(view: RandomSource): string {
  const source = view.crypto;

  if (typeof source?.randomUUID === 'function') return source.randomUUID().replaceAll('-', '').slice(0, ID_LENGTH);

  if (typeof source?.getRandomValues === 'function') {
    return [...source.getRandomValues(new Uint8Array(ID_LENGTH / 2))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  // `Math.random().toString(16)` is not a fixed-width string — `0.5` prints as `0.8` — so the digits
  // are padded and accumulated rather than sliced out of one draw. Same shape as `capture.ts`.
  let hex = '';
  while (hex.length < ID_LENGTH) {
    hex += Math.floor(Math.random() * 0x1_0000)
      .toString(16)
      .padStart(4, '0');
  }

  return hex.slice(0, ID_LENGTH);
}

export type RandomSource = {
  crypto?: {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  };
};

/** Sixteen hex characters, and the same shape whichever branch above produced it. */
const ID_LENGTH = 16;

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
      }, RELAY_ANSWER_TIMEOUT_MS);

      pending.set(id, (response) => {
        cancel();
        resolve(response);
      });

      post({ channel: CHANNEL, kind: 'relay-request', id, request });
    });
}
