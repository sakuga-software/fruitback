import { CHANNEL, type MountMessage, parseBridgeMessage } from '../src/protocol.ts';
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

    const post = (message: MountMessage | { channel: typeof CHANNEL; kind: 'unmount' }): void => {
      window.postMessage(message, window.location.origin);
    };

    const apply = async (): Promise<void> => {
      const site = await readSite(origin);

      if (site === undefined || !site.enabled) {
        post({ channel: CHANNEL, kind: 'unmount' });

        return;
      }

      post({
        channel: CHANNEL,
        kind: 'mount',
        endpoint: site.endpoint,
        clientId: site.clientId,
        ...(site.label !== undefined ? { label: site.label } : {}),
      });
    };

    // The main world may come up after this script has already decided, so it says when it is
    // listening and the decision is applied again. Cheap, and the alternative is a timeout that is
    // either too short on a slow page or wasted on a fast one.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (parseBridgeMessage(event.data)?.kind !== 'ready') return;

      void apply();
    });

    // The popup writes to storage rather than messaging tabs, so the switch reaches every open tab
    // of that origin, including the ones the popup was never opened on.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.sites !== undefined) void apply();
    });

    await apply();
  },
});
