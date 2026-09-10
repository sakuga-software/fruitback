import { CHANNEL, type BridgeMessage, parseBridgeMessage } from '../src/protocol.ts';
import { readSite } from '../src/sites.ts';

/**
 * The half that can reach the browser, in the isolated world (SKG-534).
 *
 * It owns everything `page.content.ts` cannot touch — `browser.storage`, and later the network relay
 * of SKG-535 — and it owns nothing about the widget. The split is the ticket's constraint held from
 * the other side: `packages/widget` is unchanged by this app, because the widget runs where it
 * always ran, in the page.
 */
export default defineContentScript({
  // Registered by `background.ts` for the origins somebody turned on, never declared. See
  // wxt.config.ts: an install-time `<all_urls>` is a permission a review tool should not ask for.
  registration: 'runtime',
  matches: [],
  runAt: 'document_idle',

  async main() {
    const origin = window.location.origin;

    const post = (message: BridgeMessage): void => {
      window.postMessage(message, window.location.origin);
    };

    // What was last posted, so an unchanged decision is not posted again.
    //
    // **This is what protects a half-written note.** `writeSite` stores the whole map under one key,
    // so any change fires `storage.onChanged` in every tab of every enabled origin — turning site B
    // on from the popup reaches the tab open on site A. A re-posted `mount` makes the page world
    // destroy and rebuild the widget, which closes the composer and loses what the reviewer was
    // typing. Losing that is the one failure this widget cannot afford, so the guard is here rather
    // than in the page world, where the message has already been treated as a config change.
    // Raised in review.
    let posted: string | undefined;

    const apply = async (force = false): Promise<void> => {
      const site = await readSite(origin);

      const message: BridgeMessage =
        site === undefined || !site.enabled
          ? { channel: CHANNEL, kind: 'unmount' }
          : {
              channel: CHANNEL,
              kind: 'mount',
              endpoint: site.endpoint,
              clientId: site.clientId,
              ...(site.label !== undefined ? { label: site.label } : {}),
            };

      const signature = JSON.stringify(message);
      // `force` is for the handshake: the page world says it is listening, and it may have missed
      // the message that carries this same decision.
      if (!force && signature === posted) return;

      posted = signature;
      post(message);
    };

    // The main world may come up after this script has already decided, so it says when it is
    // listening and the decision is applied again. Cheap, and the alternative is a timeout that is
    // either too short on a slow page or wasted on a fast one.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (parseBridgeMessage(event.data)?.kind !== 'ready') return;

      void apply(true);
    });

    // The popup writes to storage rather than messaging tabs, so the switch reaches every open tab
    // of that origin, including the ones the popup was never opened on.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.sites !== undefined) void apply();
    });

    await apply();
  },
});
