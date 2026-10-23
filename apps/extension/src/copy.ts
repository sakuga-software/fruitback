import { CHANNEL, LEGACY_CHANNEL, type ReadyMessage } from './protocol.ts';

/**
 * One copy of Fruitback drives a page (FRU-397).
 *
 * Two copies can be installed in one browser: the one of the store and an unpacked one, or an old
 * one and a new one. Both put their two scripts in the same page, and both speak on
 * `window.postMessage`. Before this, the messages did not say which copy sent them: the page script
 * of a 0.1.0 obeyed the bridge of a 0.3.0, took its site of a workspace for a private one, and read
 * it with no session.
 *
 * - **The channel carries the version of the protocol.** A copy of before speaks on
 *   `LEGACY_CHANNEL`, and hears nothing on `CHANNEL`.
 * - **Each message carries the tag of its copy**, `copy`. The page script draws it at random for
 *   this page, and says it in its `ready` with a proof: a hash of the tag and of the address of its
 *   own copy (`chrome-extension://<id>/`, read from its own stack). The bridge takes the tag whose
 *   proof its own address gives, and hears nothing else. A tag is new on each page, so it names no
 *   installation to the page.
 * - **The page script that finds the page held by another copy steps aside**, and says so in its
 *   `ready` (`heldBy`), with the version of the other when it knows it. Its bridge answers the popup
 *   with it, and the popup asks for the other copy to be removed.
 *
 * None of this is access control: the page is on the channel, and can forge any of it (see
 * `protocol.ts`). What it stops is two copies of one product talking over each other.
 */

/** The address of a copy, in a line of a stack: the id on Chrome, a UUID on Firefox. */
const COPY_ADDRESS = /\b(?:chrome|moz|safari-web)-extension:\/\/([0-9A-Za-z-]+)\//;

/**
 * The address of the copy whose script made this stack, or `undefined`.
 *
 * The page script runs in the world of the page, with no `chrome.*`: it cannot ask for its own id.
 * Its stack names its file, `chrome-extension://<id>/content-scripts/page.js`, and that is what the
 * bridge reads with `runtime.getURL`. Measured on Chromium by `e2e/two-copies.spec.ts`.
 */
export function copyAddressOfStack(stack: string | undefined): string | undefined {
  return stack === undefined ? undefined : COPY_ADDRESS.exec(stack)?.[1];
}

/**
 * The proof that a tag was drawn by a page script of the copy at `address`: FNV-1a, 64 bits as two
 * halves. Not a secret: the page can read the address of the copy from a stack too. A hash rather
 * than the address itself, so that a message names no installation (a UUID of Firefox is drawn for
 * each one).
 */
export function proofOf(address: string, tag: string): string {
  const text = `${address}\n${tag}`;
  let low = 0x811c9dc5;
  let high = 0xcbf29ce4;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ code ^ (low >>> 16), 0x01000193) >>> 0;
  }

  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/** The longest tag a message carries: `randomId` draws 32 characters. */
const TAG_MAX = 64;

/** The tag of the copy that posted `data`, or `undefined`. */
export function tagOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { copy } = data as { copy?: unknown };

  return typeof copy === 'string' && copy !== '' && copy.length <= TAG_MAX ? copy : undefined;
}

/** What a copy knows of another copy on its page. `version` only when the other said it. */
export type OtherCopy = { version?: string };

/**
 * What the page script that holds the page leaves on `window`, beside the flag of before. A second
 * page script of the same copy recognises its own copy by the proof; a page script of another copy
 * reads the version.
 */
export type PageHolder = { tag: string; proof?: string; version?: string };

/** Who holds this page, for a page script that starts on it. */
export function holderOf(
  flag: unknown,
  holder: PageHolder | undefined,
  address: string | undefined,
): 'free' | 'mine' | OtherCopy {
  if (flag !== true) return 'free';
  // A copy of before sets the flag and nothing else.
  if (holder === undefined) return {};
  // With no address on either side, nothing tells two copies apart: one step aside, as before.
  if (address === undefined || holder.proof === undefined) return 'mine';
  if (proofOf(address, holder.tag) === holder.proof) return 'mine';

  return holder.version === undefined ? {} : { version: holder.version };
}

/** The bridge's half: which tag it takes, and what it saw of the other copies. */
export type Pairing = {
  /** The tag of the page script of this copy, once its `ready` came. */
  tag(): string | undefined;
  /** The other copy on this page, when one was seen. */
  other(): OtherCopy | undefined;
  /** Whether the page script of this copy stepped aside for another one. */
  steppedAside(): boolean;
  /**
   * Reads one message of the window. `paired`: the `ready` of the page script of this copy, which the
   * bridge answers with its decision. `ours`: another message of this copy. `foreign`: nothing to do.
   */
  read(data: unknown, ready: ReadyMessage | undefined): 'paired' | 'ours' | 'foreign';
};

/**
 * `address` is the bridge's own, from `runtime.getURL('/')`.
 *
 * A `ready` with no proof is a page script that could not read its own address: taken while no
 * proven one came, so a browser whose stack names no file mounts as before. A proven `ready` takes
 * the place of one that was not.
 */
export function createPairing(address: string): Pairing {
  let tag: string | undefined;
  let proven = false;
  let other: OtherCopy | undefined;
  let aside = false;

  const sawOther = (seen: OtherCopy): void => {
    // A version said wins over none.
    if (other === undefined || (other.version === undefined && seen.version !== undefined)) other = seen;
  };

  return {
    tag: () => tag,
    other: () => other,
    steppedAside: () => aside,
    read(data, ready) {
      if (typeof data !== 'object' || data === null) return 'foreign';
      const { channel } = data as { channel?: unknown };
      // A copy of before, which carries no tag. Our own wake-up call to them is not one.
      if (channel === LEGACY_CHANNEL) {
        if (!(data as { probe?: unknown }).probe) sawOther({});

        return 'foreign';
      }
      if (channel !== CHANNEL) return 'foreign';
      const copy = tagOf(data);
      if (copy === undefined) return 'foreign';

      if (ready !== undefined) {
        const proof = ready.proof;
        if (copy !== tag) {
          if (proof !== undefined && proof !== proofOf(address, copy)) {
            // The page script of another copy: it says its version in its `ready`.
            sawOther(ready.version === undefined ? {} : { version: ready.version });

            return 'foreign';
          }
          // No proof: taken only while no proven `ready` came.
          if (proof === undefined && proven) return 'foreign';
          tag = copy;
          proven = proof !== undefined;
        }
        if (ready.heldBy !== undefined) {
          aside = true;
          sawOther(ready.heldBy);
        }

        return 'paired';
      }

      if (copy === tag) return 'ours';
      // The bridge or the page script of another copy of this protocol.
      if (tag !== undefined) sawOther({});

      return 'foreign';
    },
  };
}
