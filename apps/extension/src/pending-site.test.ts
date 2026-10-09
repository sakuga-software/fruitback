import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PENDING_TTL_MS, type PendingSeams, createPending, parsePending } from './pending-site.ts';
import type { SiteConfig } from './sites.ts';

const SITE: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true };
const ORIGIN = 'https://staging.acme.dev';

/** One storage key, a permission that a test grants, and what was stored and activated. */
function world(overrides: Partial<PendingSeams> = {}) {
  const state = { value: undefined as unknown, granted: false, now: 1_000_000 };
  const stored: [string, SiteConfig][] = [];
  const activated: string[] = [];
  const pending = createPending({
    read: async () => state.value,
    write: async (value) => void (state.value = JSON.parse(JSON.stringify(value))),
    clear: async () => void (state.value = undefined),
    granted: async () => state.granted,
    store: async (pattern, site) => void stored.push([pattern, site]),
    activate: async (pattern) => void activated.push(pattern),
    now: () => state.now,
    ...overrides,
  });

  return { state, stored, activated, pending };
}

describe('a site asked for while the browser asks for access (FRU-118)', () => {
  it('is turned on by whoever hears that the access arrived, when the popup is gone', async () => {
    const { state, stored, activated, pending } = world();
    await pending.remember(ORIGIN, SITE);
    assert.equal(await pending.settle(), undefined, 'no access yet, so nothing is turned on');
    assert.deepEqual(stored, []);

    state.granted = true;

    assert.equal(await pending.settle(), ORIGIN);
    assert.deepEqual(stored, [[ORIGIN, SITE]]);
    assert.deepEqual(activated, [ORIGIN]);
    assert.equal(state.value, undefined, 'the intent is spent');
  });

  it('turns the site on once when the background and the popup both settle', async () => {
    const { state, stored, pending } = world();
    await pending.remember(ORIGIN, SITE);
    state.granted = true;

    await Promise.all([pending.settle(), pending.settle()]);
    await pending.settle();

    assert.equal(stored.length, 1);
  });

  it('keeps the intent when the entry could not be stored, so the next settle tries again', async () => {
    let fail = true;
    const kept: string[] = [];
    const { state, pending } = world({
      store: async (pattern) => {
        if (fail) throw new Error('the background did not answer');
        kept.push(pattern);
      },
    });
    await pending.remember(ORIGIN, SITE);
    state.granted = true;

    await assert.rejects(pending.settle());
    fail = false;

    assert.equal(await pending.settle(), ORIGIN);
    assert.deepEqual(kept, [ORIGIN]);
  });

  it('turns nothing on from an old intent, even with the access', async () => {
    const { state, stored, pending } = world();
    await pending.remember(ORIGIN, SITE);
    state.granted = true;
    state.now += PENDING_TTL_MS + 1;

    assert.equal(await pending.settle(), undefined);
    assert.deepEqual(stored, []);
    assert.equal(state.value, undefined);
  });
});

describe('the values somebody typed, after a prompt they refused (FRU-117)', () => {
  it('come back for the same site, and for no other', async () => {
    const { pending } = world();
    await pending.remember(ORIGIN, SITE);

    assert.deepEqual(await pending.draft(ORIGIN), SITE);
    assert.equal(await pending.draft('https://elsewhere.dev'), undefined);
  });

  it('are gone after they are forgotten, and after they are too old', async () => {
    const first = world();
    await first.pending.remember(ORIGIN, SITE);
    await first.pending.forget();
    assert.equal(await first.pending.draft(ORIGIN), undefined);

    const second = world();
    await second.pending.remember(ORIGIN, SITE);
    second.state.now += PENDING_TTL_MS + 1;
    assert.equal(await second.pending.draft(ORIGIN), undefined);
  });

  it('are parsed like an entry: a malformed one is no draft', () => {
    assert.equal(parsePending({ pattern: ORIGIN, site: { mode: 'private' }, at: 1 }), undefined);
    assert.equal(parsePending({ pattern: '', site: SITE, at: 1 }), undefined);
    assert.equal(parsePending('x'), undefined);
    assert.deepEqual(parsePending({ pattern: ORIGIN, site: SITE, at: 1 }), { pattern: ORIGIN, site: SITE, at: 1 });
  });
});

/**
 * The wiring cannot run under `node --test`: an entrypoint binds `browser` at import. It is read
 * instead, because every case above stays green with either call deleted.
 */
describe('the wiring of the pending site', () => {
  const popup = readFileSync(new URL('../entrypoints/popup/main.ts', import.meta.url), 'utf8');
  const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

  it('remembers the site before the popup asks for access, and does not wait for it', () => {
    const turnOn = popup.slice(popup.indexOf('async function turnOn('));
    const remember = turnOn.indexOf('pending.remember(pattern, site)');
    const request = turnOn.indexOf('browser.permissions.request(');

    assert.ok(remember !== -1 && request !== -1 && remember < request);
    assert.equal(/await\s+pending\.remember/.test(popup), false, 'an await before the request loses the gesture');
  });

  it('settles in the background when the access arrives, and in the popup when it opens', () => {
    const added = background.slice(background.indexOf('browser.permissions.onAdded.addListener('));

    assert.ok(added.slice(0, 400).includes('pending'), 'the background finishes the site on permissions.onAdded');
    assert.ok(added.slice(0, 400).includes('.settle()'));
    assert.ok(popup.includes('await pending.settle()'));
  });
});
