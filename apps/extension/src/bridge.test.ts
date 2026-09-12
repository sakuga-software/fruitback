import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApply } from './bridge.ts';
import { CHANNEL, type BridgeMessage } from './protocol.ts';
import type { SiteConfig } from './sites.ts';

const SITE: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true };
const TEAM_SITE: SiteConfig = { mode: 'team', endpoint: 'https://worker.test', enabled: true };
const MOUNT = { channel: CHANNEL, kind: 'mount', endpoint: 'https://worker.test', clientId: 'acme' };
const UNMOUNT = { channel: CHANNEL, kind: 'unmount' };
const ANNOUNCE = { channel: CHANNEL, kind: 'announce' };

/** A `readSite` whose answers are handed out on demand, so two reads can be in flight at once. */
function gated() {
  const waiting: ((site: SiteConfig | undefined) => void)[] = [];

  return {
    readSite: () => new Promise<SiteConfig | undefined>((resolve) => waiting.push(resolve)),
    answer(index: number, site: SiteConfig | undefined) {
      const resolve = waiting[index];
      assert.ok(resolve !== undefined, `no read is waiting at ${index}`);
      resolve(site);
    },
  };
}

describe('createApply', () => {
  it('posts a mount for a site that is on', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => SITE, post: (m) => void posts.push(m) })();

    assert.deepEqual(posts, [MOUNT]);
  });

  /**
   * Team mode mounts nothing, which is the whole of it (SKG-596). The site embeds its own widget, so
   * a mount here would put a second one beside it — and the client id this entry does not carry is
   * the site's, not the reviewer's.
   */
  it('posts an announce for a team-mode site, and never a mount', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => TEAM_SITE, post: (m) => void posts.push(m) })();

    assert.deepEqual(posts, [ANNOUNCE]);
  });

  it('posts an unmount for a team-mode site that is off', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => ({ ...TEAM_SITE, enabled: false }), post: (m) => void posts.push(m) })();

    assert.deepEqual(posts, [UNMOUNT]);
  });

  it('posts an unmount for a site that is off, and for one it has never heard of', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => ({ ...SITE, enabled: false }), post: (m) => void posts.push(m) })();
    await createApply({ readSite: async () => undefined, post: (m) => void posts.push(m) })();

    assert.deepEqual(posts, [UNMOUNT, UNMOUNT]);
  });

  it('stays quiet on an unchanged decision, because a re-mount loses a half-written note', async () => {
    const posts: BridgeMessage[] = [];
    const apply = createApply({ readSite: async () => SITE, post: (m) => void posts.push(m) });

    await apply();
    await apply();
    await apply();

    assert.deepEqual(posts, [MOUNT]);
  });

  it('posts it again when forced, because the page world may have missed it', async () => {
    const posts: BridgeMessage[] = [];
    const apply = createApply({ readSite: async () => SITE, post: (m) => void posts.push(m) });

    await apply();
    await apply(true);

    assert.deepEqual(posts, [MOUNT, MOUNT]);
  });

  /**
   * The guard this file was extracted for. Without the generation check the older read posts last,
   * so a site the reviewer just switched off stays mounted — and `posted` then holds the mount's
   * signature, which suppresses the correction as unchanged.
   */
  it('discards a read that a newer one has already answered', async () => {
    const posts: BridgeMessage[] = [];
    const gate = gated();
    const apply = createApply({ readSite: gate.readSite, post: (m) => void posts.push(m) });

    const first = apply();
    const second = apply();

    gate.answer(1, undefined);
    await second;
    gate.answer(0, SITE);
    await first;

    assert.deepEqual(posts, [UNMOUNT]);
  });

  it('leaves no stale signature behind, so the next real change is still posted', async () => {
    const posts: BridgeMessage[] = [];
    const gate = gated();
    const apply = createApply({ readSite: gate.readSite, post: (m) => void posts.push(m) });

    const first = apply();
    const second = apply();
    gate.answer(1, undefined);
    await second;
    gate.answer(0, SITE);
    await first;

    const third = apply();
    gate.answer(2, SITE);
    await third;

    assert.deepEqual(posts, [UNMOUNT, MOUNT]);
  });
});
