import { init } from '@fruitback/widget';
import {
  CHANNEL,
  type BridgeMessage,
  type CaptureResponseMessage,
  type SiteNotesResponseMessage,
  parseBridgeMessage,
} from '../src/protocol.ts';
import { createRelayTransport, randomId } from '../src/relay-transport.ts';
import { captureOfAnswer } from '../src/capture-answer.ts';
import {
  EXTENSION_API_VERSION,
  EXTENSION_EVENT,
  EXTENSION_GLOBAL,
  PAGE_HOLDER,
  PAGE_SCRIPT_FLAG,
  type FruitbackExtensionApi,
} from '../src/page-api.ts';
import { copyAddressOfStack, holderOf, proofOf, tagOf } from '../src/copy.ts';
import { version as VERSION } from '../package.json';

/**
 * The page's own world, which mounts the widget in private mode and announces itself in team mode
 * (FRU-41, FRU-57).
 *
 * **`world: 'MAIN'` is not a preference here, it is the ticket.** A content script in the isolated
 * world shares the DOM but not the properties page scripts put on it, and everything that gives a
 * note its `source` is exactly that: `readReactSource` finds the fiber under a `__reactFiber$…` key,
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
/**
 * How long the widget waits for a capture before it says that the capture was not taken. A capture
 * can wait for the answer to a prompt of permission, then a crop and a JPEG of a large screen: ten
 * seconds was too short for that (balanced review of #433). A late answer finds no request and is
 * dropped.
 */
const CAPTURE_TIMEOUT_MS = 30_000;
/** As long as a read of the side panel may take, and a little more for the two hops (FRU-470). */
const SITE_NOTES_TIMEOUT_MS = 15_000;

