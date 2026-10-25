import type { DockPosition } from '@fruitback/widget';
import { CHANNEL, type BridgeMessage, NAME_MAX } from './protocol.ts';
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
  /** « Name on my notes » (FRU-302): given to a widget we mount in private mode. */
  readName?: () => Promise<string | undefined>;
  /** « Show CSS selectors » (FRU-349): said to a widget we mount, in either mode. */
  readShowSelectors?: () => Promise<boolean>;
  /**
   * « Show Fruitback on this page » turned off for this origin (FRU-444): the widget leaves the page,
   * and the rule stays on. A read that fails shows it.
   */
  readHidden?: () => Promise<boolean>;
  /** « Corner of the widget » (FRU-443): said to a widget we mount. `undefined`: the default corner. */
  readDockPosition?: () => Promise<DockPosition | undefined>;
  post: (message: BridgeMessage) => void;
};

export function createApply({
  readSite,
  readLanguage,
  readSignedOut,
  readName,
  readShowSelectors,
  readHidden,
  readDockPosition,
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
  /** « Show CSS selectors » as last said, for the same reason. */
  let selectorsSaid: boolean | undefined;
  /** The corner as last said, for the same reason. `null`: no widget to say it to. */
  let cornerSaid: DockPosition | undefined | null = null;

  // Three sources call this, and it awaits in the middle: the first run, the page world's handshake,
  // and every storage change. So two can be in flight, and the older one can resolve last and post a
  // decision the newer one has already replaced — a site switched off that stays mounted. The
  // `posted` guard makes that stick rather than heal: the stale run writes its own signature, so the
  // next identical decision is suppressed as unchanged and nothing corrects it until an event
  // happens to differ. Raised in review.
  let generation = 0;

  return async (force = false): Promise<void> => {
    const mine = ++generation;
    const [site, locale, name, selectors, hidden, corner] = await Promise.all([
      readSite(),
      readLanguage?.().catch(() => undefined),
      readName?.().catch(() => undefined),
      // A read that fails keeps what was said last: the selector is a help, never a reason to stop.
      readShowSelectors?.().catch(() => selectorsSaid ?? false),
      readHidden?.().catch(() => false),
      // A read that fails keeps the corner said last: a dock that jumps back is a dock that moved.
      readDockPosition?.().catch(() => (cornerSaid === null ? undefined : cornerSaid)),
    ]);
    // FRU-315: said apart from the mount, so a session that ends or comes back changes what the
    // widget offers without building it again over a note being written.
    const message = hidden === true ? ({ channel: CHANNEL, kind: 'unmount' } as const) : decide(site, locale, name);
    const relayed =
      message.kind === 'mount' && message.relay === true && site !== undefined && readSignedOut !== undefined;
    // A read of storage that fails keeps what was said last, and says why in the console: forcing
    // « signed in » would hide the sign-in from somebody whose session ended (review of #378).
    const signedOut = relayed
      ? await readSignedOut(site).catch((error: unknown) => {
          console.warn('[fruitback] could not read whether this site has a session', error);

          return said ?? false;
        })
      : false;
    if (mine !== generation) return;

    // The language is part of the signature below. A change of language is a change of config: the
    // widget is built again, which closes an open composer, like a change of worker.
    // FRU-302: the name is not part of it. It only fills the next composer, and a change of it must
    // not build the widget again over a note being written; the next mount takes it.
    const signature = JSON.stringify({ ...message, name: undefined });
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
    // FRU-349: after the mount, like the session, and again with each mount: the page world may keep
    // the widget it has for a mount it was told twice.
    if (message.kind === 'mount' && selectors !== undefined) {
      if (mounting || selectors !== selectorsSaid) post({ channel: CHANNEL, kind: 'selectors', shown: selectors });
      selectorsSaid = selectors;
    } else if (message.kind !== 'mount') {
      selectorsSaid = undefined;
    }
    // FRU-443: after the mount too, and again with each mount, like the selectors.
    if (message.kind === 'mount' && readDockPosition !== undefined) {
      if (mounting || corner !== cornerSaid) {
        post({ channel: CHANNEL, kind: 'dock', ...(corner === undefined ? {} : { position: corner }) });
      }
      cornerSaid = corner;
    } else if (message.kind !== 'mount') {
      cornerSaid = null;
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
function decide(site: SiteConfig | undefined, locale?: string, name?: string): BridgeMessage {
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
    // Private mode only: in team mode the session of the reviewer signs the note.
    ...(name !== undefined && name.trim() !== '' && name.length <= NAME_MAX ? { name: name.trim() } : {}),
  };
}
