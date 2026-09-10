import { init } from '@fruitback/widget';
import { CHANNEL, parseBridgeMessage } from '../src/protocol.ts';

/**
 * The widget itself, running in the page's own world (SKG-534).
 *
 * **`world: 'MAIN'` is not a preference here, it is the ticket.** A content script in the isolated
 * world shares the DOM but not the properties page scripts put on it, and everything that gives a
 * seed its `source` is exactly that: `readReactSource` finds the fiber under a `__reactFiber$…` key,
 * and react-grab scans `__reactContainer$` / `__reactInternalInstance$` and installs itself as
 * `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`. From the isolated world all of it is invisible and
 * the hook is installed on a global React never reads — so the widget would appear to work and
 * quietly never report which component a note is about.
 *
 * Declared in the manifest rather than injected as a `<script>` tag, and that is the second half of
 * the same decision: a tag pointing at an extension URL is evaluated in the page and **the page's
 * CSP can refuse it**, which is the trap the ticket names. A declared main-world content script is
 * not subject to it.
 *
 * The cost is that there is no `chrome.*` in here at all — hence the bridge.
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

    window.addEventListener('message', (event: MessageEvent) => {
      // The page can post here too. Anything not from this window is not the bridge, and
      // `parseBridgeMessage` refuses everything that is not exactly a message we sent.
      if (event.source !== window) return;

      const message = parseBridgeMessage(event.data);
      if (message === undefined) return;

      // Our own handshake, which `postMessage` delivers back to this window like any other. Ignored
      // here rather than filtered at the source: the isolated world answers it, and a listener that
      // fell through would try to read a mount out of it.
      if (message.kind === 'ready') return;

      if (message.kind === 'unmount') {
        widget?.destroy();
        widget = undefined;

        return;
      }

      // Mounting twice would put a second dock and a second set of pins on the page. A second mount
      // is a config change, so the old one goes first.
      widget?.destroy();
      widget = init({
        endpoint: message.endpoint,
        clientId: message.clientId,
        ...(message.label !== undefined ? { label: message.label } : {}),
      });
    });

    // The isolated script may have decided before this listener existed — it has no way to know when
    // the page's world is ready — so ask rather than wait to be told.
    window.postMessage({ channel: CHANNEL, kind: 'ready' }, '*');
  },
});
