import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BADGE_COLOR, type BadgeSeams, badgeText, createBadge } from './badge.ts';
import type { Offer } from './cloud.ts';
import type { SiteConfig } from './sites.ts';

/** The badge on the icon (FRU-604): the notes to check of the site of the tab, by tab. */

const TEAM: SiteConfig = { mode: 'team', endpoint: 'https://api.fruitback.dev', enabled: true } as SiteConfig;

function offerWith(toCheck: number | undefined): Offer {
  return {
    endpoint: 'https://api.fruitback.dev',
    pattern: 'https://staging.acme.dev',
    workspace: { id: 'ws', name: 'Acme' },
    site: {
      id: 'site',
      origin: 'https://staging.acme.dev',
      visibility: 'members',
      workspace: { id: 'ws', name: 'Acme' },
      ...(toCheck === undefined ? {} : { toCheck }),
    },
  };
}

function browserOf(overrides: Partial<BadgeSeams> = {}) {
  const calls: string[] = [];
  const seams: BadgeSeams = {
    action: {
      setBadgeText: async ({ tabId, text }) => void calls.push(`text ${tabId} ${text}`),
      setBadgeBackgroundColor: async ({ tabId, color }) => void calls.push(`color ${tabId} ${color}`),
      setBadgeTextColor: async ({ tabId, color }) => void calls.push(`text-color ${tabId} ${color}`),
    },
    readSite: async (origin) => (origin === 'https://staging.acme.dev' ? TEAM : undefined),
    offer: async () => offerWith(3),
    ...overrides,
  };

  return { calls, badge: createBadge(seams) };
}

describe('badgeText', () => {
  it('says nothing for none, for no answer, and for what is no count', () => {
    for (const count of [undefined, 0, -1, 1.5, Number.NaN]) assert.equal(badgeText(count), '', String(count));
  });

  it('says the count, and 99+ above 99', () => {
    assert.equal(badgeText(1), '1');
    assert.equal(badgeText(99), '99');
    assert.equal(badgeText(100), '99+');
  });
});

describe('the badge of a tab', () => {
  it('shows the count of the site of the tab, in the blue of done, on that tab only', async () => {
    const { calls, badge } = browserOf();
    await badge({ id: 7, url: 'https://staging.acme.dev/pricing' });
    assert.deepEqual(calls, ['text 7 3', `color 7 ${BADGE_COLOR}`, 'text-color 7 #ffffff']);
  });

  it('is empty on a site that is not on, in private mode, or not a page', async () => {
    const off = browserOf({ readSite: async () => ({ ...TEAM, enabled: false }) as SiteConfig });
    await off.badge({ id: 1, url: 'https://staging.acme.dev/' });
    const priv = browserOf({
      readSite: async () =>
        ({ mode: 'private', clientId: 'c', endpoint: 'https://x.dev', enabled: true }) as SiteConfig,
    });
    await priv.badge({ id: 2, url: 'https://staging.acme.dev/' });
    const none = browserOf();
    await none.badge({ id: 3, url: 'https://other.dev/' });
    await none.badge({ id: 4, url: 'chrome://extensions' });
    assert.deepEqual(off.calls, ['text 1 ']);
    assert.deepEqual(priv.calls, ['text 2 ']);
    assert.deepEqual(none.calls, ['text 3 ', 'text 4 ']);
  });

  it('is empty when the worker gives no count, or does not answer, never zero', async () => {
    const silent = browserOf({ offer: async () => offerWith(undefined) });
    await silent.badge({ id: 1, url: 'https://staging.acme.dev/' });
    const down = browserOf({ offer: async () => Promise.reject(new Error('down')) });
    await down.badge({ id: 2, url: 'https://staging.acme.dev/' });
    assert.deepEqual(silent.calls, ['text 1 ']);
    assert.deepEqual(down.calls, ['text 2 ']);
  });

  it('keeps the answer of the last question of a tab, not a slow one of the page of before', async () => {
    let release: (offer: Offer) => void = () => undefined;
    const slow = new Promise<Offer>((resolve) => (release = resolve));
    let first = true;
    const { calls, badge } = browserOf({
      offer: async () => {
        if (first) {
          first = false;

          return slow;
        }

        return offerWith(1);
      },
    });
    const before = badge({ id: 5, url: 'https://staging.acme.dev/a' });
    await badge({ id: 5, url: 'https://staging.acme.dev/b' });
    release(offerWith(9));
    await before;
    assert.deepEqual(calls, ['text 5 1', `color 5 ${BADGE_COLOR}`, 'text-color 5 #ffffff']);
  });

  it('is the colour of done in the popup', () => {
    const style = readFileSync(new URL('../entrypoints/popup/style.css', import.meta.url), 'utf8');
    assert.ok(style.includes(`--stage-done: ${BADGE_COLOR};`));
  });
});
