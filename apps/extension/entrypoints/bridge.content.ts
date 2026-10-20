import {
  CHANNEL,
  type BridgeMessage,
  type RelayRequestMessage,
  parseBridgeMessage,
  parseRelayResponse,
  relayRefusal,
} from '../src/protocol.ts';
import { createApply } from '../src/bridge.ts';
import { cloudEndpoint, wantsSession } from '../src/popup-state.ts';
import { createSessionArea, touchesARefreshToken } from '../src/session-storage.ts';
import { SIGN_IN_REQUEST } from '../src/sign-in-request.ts';
import { readSite } from '../src/sites.ts';
import { LANGUAGE_KEY, storedLanguage } from '../src/language.ts';
import { BRIDGE_SCRIPT_FLAG } from '../src/page-api.ts';
import { randomId } from '../src/relay-transport.ts';
import { PANEL_EVENT_TYPE, type TabCommandAnswer, acceptedRequest, commandTimeout } from '../src/tab-command.ts';

/**
 * The half that can reach the browser, in the isolated world (FRU-41, FRU-57).
 *
 * It owns everything `page.content.ts` cannot touch — `browser.storage`, and the network relay of
 * FRU-57 — and it owns nothing about the widget. The split is the ticket's constraint held from
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

    // FRU-315: whether the site wants a session this browser does not hold. Read, never written, and
    // in `storage.local` alone, with the epoch rule of every reader: `storage.session` is closed to
    // content scripts, and the upgrade of the areas is the background's. Only the endpoints that hold
    // a session are kept here: the widget is told yes or no, never anything of the session.
    const cloud = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);
    const sessions = createSessionArea(() => browser.storage.local, Promise.resolve());
    const apply = createApply({
      readSite: () => readSite(origin),
      readLanguage: () => storedLanguage(browser.storage.local),
      readSignedOut: async (site) => {
        const held = Object.fromEntries(Object.keys(await sessions.read()).map((endpoint) => [endpoint, true]));

        return wantsSession(site, cloud, held);
      },
      post,
    });

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

      // FRU-315: the widget asks for the sign-in. The background decides whether to open anything.
      if (message?.kind === 'sign-in') {
        void browser.runtime.sendMessage(SIGN_IN_REQUEST).catch(() => undefined);

        return;
      }

      if (message?.kind === 'command-response') {
        commands.get(message.id)?.({
          done: message.done,
          ...(message.busy === true ? { busy: true as const } : {}),
          ...(message.counts === undefined ? {} : { counts: message.counts }),
          ...(message.notes === undefined ? {} : { notes: message.notes }),
          ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
          ...(message.reading === undefined ? {} : { reading: message.reading }),
        });
        commands.delete(message.id);

        return;
      }

      // FRU-299: the notes of the widget changed, or a note was opened on the page. The side panel
      // of this window, if one is open, asks for the notes again; nothing else listens.
      if (message?.kind === 'notes-changed') {
        void browser.runtime
          .sendMessage({ type: PANEL_EVENT_TYPE, ...(message.open === undefined ? {} : { open: message.open }) })
          .catch(() => undefined);

        return;
      }

      if (message?.kind === 'relay-request') void relay(message);
      // FRU-44: carried across, and answered whatever happens, as a relay is.
      if (message?.kind === 'capture-request') {
        void browser.runtime
          .sendMessage(message)
          .catch(() => undefined)
          .then((answer: unknown) => {
            const parsed = parseBridgeMessage({
              ...(typeof answer === 'object' ? answer : {}),
              channel: CHANNEL,
              kind: 'capture-response',
              id: message.id,
            });
            post(
              parsed?.kind === 'capture-response'
                ? parsed
                : { channel: CHANNEL, kind: 'capture-response', id: message.id },
            );
          });
      }
    });

    /** The commands of the popup posted to the main world and not answered yet (FRU-254). */
    const commands = new Map<string, (answer: TabCommandAnswer) => void>();

    // FRU-254: « Leave feedback », « Show every note of the page », and the counts of « On this
    // page ». Taken from a page of this extension only: see `acceptedCommand`.
    browser.runtime.onMessage.addListener((message: unknown, sender) => {
      const request = acceptedRequest(message, sender, browser.runtime.id, browser.runtime.getURL('/'));
      if (request === undefined) return undefined;

      return new Promise<TabCommandAnswer>((resolve) => {
        const id = randomId(window);
        const timer = setTimeout(() => {
          commands.delete(id);
          resolve({ done: false });
        }, commandTimeout(request.command));
        commands.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        post({ channel: CHANNEL, kind: 'command', id, ...request });
      });
    });

    // The popup writes to storage rather than messaging tabs, so the switch reaches every open tab
    // of that origin, including the ones the popup was never opened on.
    browser.storage.onChanged.addListener((changes, area) => {
      // A session that starts or ends is a change of what the widget offers (FRU-315).
      const keys = Object.keys(changes);
      if (
        area === 'local' &&
        (changes.sites !== undefined || changes[LANGUAGE_KEY] !== undefined || touchesARefreshToken(keys))
      ) {
        void apply();
      }
    });

    await apply();
  },
});
