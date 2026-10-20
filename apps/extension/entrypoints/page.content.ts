import { init } from '@fruitback/widget';
import { CHANNEL, type BridgeMessage, type CaptureResponseMessage, parseBridgeMessage } from '../src/protocol.ts';
import { createRelayTransport, randomId } from '../src/relay-transport.ts';
import {
  EXTENSION_API_VERSION,
  EXTENSION_EVENT,
  EXTENSION_GLOBAL,
  PAGE_SCRIPT_FLAG,
  type FruitbackExtensionApi,
} from '../src/page-api.ts';

/**
 * The page's own world, which mounts the widget in private mode and announces itself in team mode
 * (FRU-41, FRU-57).
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
/** How long the widget waits for a picture before it sends the note without one. */
const CAPTURE_TIMEOUT_MS = 10_000;

export default defineContentScript({
  // Registered by `background.ts` for the origins somebody turned on, never declared. See
  // wxt.config.ts: an install-time `<all_urls>` is a permission a review tool should not ask for.
  registration: 'runtime',
  matches: [],
  world: 'MAIN',
  runAt: 'document_idle',

  main() {
    // A second copy of this file in a window that already has one. See `PAGE_SCRIPT_FLAG`.
    if (window[PAGE_SCRIPT_FLAG] === true) return;
    window[PAGE_SCRIPT_FLAG] = true;

    let widget: ReturnType<typeof init> | undefined;
    /** The pictures asked for and not answered yet, by the id of the request (FRU-44). */
    const pictures = new Map<string, (picture: CaptureResponseMessage['picture']) => void>();

    /**
     * The picture of an element, taken by the background (FRU-44): see `src/capture.ts`. Nothing
     * comes back in ten seconds, or the background could not take it: no picture, and the note goes.
     */
    const captureScreenshot = (element: Element): Promise<CaptureResponseMessage['picture']> =>
      new Promise((resolve) => {
        const id = randomId(window);
        const box = element.getBoundingClientRect();
        const timer = setTimeout(() => {
          pictures.delete(id);
          resolve(undefined);
        }, CAPTURE_TIMEOUT_MS);
        pictures.set(id, (picture) => {
          clearTimeout(timer);
          resolve(picture);
        });
        window.postMessage(
          {
            channel: CHANNEL,
            kind: 'capture-request',
            id,
            area: {
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              scale: window.devicePixelRatio,
            },
          },
          '*',
        );
      });
    /**
     * The mount that built `widget`, as it was posted (FRU-186).
     *
     * The isolated world posts its decision when it starts, and posts it again when this world says
     * it is ready. When both reach this listener, the second one is the same mount. Building the
     * widget again for it closed a composer the reviewer had just opened, and lost the note: measured
     * on CI, where the second message came after the click (`extension.spec.ts`, private mode). A
     * page can post `ready` too, and gets the same answer. Only a mount that differs builds again.
     */
    let mounted: string | undefined;
    const relayListeners: ((message: BridgeMessage) => void)[] = [];

    const api: FruitbackExtensionApi = {
      version: EXTENSION_API_VERSION,
      transport: createRelayTransport({
        // Same target as the handshake below. The request is the page's own call, and the token it
        // comes back with is attached in the background, so nothing secret travels here.
        post: (message) => window.postMessage(message, '*'),
        subscribe: (listener) => relayListeners.push(listener),
        newId: () => randomId(window),
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

    /**
     * Taken back, and said out loud.
     *
     * In team mode the widget belongs to the site, so nothing here can destroy it. Without this
     * event a reviewer who switches the site off — or to private mode — leaves the site's widget on
     * screen with a transport every call is now refused for: stale pins, and a composer that fails
     * silently. The site is told and destroys its own, which is the same event it mounted on.
     * Raised in review.
     */
    const withdraw = (): void => {
      if (window[EXTENSION_GLOBAL] !== api) return;

      delete window[EXTENSION_GLOBAL];
      window.dispatchEvent(new CustomEvent(EXTENSION_EVENT));
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
      if (
        message.kind === 'ready' ||
        message.kind === 'relay-request' ||
        message.kind === 'capture-request' ||
        message.kind === 'command-response' ||
        message.kind === 'sign-in' ||
        message.kind === 'notes-changed'
      ) {
        return;
      }

      // FRU-315: the session of the reviewer for this site ended, or is back. Only our widget hears it.
      if (message.kind === 'session') {
        widget?.signedOut(message.signedOut);

        return;
      }

      // FRU-254: the popup, through the isolated world. Only the widget this script mounted obeys:
      // a site's own widget (team mode) is the site's.
      if (message.kind === 'command') {
        let done = false;
        let counts: ReturnType<NonNullable<typeof widget>['pageCounts']>;
        if (widget !== undefined && message.command === 'leave-feedback') done = widget.leaveFeedback();
        if (widget !== undefined && message.command === 'show-notes') {
          widget.showEveryNote();
          done = true;
        }
        if (widget !== undefined && message.command === 'counts') {
          counts = widget.pageCounts();
          done = counts !== undefined;
        }
        // FRU-299: the side panel. The notes the pins show, a note shown on the page, a reply.
        let notes: ReturnType<NonNullable<typeof widget>['pageNotes']>;
        let reading: string | undefined;
        if (message.command === 'notes') {
          notes = widget?.pageNotes();
          done = notes !== undefined;
          // Why there are none, for the panel to say it rather than wait (raised in review).
          if (notes === undefined) reading = widget === undefined ? 'no-widget' : widget.notesState();
        }
        if (widget !== undefined && message.command === 'reread') {
          void widget.refresh();
          done = true;
        }
        if (widget !== undefined && message.command === 'focus-note' && message.note !== undefined) {
          done = widget.focusNote(message.note);
        }
        if (widget !== undefined && message.command === 'mark-note') done = widget.markNote(message.note);
        const answer = (outcome?: string): void =>
          window.postMessage(
            {
              channel: CHANNEL,
              kind: 'command-response',
              id: message.id,
              done,
              // The widget is ours and said no to a choice: somebody writes a note.
              ...(!done && widget !== undefined && message.command === 'leave-feedback' ? { busy: true } : {}),
              ...(counts === undefined ? {} : { counts }),
              ...(notes === undefined ? {} : { notes }),
              ...(outcome === undefined ? {} : { outcome }),
              ...(reading === undefined ? {} : { reading }),
            },
            '*',
          );
        // FRU-300: « Looks fixed » / « Still wrong », by the widget's transport (the relay in team mode).
        if (
          widget !== undefined &&
          message.command === 'check' &&
          message.note !== undefined &&
          message.verdict !== undefined
        ) {
          // Answered whatever happens, a throw included, as a reply is.
          let checking: Promise<string>;
          try {
            checking = widget.checkNote(message.note, message.verdict);
          } catch {
            checking = Promise.resolve('retry');
          }
          void checking.then(
            (outcome) => {
              done = outcome === 'sent';
              answer(outcome);
            },
            () => answer('retry'),
          );

          return;
        }
        if (widget !== undefined && message.command === 'reply' && message.note !== undefined) {
          // Answered whatever happens, a throw included: the panel holds « Sending… » until it is.
          let sending: Promise<string>;
          try {
            sending = widget.replyTo(message.note, message.body ?? '');
          } catch {
            sending = Promise.resolve('retry');
          }
          void sending.then(
            (outcome) => {
              done = outcome === 'sent';
              answer(outcome);
            },
            () => answer('retry'),
          );

          return;
        }
        answer();

        return;
      }

      if (message.kind === 'relay-response') {
        for (const listener of relayListeners) listener(message);

        return;
      }

      if (message.kind === 'capture-response') {
        pictures.get(message.id)?.(message.picture);
        pictures.delete(message.id);

        return;
      }

      if (message.kind === 'announce') {
        // Team mode mounts nothing: the widget on this page is the site's own.
        widget?.destroy();
        widget = undefined;
        mounted = undefined;
        announce();

        return;
      }

      if (message.kind === 'unmount') {
        widget?.destroy();
        widget = undefined;
        mounted = undefined;
        withdraw();

        return;
      }

      // The same decision, posted again: the widget on screen is already this one.
      const signature = JSON.stringify(message);
      if (widget !== undefined && signature === mounted) return;

      // Private mode. The transport goes away with the announcement, so the site's own widget — if
      // this page has one — cannot pick up a relay the reviewer's entry no longer allows.
      withdraw();
      // Mounting twice would put a second dock and a second set of pins on the page. A second mount
      // is a config change, so the old one goes first.
      widget?.destroy();
      // Forgotten until `init` returns: a mount that threw is tried again when it is posted again.
      widget = undefined;
      mounted = undefined;
      widget = init({
        endpoint: message.endpoint,
        clientId: message.clientId,
        // Our own key, so the site's stored preferences cannot override where the extension routes.
        // The default key is global to the page, and a site that embeds the widget itself would
        // otherwise hand this instance its `endpoint` and `clientId` — the reviewer's notes going to
        // a worker nobody picked, with nothing on screen to say so. Raised in review.
        configKey: 'fruitback:config:extension',
        ...(message.label !== undefined ? { label: message.label } : {}),
        // The language of the reviewer's account. Left out, the widget reads the page's own.
        ...(message.locale !== undefined ? { locale: message.locale } : {}),
        // FRU-101: a site of a workspace, read and written through the reviewer's session. The
        // background relays only for a site its own storage says is in team mode. With no relay, the
        // reviewer has no session here, and the rule of FRU-257 gives them no field to reply: the
        // worker cannot tell them from a visitor of the site.
        ...(message.relay === true ? { transport: api.transport } : { replies: false }),
        // FRU-315: a site of a workspace can lose its session. The widget then offers the sign-in,
        // which the popup holds: the isolated world carries the ask to the background.
        ...(message.relay === true
          ? { onSignIn: () => window.postMessage({ channel: CHANNEL, kind: 'sign-in' }, '*') }
          : {}),
        // FRU-44: offered here, and off until the reviewer turns it on in the settings of the widget.
        captureScreenshot,
      });
      mounted = signature;
      // FRU-299: the side panel asks for the notes again when they change, and opens the row of a
      // note opened on the page. Stopped with the widget, by `destroy`.
      widget.watchNotes((change) =>
        window.postMessage(
          { channel: CHANNEL, kind: 'notes-changed', ...(change.kind === 'open' ? { open: change.id } : {}) },
          '*',
        ),
      );
    });

    // The isolated script may have decided before this listener existed — it has no way to know when
    // the page's world is ready — so ask rather than wait to be told.
    window.postMessage({ channel: CHANNEL, kind: 'ready' }, '*');
  },
});
