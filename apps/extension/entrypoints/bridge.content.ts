import {
  CHANNEL,
  type BridgeMessage,
  type RelayRequestMessage,
  parseBridgeMessage,
  parseRelayResponse,
  relayRefusal,
} from '../src/protocol.ts';
import { createApply } from '../src/bridge.ts';
import { readSite } from '../src/sites.ts';
import { BRIDGE_SCRIPT_FLAG } from '../src/page-api.ts';

/**
 * The half that can reach the browser, in the isolated world (SKG-534, SKG-596).
 *
 * It owns everything `page.content.ts` cannot touch — `browser.storage`, and the network relay of
 * SKG-596 — and it owns nothing about the widget. The split is the ticket's constraint held from
 * the other side: `packages/widget` is unchanged by this app, because the widget runs where it
 * always ran, in the page.
 *
 * **It carries the relay across and decides nothing about it.** Its own input is written by the
 * page, so the origin, the endpoint and the credential are all settled in the background, which the
 * page cannot reach. See `src/relay.ts`.
 */
export default defineContentScript({
  // Registered by `background.ts` for the origins somebody turned on, never declared. See
  // wxt.config.ts: an install-time `<all_urls>` is a permission a review tool should not ask for.
  registration: 'runtime',
  matches: [],
  runAt: 'document_idle',

  async main() {
    // A second copy of this file in a frame that already has one, which would apply every decision
    // twice. See `PAGE_SCRIPT_FLAG`; this is that guard on the isolated world's own global, where
    // no page can read or write it.
    const world = globalThis as { [BRIDGE_SCRIPT_FLAG]?: true };
    if (world[BRIDGE_SCRIPT_FLAG] === true) return;
    world[BRIDGE_SCRIPT_FLAG] = true;

    const origin = window.location.origin;

    const post = (message: BridgeMessage): void => {
      window.postMessage(message, window.location.origin);
    };

    const apply = createApply({ readSite: () => readSite(origin), post });

    /**
     * Every request is answered, refusals included.
     *
     * The caller in the page's world holds a promise per request, and the widget disables its send
     * button while one is in flight. A request that is silently dropped leaves a reviewer looking at
     * a dead button with a written note inside it, which is the one failure this widget cannot
     * afford. The timeout on the other side is the backstop; this is the ordinary path.
     */
    const relay = async (message: RelayRequestMessage): Promise<void> => {
      const answer = await browser.runtime.sendMessage(message).catch(() => undefined);

      post({
        channel: CHANNEL,
        kind: 'relay-response',
        id: message.id,
        // A service worker that was stopped mid-call, or an extension being updated underneath this
        // page. Parsed rather than trusted for the ordinary reason: it crossed a boundary.
        response: parseRelayResponse(answer) ?? relayRefusal('extension-unavailable'),
      });
    };

    // The main world may come up after this script has already decided, so it says when it is
    // listening and the decision is applied again. Cheap, and the alternative is a timeout that is
    // either too short on a slow page or wasted on a fast one.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;

      const message = parseBridgeMessage(event.data);
      if (message?.kind === 'ready') {
        void apply(true);

        return;
      }

      if (message?.kind === 'relay-request') void relay(message);
    });

    // The popup writes to storage rather than messaging tabs, so the switch reaches every open tab
    // of that origin, including the ones the popup was never opened on.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.sites !== undefined) void apply();
    });

    await apply();
  },
});
