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
  // FRU-444: « Show Fruitback on this page » turned off, the rule still on.
  it('unmounts on an origin where the widget is hidden, and mounts again when it is shown', async () => {
    const posts: BridgeMessage[] = [];
    let hidden = false;
    const apply = createApply({
      readSite: async () => SITE,
      readHidden: async () => hidden,
      post: (m) => void posts.push(m),
    });
    await apply();
    hidden = true;
    await apply();
    hidden = false;
    await apply();

    assert.deepEqual(posts, [MOUNT, UNMOUNT, MOUNT]);
  });

  it('shows the widget when the read of the hidden origins fails', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({
      readSite: async () => SITE,
      readHidden: async () => Promise.reject(new Error('closed')),
      post: (m) => void posts.push(m),
    })();

    assert.deepEqual(posts, [MOUNT]);
  });

  it('sends the language of the account with a mount, and none when the extension knows none (FRU-131)', async () => {
    const posts: BridgeMessage[] = [];
    const post = (m: BridgeMessage): void => void posts.push(m);
    await createApply({ readSite: async () => SITE, readLanguage: async () => 'fr', post })();
    await createApply({ readSite: async () => SITE, readLanguage: async () => undefined, post })();
    await createApply({ readSite: async () => SITE, readLanguage: async () => Promise.reject(new Error('x')), post })();

    assert.deepEqual(posts, [{ ...MOUNT, locale: 'fr' }, MOUNT, MOUNT]);
  });

  it('posts again when the language changes, and not when it stays', async () => {
    const posts: BridgeMessage[] = [];
    let spoken: string | undefined = 'fr';
    const apply = createApply({
      readSite: async () => SITE,
      readLanguage: async () => spoken,
      post: (m) => void posts.push(m),
    });
    await apply();
    await apply();
    spoken = 'en';
    await apply();

    assert.deepEqual(posts, [
      { ...MOUNT, locale: 'fr' },
      { ...MOUNT, locale: 'en' },
    ]);
  });

  // FRU-302: « Name on my notes », for a widget we mount in private mode only.
  it('sends the name of the preferences with a private mount, and none in team mode', async () => {
    const posts: BridgeMessage[] = [];
    const post = (m: BridgeMessage): void => void posts.push(m);
    await createApply({ readSite: async () => SITE, readName: async () => '  Camille  ', post })();
    await createApply({ readSite: async () => SITE, readName: async () => '   ', post })();
    await createApply({ readSite: async () => SITE, readName: async () => 'x'.repeat(121), post })();
    await createApply({
      readSite: async () => ({
        mode: 'team',
        endpoint: 'https://worker.test',
        enabled: true,
        mount: { clientId: 'acme' },
      }),
      readName: async () => 'Camille',
      post,
    })();

    assert.deepEqual(
      posts.map((message) => (message.kind === 'mount' ? (message.name ?? null) : message.kind)),
      ['Camille', null, null, null],
    );
  });

  // A change of the name must not build the widget again over a note being written.
  it('does not post the mount again when only the name changed', async () => {
    const posts: BridgeMessage[] = [];
    let name = 'Camille';
    const apply = createApply({
      readSite: async () => SITE,
      readName: async () => name,
      post: (m) => void posts.push(m),
    });
    await apply();
    name = 'Camille Durand';
    await apply();

    assert.equal(posts.length, 1);
  });

  it('sends no language to a site that embeds its own widget', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({
      readSite: async () => TEAM_SITE,
      readLanguage: async () => 'fr',
      post: (m) => void posts.push(m),
    })();

    assert.deepEqual(posts, [ANNOUNCE]);
  });

  it('posts a mount for a site that is on', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => SITE, post: (m) => void posts.push(m) })();

    assert.deepEqual(posts, [MOUNT]);
  });

  /**
   * Team mode mounts nothing, which is the whole of it (FRU-57). The site embeds its own widget, so
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

describe('the session the widget is told of (FRU-315)', () => {
  const TEAM: SiteConfig = {
    mode: 'team',
    endpoint: 'https://api.fruitback.test',
    enabled: true,
    mount: { clientId: 'site_1', workspace: 'Acme' },
  };
  const PRIVATE: SiteConfig = { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true };

  function applying(site: SiteConfig, held: { signedOut: boolean }) {
    const posts: BridgeMessage[] = [];
    const apply = createApply({
      readSite: async () => site,
      readSignedOut: async () => held.signedOut,
      post: (message) => void posts.push(message),
    });

    return { posts, apply };
  }

  it('follows the mount of a widget we relay, and says a change of session alone, without a mount', async () => {
    const held = { signedOut: false };
    const { posts, apply } = applying(TEAM, held);

    await apply();
    assert.deepEqual(
      posts.map((message) => message.kind),
      ['mount', 'session'],
    );
    assert.deepEqual(posts[1], { channel: CHANNEL, kind: 'session', signedOut: false });

    // The session ends: the widget is told, and not built again over what is being written.
    held.signedOut = true;
    await apply();
    assert.deepEqual(posts.slice(2), [{ channel: CHANNEL, kind: 'session', signedOut: true }]);

    // A change of storage that is not one of the session says nothing.
    await apply();
    assert.equal(posts.length, 3);

    // The handshake: the page world may have missed both.
    await apply(true);
    assert.deepEqual(
      posts.slice(3).map((message) => message.kind),
      ['mount', 'session'],
    );
  });

  it('keeps what it said last when the read of the session fails', async () => {
    const posts: BridgeMessage[] = [];
    const answers: (() => Promise<boolean>)[] = [async () => true, async () => Promise.reject(new Error('storage'))];
    const apply = createApply({
      readSite: async () => TEAM,
      readSignedOut: () => (answers.shift() ?? (async () => false))(),
      post: (message) => void posts.push(message),
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await apply();
      await apply();
    } finally {
      console.warn = warn;
    }

    // Signed out, then a failed read: nothing new is said, so the widget keeps offering the sign-in.
    assert.deepEqual(
      posts.filter((message) => message.kind === 'session'),
      [{ channel: CHANNEL, kind: 'session', signedOut: true }],
    );
  });

  // Review of ffa2f88: a session read for the site of before must not be said after a newer apply.
  it('says nothing from an apply that a newer one replaced while it read the session', async () => {
    const posts: BridgeMessage[] = [];
    let site: SiteConfig = TEAM;
    let release: (signedOut: boolean) => void = () => {};
    const slow = new Promise<boolean>((resolve) => (release = resolve));
    let first = true;
    const apply = createApply({
      readSite: async () => site,
      readSignedOut: () => {
        if (!first) return Promise.resolve(false);
        first = false;

        return slow;
      },
      post: (message) => void posts.push(message),
    });

    const older = apply();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The rule changes while the older run waits on its read of the session.
    site = PRIVATE;
    await apply();
    release(true);
    await older;

    assert.deepEqual(
      posts.map((message) => message.kind),
      ['mount'],
    );
    assert.equal(
      posts.some((message) => message.kind === 'session'),
      false,
    );
  });

  it('says nothing of a session to a widget of the private mode', async () => {
    const { posts, apply } = applying(PRIVATE, { signedOut: true });
    await apply();

    assert.deepEqual(
      posts.map((message) => message.kind),
      ['mount'],
    );
  });
});

describe('« Show CSS selectors » the widget is told of (FRU-349)', () => {
  const SELECTORS = (shown: boolean) => ({ channel: CHANNEL, kind: 'selectors', shown });

  function applying(site: SiteConfig | undefined, held: { shown: boolean; fails?: boolean }) {
    const posts: BridgeMessage[] = [];
    const state = { site };
    const apply = createApply({
      readSite: async () => state.site,
      readShowSelectors: async () => (held.fails === true ? Promise.reject(new Error('storage')) : held.shown),
      post: (message) => void posts.push(message),
    });

    return { posts, apply, state };
  }

  it('follows each mount, and says a change alone, without building the widget again', async () => {
    const held = { shown: false };
    const { posts, apply } = applying(SITE, held);

    await apply();
    assert.deepEqual(posts, [MOUNT, SELECTORS(false)]);

    // Turned on in the preferences: said, and no mount over a note being written.
    held.shown = true;
    await apply();
    assert.deepEqual(posts.slice(2), [SELECTORS(true)]);

    // A change of storage that is not this one says nothing.
    await apply();
    assert.equal(posts.length, 3);

    // The handshake: the page world may have missed both.
    await apply(true);
    assert.deepEqual(posts.slice(3), [MOUNT, SELECTORS(true)]);
  });

  it('is said to a widget we mount in team mode too', async () => {
    const team: SiteConfig = { ...TEAM_SITE, mount: { clientId: 'site_1', workspace: 'Acme' } };
    const { posts, apply } = applying(team, { shown: true });

    await apply();
    assert.deepEqual(
      posts.map((message) => message.kind),
      ['mount', 'selectors'],
    );
  });

  it('says nothing to a site that embeds its own widget, or that is off', async () => {
    const { posts, apply, state } = applying(TEAM_SITE, { shown: true });

    await apply();
    state.site = undefined;
    await apply();
    assert.deepEqual(posts, [ANNOUNCE, UNMOUNT]);
  });

  it('keeps what it said last when the read fails', async () => {
    const held = { shown: true, fails: false };
    const { posts, apply } = applying(SITE, held);

    await apply();
    held.fails = true;
    await apply();
    assert.deepEqual(posts, [MOUNT, SELECTORS(true)]);
  });
});

describe('« Corner of the widget » (FRU-443)', () => {
  const MOUNT_SITE: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true };
  const DOCK = (position?: string) => ({
    channel: CHANNEL,
    kind: 'dock',
    ...(position === undefined ? {} : { position }),
  });

  it('says the corner after each mount, and again when it changes, with no new mount', async () => {
    const posts: BridgeMessage[] = [];
    let corner: 'top-left' | 'bottom-left' | undefined = 'top-left';
    const apply = createApply({
      readSite: async () => MOUNT_SITE,
      readDockPosition: async () => corner,
      post: (m) => void posts.push(m),
    });
    await apply();
    await apply();
    corner = 'bottom-left';
    await apply();
    corner = undefined;
    await apply();
    await apply(true);

    assert.deepEqual(
      posts.map((m) => m.kind),
      ['mount', 'dock', 'dock', 'dock', 'mount', 'dock'],
    );
    assert.deepEqual(posts[1], DOCK('top-left'));
    assert.deepEqual(posts[2], DOCK('bottom-left'));
    assert.deepEqual(posts[3], DOCK());
  });

  it('keeps the corner said last when the read fails, and says nothing to no widget', async () => {
    const posts: BridgeMessage[] = [];
    let fails = false;
    let site: SiteConfig | undefined = MOUNT_SITE;
    const apply = createApply({
      readSite: async () => site,
      readDockPosition: async () => (fails ? Promise.reject(new Error('closed')) : 'top-right'),
      post: (m) => void posts.push(m),
    });
    await apply();
    fails = true;
    await apply();
    site = undefined;
    await apply();

    assert.deepEqual(
      posts.map((m) => m.kind),
      ['mount', 'dock', 'unmount'],
    );
  });
});
