import { CHANNEL, type BridgeMessage } from './protocol.ts';
import type { SiteConfig } from './sites.ts';

/**
 * What the isolated world posts to the page world, and — more to the point — when it stays quiet.
 *
 * Extracted from `bridge.content.ts` so the two guards below run under `node --test`: an entrypoint
 * binds `browser` and `window` at import, and a guard nothing exercises is a guard nobody can trust.
 * The entrypoint keeps the event wiring and hands this its two seams.
 */
export type BridgeSeams = {
  readSite: () => Promise<SiteConfig | undefined>;
  /** The language of the reviewer's account, if the extension knows one (FRU-131). */
  readLanguage?: () => Promise<string | undefined>;
  /**
   * Whether this site wants a session it does not have (FRU-315): a site of the workspace of this
   * build's Fruitback, with no session for it. Asked for a widget we mount through the relay only.
   */
  readSignedOut?: (site: SiteConfig) => Promise<boolean>;
  post: (message: BridgeMessage) => void;
};

export function createApply({
  readSite,
  readLanguage,
  readSignedOut,
  post,
}: BridgeSeams): (force?: boolean) => Promise<void> {
  // What was last posted, so an unchanged decision is not posted again.
  //
  // **This is what protects a half-written note.** `writeSite` stores the whole map under one key,
  // so any change fires `storage.onChanged` in every tab of every enabled origin — turning site B on
  // from the popup reaches the tab open on site A. A re-posted `mount` makes the page world destroy
  // and rebuild the widget, which closes the composer and loses what the reviewer was typing. Losing
  // that is the one failure this widget cannot afford, so the guard is here rather than in the page
  // world, where the message has already been treated as a config change. Raised in review.
  let posted: string | undefined;
  /** The session last said, so a change of storage that is not one of the session says nothing. */
  let said: boolean | undefined;

  // Three sources call this, and it awaits in the middle: the first run, the page world's handshake,
  // and every storage change. So two can be in flight, and the older one can resolve last and post a
  // decision the newer one has already replaced — a site switched off that stays mounted. The
  // `posted` guard makes that stick rather than heal: the stale run writes its own signature, so the
  // next identical decision is suppressed as unchanged and nothing corrects it until an event
  // happens to differ. Raised in review.
  let generation = 0;

  return async (force = false): Promise<void> => {
    const mine = ++generation;
    const [site, locale] = await Promise.all([readSite(), readLanguage?.().catch(() => undefined)]);
    // FRU-315: said apart from the mount, so a session that ends or comes back changes what the
    // widget offers without building it again over a note being written.
    const message = decide(site, locale);
    const relayed =
      message.kind === 'mount' && message.relay === true && site !== undefined && readSignedOut !== undefined;
    const signedOut = relayed ? await readSignedOut(site).catch(() => false) : false;
    if (mine !== generation) return;

    // The language is part of the signature below. A change of language is a change of config: the
    // widget is built again, which closes an open composer, like a change of worker.
    const signature = JSON.stringify(message);
    // `force` is for the handshake: the page world says it is listening, and it may have missed the
    // message that carries this same decision.
    const mounting = force || signature !== posted;
    if (mounting) {
      posted = signature;
      post(message);
    }
    // After the mount, which builds the widget this message is for. A new widget starts signed in.
    if (relayed && (mounting || signedOut !== said)) {
      said = signedOut;
      post({ channel: CHANNEL, kind: 'session', signedOut });
    } else if (!relayed) {
      said = undefined;
    }
  };
}

/**
 * What this origin's entry means for the page's world.
 *
 * The mode is the whole difference between the two the extension serves: in `private` the widget is
 * ours and we mount it, in `team` the widget is the site's and we only say we are here (FRU-57).
 * Both go through the generation and unchanged-decision guards above, so team mode costs neither of
 * them a second implementation.
 */
function decide(site: SiteConfig | undefined, locale?: string): BridgeMessage {
  if (site === undefined || !site.enabled) return { channel: CHANNEL, kind: 'unmount' };
  if (site.mode === 'team') {
    if (site.mount === undefined) return { channel: CHANNEL, kind: 'announce' };

    // FRU-101: the site embeds nothing, so the widget is ours, and its calls go through the relay.
    return {
      channel: CHANNEL,
      kind: 'mount',
      endpoint: site.endpoint,
      clientId: site.mount.clientId,
      ...(locale !== undefined ? { locale } : {}),
      relay: true,
    };
  }

  return {
    channel: CHANNEL,
    kind: 'mount',
    endpoint: site.endpoint,
    clientId: site.clientId,
    ...(site.label !== undefined ? { label: site.label } : {}),
    ...(locale !== undefined ? { locale } : {}),
  };
}
