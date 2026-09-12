import { init } from '@fruitback/widget';
import { CHANNEL, type BridgeMessage, parseBridgeMessage } from '../src/protocol.ts';
import { createRelayTransport } from '../src/relay-transport.ts';
import {
  EXTENSION_API_VERSION,
  EXTENSION_EVENT,
  EXTENSION_GLOBAL,
  type FruitbackExtensionApi,
} from '../src/page-api.ts';

/**
 * The page's own world, which mounts the widget in private mode and announces itself in team mode
 * (SKG-534, SKG-596).
 *
 * **`world: 'MAIN'` is not a preference here, it is the ticket.** A content script in the isolated
 * world shares the DOM but not the properties page scripts put on it, and everything that gives a
 * seed its `source` is exactly that: `readReactSource` finds the fiber under a `__reactFiber$…` key,
 * and react-grab scans `__reactContainer$` / `__reactInternalInstance$` and installs itself as
 * `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`. From the isolated world all of it is invisible and
 * the hook is installed on a global React never reads — so the widget would appear to work and
 * quietly never report which component a note is about.
 *
 * A content script rather than an injected `<script>` tag, and that is the second half of the same
 * decision: a tag pointing at an extension URL is evaluated in the page and **the page's CSP can
 * refuse it**, which is the trap the ticket names. A main-world content script is not subject to it,
 * registered at runtime or declared.
 *
 * The cost is that there is no `chrome.*` in here at all — hence the bridge, and hence the relay:
 * the transport this file hands the page posts a message, and the call is made where the token is.
 */
export default defineContentScript({
  // Registered by `background.ts` for the origins somebody turned on, never declared. See
  // wxt.config.ts: an install-time `<all_urls>` is a permission a review tool should not ask for.
  registration: 'runtime',
  matches: [],
  world: 'MAIN',
  runAt: 'document_idle',

  main() {
    let widget: ReturnType<typeof init> | undefined;
    const relayListeners: ((message: BridgeMessage) => void)[] = [];

    const api: FruitbackExtensionApi = {
      version: EXTENSION_API_VERSION,
      transport: createRelayTransport({
        // Same target as the handshake below. The request is the page's own call, and the token it
        // comes back with is attached in the background, so nothing secret travels here.
        post: (message) => window.postMessage(message, '*'),
        subscribe: (listener) => relayListeners.push(listener),
        newId: () => crypto.randomUUID(),
        setTimer: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);

          return () => clearTimeout(timer);
        },
      }),
    };

    // Announced once, however many times the decision is re-posted. The site mounts its widget when
    // the event fires, so a second event would give it a second widget.
    const announce = (): void => {
      if (window[EXTENSION_GLOBAL] === api) return;

      window[EXTENSION_GLOBAL] = api;
      window.dispatchEvent(new CustomEvent(EXTENSION_EVENT));
    };

    const withdraw = (): void => {
      if (window[EXTENSION_GLOBAL] === api) delete window[EXTENSION_GLOBAL];
    };

    window.addEventListener('message', (event: MessageEvent) => {
      // The page can post here too. Anything not from this window is not the bridge, and
      // `parseBridgeMessage` refuses everything that is not exactly a message we sent.
      if (event.source !== window) return;

      const message = parseBridgeMessage(event.data);
      if (message === undefined) return;

      // Our own handshake and our own relay requests, which `postMessage` delivers back to this
      // window like any other. Ignored here rather than filtered at the source: the isolated world
      // answers both, and a listener that fell through would try to read a mount out of one.
      if (message.kind === 'ready' || message.kind === 'relay-request') return;

      if (message.kind === 'relay-response') {
        for (const listener of relayListeners) listener(message);

        return;
      }

      if (message.kind === 'announce') {
        // Team mode mounts nothing: the widget on this page is the site's own.
        widget?.destroy();
        widget = undefined;
        announce();

        return;
      }

      if (message.kind === 'unmount') {
        widget?.destroy();
        widget = undefined;
        withdraw();

        return;
      }

      // Private mode. The transport goes away with the announcement, so the site's own widget — if
      // this page has one — cannot pick up a relay the reviewer's entry no longer allows.
      withdraw();
      // Mounting twice would put a second dock and a second set of pins on the page. A second mount
      // is a config change, so the old one goes first.
      widget?.destroy();
      widget = init({
        endpoint: message.endpoint,
        clientId: message.clientId,
        // Our own key, so the site's stored preferences cannot override where the extension routes.
        // The default key is global to the page, and a site that embeds the widget itself would
        // otherwise hand this instance its `endpoint` and `clientId` — the reviewer's notes going to
        // a worker nobody picked, with nothing on screen to say so. Raised in review.
        configKey: 'fruitback:config:extension',
        ...(message.label !== undefined ? { label: message.label } : {}),
      });
    });

    // The isolated script may have decided before this listener existed — it has no way to know when
    // the page's world is ready — so ask rather than wait to be told.
    window.postMessage({ channel: CHANNEL, kind: 'ready' }, '*');
  },
});