export default defineContentScript({
  // Registered by `background.ts` for the origins somebody turned on, never declared. See
  // wxt.config.ts: an install-time `<all_urls>` is a permission a review tool should not ask for.
  registration: 'runtime',
  matches: [],
  world: 'MAIN',
  runAt: 'document_idle',

  main() {
    // FRU-397: the tag of this copy on this page, and the proof that this copy drew it. See `copy.ts`.
    const address = copyAddressOfStack(new Error().stack);
    const tag = randomId(window);
    const proof = address === undefined ? undefined : proofOf(address, tag);
    const post = (message: Record<string, unknown>): void => window.postMessage({ ...message, copy: tag }, '*');
    const ready = (heldBy?: { version?: string }): void =>
      post({
        channel: CHANNEL,
        kind: 'ready',
        ...(proof === undefined ? {} : { proof }),
        version: VERSION,
        ...(heldBy === undefined ? {} : { heldBy }),
      });

    // A second copy of this file in a window that already has one (see `PAGE_SCRIPT_FLAG`), or the
    // page script of another copy of Fruitback (FRU-397). The second steps aside without a word; for
    // the other, it says to its bridge who holds the page, and does nothing else: one copy drives a
    // page, and nothing of this one can stop the other.
    const holder = holderOf(window[PAGE_SCRIPT_FLAG], window[PAGE_HOLDER], address);
    if (holder === 'mine') return;
    if (holder !== 'free') {
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        if (parseBridgeMessage(event.data)?.kind === 'hello') ready(holder);
      });
      ready(holder);

      return;
    }
    // `true` stays, for the copies of before: they step aside on it.
    window[PAGE_SCRIPT_FLAG] = true;
    window[PAGE_HOLDER] = { tag, ...(proof === undefined ? {} : { proof }), version: VERSION };

    let widget: ReturnType<typeof init> | undefined;
    /** The captures asked for and not answered yet, by the id of the request (FRU-44). */
    const pictures = new Map<string, (answer: CaptureResponseMessage) => void>();

    /**
     * A capture of the visible page, or of an area of it, taken by the background (FRU-332): see
     * `src/capture.ts`. Nothing comes back in thirty seconds, or the background could not take it: the
     * composer says that the capture was not taken, and the note stays. A capture over the limit of
     * the worker comes back as a file of its size and no bytes: the composer says it is too large.
     */
    const captureVisible = (area?: {
      left: number;
      top: number;
      width: number;
      height: number;
      scale: number;
    }): Promise<CaptureResponseMessage['picture']> =>
      new Promise((resolve, reject) => {
        const id = randomId(window);
        const timer = setTimeout(() => {
          pictures.delete(id);
          resolve(undefined);
        }, CAPTURE_TIMEOUT_MS);
        pictures.set(id, (answer) => {
          clearTimeout(timer);
          // FRU-423: a refusal for want of a gesture rejects, and the composer says to click the icon.
          try {
            resolve(captureOfAnswer(answer));
          } catch (error) {
            reject(error);
          }
        });
        post({
          channel: CHANNEL,
          kind: 'capture-request',
          id,
          ...(area === undefined ? {} : { area }),
        });
      });
    /** The reads of « All pages » asked for and not answered yet, by the id of the request (FRU-470). */
    const siteReads = new Map<string, (answer: SiteNotesResponseMessage['read']) => void>();

    /**
     * « All pages » of the list (FRU-470): one page of the notes of the site, read by the background
     * with the session of the reviewer (`src/site-notes-relay.ts`). Nothing comes back in fifteen
     * seconds: the list says that the notes could not be read, and offers « Try again ».
     */
    const siteNotes = (query: { q?: string; cursor?: string }): Promise<SiteNotesResponseMessage['read']> =>
      new Promise((resolve) => {
        const id = randomId(window);
        const timer = setTimeout(() => {
          siteReads.delete(id);
          resolve({ ok: false, reason: 'failed' });
        }, SITE_NOTES_TIMEOUT_MS);
        siteReads.set(id, (read) => {
          clearTimeout(timer);
          resolve(read);
        });
        post({ channel: CHANNEL, kind: 'site-notes-request', id, query });
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
      // FRU-332: for the widget of a site of a workspace, as for the one this script mounts.
      captureVisible,
      transport: createRelayTransport({
        // Same target as the handshake below. The request is the page's own call, and the token it
        // comes back with is attached in the background, so nothing secret travels here.
        post: (message) => post(message),
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
      // The bridge of this copy asks for `ready`: the bridge of another copy is answered too, and
      // takes nothing from it (FRU-397).
      if (message.kind === 'hello') {
        ready();

        return;
      }
      // Only the bridge of this copy is heard.
      if (tagOf(event.data) !== tag) return;

      // Our own handshake and our own relay requests, which `postMessage` delivers back to this
      // window like any other. Ignored here rather than filtered at the source: the isolated world
      // answers both, and a listener that fell through would try to read a mount out of one.
      if (
        message.kind === 'ready' ||
        message.kind === 'relay-request' ||
        message.kind === 'capture-request' ||
        message.kind === 'site-notes-request' ||
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

      // FRU-349: « Show CSS selectors » of the preferences. Only our widget hears it.
      if (message.kind === 'selectors') {
        widget?.showSelectors(message.shown);

        return;
      }

      // FRU-443: « Corner of the widget » of the preferences. Only our widget hears it, and it moves
      // with no new widget: a note being written stays.
      if (message.kind === 'dock') {
        widget?.moveDock(message.position);

        return;
      }

      // FRU-254: the popup, through the isolated world. Only the widget this script mounted obeys:
      // a site's own widget (team mode) is the site's.
      if (message.kind === 'command') {
        let done = false;
        let counts: ReturnType<NonNullable<typeof widget>['pageCounts']>;
        if (widget !== undefined && message.command === 'leave-feedback') done = widget.leaveFeedback();
        // FRU-423: the context menu granted `activeTab`; the capture of an area, or a note.
        if (widget !== undefined && message.command === 'capture-area') done = widget.captureArea();
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
        // FRU-307: « Show pins on the page » of the side panel.
        if (widget !== undefined && (message.command === 'hide-pins' || message.command === 'show-pins')) {
          widget.showPins(message.command === 'show-pins');
          done = true;
        }
        const answer = (outcome?: string): void =>
          post({
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
          });
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
        pictures.get(message.id)?.(message);
        pictures.delete(message.id);

        return;
      }

      if (message.kind === 'site-notes-response') {
        siteReads.get(message.id)?.(message.read);
        siteReads.delete(message.id);

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
      // FRU-302: the suggested name is not part of it, as in the bridge: it fills the next composer.
      const signature = JSON.stringify({ ...message, name: undefined });
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
        ...(message.relay === true ? { onSignIn: () => post({ channel: CHANNEL, kind: 'sign-in' }) } : {}),
        // FRU-332: the capture of the page or of an area, for a site of a workspace: the files of a
        // note go through the relay, with the session. The picture of the element of FRU-44 is gone.
        ...(message.relay === true ? { captureVisible } : {}),
        // FRU-470: « All pages » of the list, read with the session of the reviewer, for a site of a
        // workspace only. With no relay there is no session here, and the list has « This page » alone.
        ...(message.relay === true ? { siteNotes } : {}),
        // FRU-302: « Name on my notes », for a reporter who kept none on this site.
        ...(message.name !== undefined ? { reporterName: message.name } : {}),
        // FRU-411: the head of the composer writes the selector only with « Show CSS selectors ».
        selectorInHead: 'with-selectors',
      });
      mounted = signature;
      // FRU-299: the side panel asks for the notes again when they change, and opens the row of a
      // note opened on the page. Stopped with the widget, by `destroy`.
      widget.watchNotes((change) =>
        post({ channel: CHANNEL, kind: 'notes-changed', ...(change.kind === 'open' ? { open: change.id } : {}) }),
      );
    });

    // The isolated script may have decided before this listener existed — it has no way to know when
    // the page's world is ready — so ask rather than wait to be told.
    ready();
  },
});
