import {
  CHANNEL,
  LEGACY_CHANNEL,
  type BridgeMessage,
  NOTES_NAME_KEY,
  type RelayRequestMessage,
  SHOW_SELECTORS_KEY,
  DOCK_POSITION_KEY,
  parseBridgeMessage,
  parseDockPosition,
  parsePageSiteRead,
  parseRelayResponse,
  relayRefusal,
} from '../src/protocol.ts';
import { createApply } from '../src/bridge.ts';
import { HIDDEN_ORIGINS_KEY, isHidden } from '../src/page-visibility.ts';
import { cloudEndpoint, wantsSession } from '../src/popup-state.ts';
import { createSessionArea, touchesARefreshToken } from '../src/session-storage.ts';
import { SIGN_IN_REQUEST } from '../src/sign-in-request.ts';
import { readSite } from '../src/sites.ts';
import { LANGUAGE_KEY, storedLanguage } from '../src/language.ts';
import { BRIDGE_SCRIPT_FLAG } from '../src/page-api.ts';
import { randomId } from '../src/relay-transport.ts';
import { captureResponseOf } from '../src/capture-answer.ts';
import { createPairing } from '../src/copy.ts';
import {
  PANEL_EVENT_TYPE,
  type TabCommandAnswer,
  acceptedRequest,
  answerOf,
  commandTimeout,
} from '../src/tab-command.ts';

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

    // FRU-397: the page script of this copy, among the copies on this page. Nothing is posted to the
    // page until it said `ready`: a decision posted with no tag would be heard by none, or by all.
    const pairing = createPairing(new URL(browser.runtime.getURL('/')).host);
    const post = (message: BridgeMessage): void => {
      const tag = pairing.tag();
      if (tag === undefined) return;
      window.postMessage({ ...message, copy: tag }, window.location.origin);
    };
    let probed = false;

    // FRU-315: whether the site wants a session this browser does not hold. Read, never written, and
    // in `storage.local` alone, with the epoch rule of every reader: `storage.session` is closed to
    // content scripts, and the upgrade of the areas is the background's. Only the endpoints that hold
    // a session are kept here: the widget is told yes or no, never anything of the session.
    const cloud = cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD);
    const sessions = createSessionArea(() => browser.storage.local, Promise.resolve());
    const apply = createApply({
      readSite: () => readSite(origin),
      readLanguage: () => storedLanguage(browser.storage.local),
      // One key, read by name: never the whole area, which holds the refresh tokens (FRU-60).
      readName: async () => {
        const stored = (await browser.storage.local.get(NOTES_NAME_KEY))[NOTES_NAME_KEY];

        return typeof stored === 'string' ? stored : undefined;
      },
      readHidden: () => isHidden(browser.storage.local, origin),
      readDockPosition: async () =>
        parseDockPosition((await browser.storage.local.get(DOCK_POSITION_KEY))[DOCK_POSITION_KEY]),
      readShowSelectors: async () => (await browser.storage.local.get(SHOW_SELECTORS_KEY))[SHOW_SELECTORS_KEY] === true,
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
      const heard = pairing.read(event.data, message?.kind === 'ready' ? message : undefined);
      if (heard === 'paired') {
        // A copy of before stepped aside without a word, if this one came first: its bridge says its
        // decision again when asked, and that is how the popup learns it is there (FRU-397). Once,
        // and only from a page script that holds the page: one of before that holds it would build
        // its widget again.
        if (!probed && !pairing.steppedAside()) {
          probed = true;
          window.postMessage({ channel: LEGACY_CHANNEL, kind: 'ready', probe: true }, window.location.origin);
        }
        // Stepped aside: nothing on this page obeys this copy.
        if (!pairing.steppedAside()) void apply(true);

        return;
      }
      if (heard === 'foreign') return;

      // FRU-315: the widget asks for the sign-in. The background decides whether to open anything.
      if (message?.kind === 'sign-in') {
        void browser.runtime.sendMessage(SIGN_IN_REQUEST).catch(() => undefined);

        return;
      }

      if (message?.kind === 'command-response') {
        commands.get(message.id)?.(answerOf(message));
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
      // FRU-469: the side panel, asked in the click of the widget. Carried at once: the background
      // opens it before any `await`, and answers whether it did.
      if (message?.kind === 'open-panel-request') {
        void browser.runtime
          .sendMessage(message)
          .catch(() => undefined)
          .then((answer: unknown) =>
            post({
              channel: CHANNEL,
              kind: 'open-panel-response',
              id: message.id,
              opened: typeof answer === 'object' && answer !== null && (answer as { opened?: unknown }).opened === true,
            }),
          );
      }
      // FRU-470: « All pages », carried across and answered whatever happens, as a relay is.
      if (message?.kind === 'site-notes-request') {
        void browser.runtime
          .sendMessage(message)
          .catch(() => undefined)
          .then((answer: unknown) =>
            post({
              channel: CHANNEL,
              kind: 'site-notes-response',
              id: message.id,
              read: parsePageSiteRead(answer) ?? { ok: false, reason: 'failed' },
            }),
          );
      }
      // FRU-44: carried across, and answered whatever happens, as a relay is.
      if (message?.kind === 'capture-request') {
        void browser.runtime
          .sendMessage(message)
          .catch(() => undefined)
          .then((answer: unknown) => post(captureResponseOf(answer, message.id)));
      }
    });

    /** The commands of the popup posted to the main world and not answered yet (FRU-254). */
    const commands = new Map<string, (answer: TabCommandAnswer) => void>();

    // FRU-254: « Leave feedback », « Show every note of the page », and the counts of « On this
    // page ». Taken from a page of this extension only: see `acceptedCommand`.
    browser.runtime.onMessage.addListener((message: unknown, sender) => {
      const request = acceptedRequest(message, sender, browser.runtime.id, browser.runtime.getURL('/'));
      if (request === undefined) return undefined;

      // FRU-397: the page script of this copy stepped aside for another copy, which holds the page.
      const other = pairing.other();
      if (pairing.steppedAside()) return Promise.resolve<TabCommandAnswer>({ done: false, otherCopy: other ?? {} });
      const withOther = (answer: TabCommandAnswer): TabCommandAnswer => {
        const seen = pairing.other();

        return seen === undefined ? answer : { ...answer, otherCopy: seen };
      };

      return new Promise<TabCommandAnswer>((resolve) => {
        const id = randomId(window);
        const timer = setTimeout(() => {
          commands.delete(id);
          resolve(withOther({ done: false }));
        }, commandTimeout(request.command));
        commands.set(id, (answer) => {
          clearTimeout(timer);
          resolve(withOther(answer));
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
        (changes.sites !== undefined ||
          changes[LANGUAGE_KEY] !== undefined ||
          changes[SHOW_SELECTORS_KEY] !== undefined ||
          changes[HIDDEN_ORIGINS_KEY] !== undefined ||
          changes[DOCK_POSITION_KEY] !== undefined ||
          touchesARefreshToken(keys))
      ) {
        void apply();
      }
    });

    // The page script of this copy may have said `ready` before this listener existed.
    window.postMessage({ channel: CHANNEL, kind: 'hello' }, window.location.origin);
    await apply();
  },
});
