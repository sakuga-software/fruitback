import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  BRIDGE_SCRIPT_ID,
  PAGE_SCRIPT_ID,
  type RegisteredScript,
  type ScriptRegistrar,
  matchPatternFor,
  scriptIdsFor,
  serialize,
  syncRegistration,
} from './registration.ts';

function registrar(initial: string[] = []): ScriptRegistrar & {
  calls: string[];
  ids: Set<string>;
  excluded: Map<string, string[]>;
} {
  const ids = new Set(initial);
  const calls: string[] = [];
  const excluded = new Map<string, string[]>();

  return {
    ids,
    calls,
    excluded,
    getRegisteredContentScripts: async () =>
      [...ids].map((id) => (excluded.has(id) ? { id, excludeMatches: excluded.get(id) } : { id })),
    registerContentScripts: async (scripts: RegisteredScript[]) => {
      for (const script of scripts) {
        // The real API throws on a duplicate id, and a test that let it pass would hide exactly the
        // bug this module exists to avoid.
        assert.equal(ids.has(script.id), false, `registered ${script.id} twice`);
        ids.add(script.id);
        if (script.excludeMatches === undefined) excluded.delete(script.id);
        else excluded.set(script.id, script.excludeMatches);
      }
      calls.push(`register:${scripts.map((s) => s.id).join(',')}`);
    },
    updateContentScripts: async (scripts: RegisteredScript[]) => {
      for (const script of scripts) assert.equal(ids.has(script.id), true, `updated unregistered ${script.id}`);
      calls.push(`update:${scripts.map((s) => s.id).join(',')}`);
    },
    unregisterContentScripts: async ({ ids: removed }) => {
      for (const id of removed) ids.delete(id);
      calls.push(`unregister:${removed.join(',')}`);
    },
  };
}

describe('syncRegistration', () => {
  let scripting: ReturnType<typeof registrar>;
  const acme = scriptIdsFor('https://acme.dev');
  const other = scriptIdsFor('https://other.dev');

  beforeEach(() => {
    scripting = registrar();
  });

  // FRU-444: « Show Fruitback on this page » turned off. The rule stays on; that origin gets no script.
  it('leaves a hidden origin out of the scripts of the rule that covers it, and gives it back when shown', async () => {
    const shop = scriptIdsFor('https://*.acme.dev');
    await syncRegistration(scripting, ['https://*.acme.dev', 'https://other.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, ['https://*.acme.dev', 'https://other.dev'], ['https://shop.acme.dev']);

    assert.deepEqual(scripting.calls, [
      `unregister:${shop.bridge},${shop.page}`,
      `register:${shop.bridge},${shop.page}`,
    ]);
    assert.deepEqual(scripting.excluded.get(shop.page), ['https://shop.acme.dev/*']);
    assert.deepEqual(scripting.excluded.get(shop.bridge), ['https://shop.acme.dev/*']);
    // The other rule covers no hidden origin: its pair is untouched.
    assert.equal(scripting.excluded.has(other.page), false);

    scripting.calls.length = 0;
    await syncRegistration(scripting, ['https://*.acme.dev', 'https://other.dev'], ['https://shop.acme.dev']);
    assert.deepEqual(scripting.calls, [], 'an unchanged hidden list changes nothing');

    await syncRegistration(scripting, ['https://*.acme.dev', 'https://other.dev']);
    assert.equal(scripting.excluded.has(shop.page), false);
    assert.equal(scripting.ids.has(shop.page), true);
  });

  it('registers both scripts of an origin the first time', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);

    assert.deepEqual(scripting.calls, [`register:${acme.bridge},${acme.page}`]);
    assert.deepEqual([...scripting.ids].sort(), [acme.bridge, acme.page].sort());
  });

  it('registers a new origin in a call of its own, and leaves the others as they are', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, ['https://acme.dev', 'https://other.dev']);

    assert.deepEqual(scripting.calls, [`register:${other.bridge},${other.page}`]);
  });

  /**
   * FRU-74. Chromium refuses a whole call when one pattern is invalid (measured on 145), so with one
   * call for every origin a single refusal stopped the extension on every site.
   */
  it('registers every other origin when the browser refuses one, and names the one it refused', async () => {
    const refusing = {
      ...scripting,
      registerContentScripts: async (scripts: RegisteredScript[]) => {
        if (scripts.some((script) => script.matches.includes('https://*.bad.dev/*'))) {
          throw new Error("Script with ID 'x' has invalid value for matches[0]: Invalid port.");
        }
        await scripting.registerContentScripts(scripts);
      },
    };
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...values: unknown[]) => void warned.push(values);
    try {
      const refused = await syncRegistration(refusing, ['https://acme.dev', 'https://*.bad.dev', 'https://other.dev']);

      assert.deepEqual(refused, ['https://*.bad.dev']);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual([...scripting.ids].sort(), [acme.bridge, acme.page, other.bridge, other.page].sort());
    assert.equal(warned.length, 1);
  });

  it('unregisters the scripts of an origin that is switched off, and only those', async () => {
    await syncRegistration(scripting, ['https://acme.dev', 'https://other.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, ['https://other.dev']);

    assert.deepEqual(scripting.calls, [`unregister:${acme.bridge},${acme.page}`]);
    assert.deepEqual([...scripting.ids].sort(), [other.bridge, other.page].sort());
  });

  it('unregisters everything when the last site is switched off', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, []);

    assert.deepEqual(scripting.calls, [`unregister:${acme.bridge},${acme.page}`]);
    assert.deepEqual([...scripting.ids], []);
  });

  it('does nothing at all when there is nothing registered and nothing to register', async () => {
    await syncRegistration(scripting, []);
    await syncRegistration(scripting, []);

    assert.deepEqual(scripting.calls, []);
  });

  it('puts the widget in the main world and the bridge beside it', async () => {
    const scripts: RegisteredScript[] = [];
    await syncRegistration({ ...scripting, registerContentScripts: async (s) => void scripts.push(...s) }, [
      'https://acme.dev',
    ]);

    assert.partialDeepStrictEqual(scripts, [
      { id: acme.bridge, world: 'ISOLATED', matches: ['https://acme.dev/*'] },
      { id: acme.page, world: 'MAIN', matches: ['https://acme.dev/*'] },
    ]);
  });

  it('recovers when only one of the two of an origin survived', async () => {
    const partial = registrar([acme.bridge]);

    await syncRegistration(partial, ['https://acme.dev']);

    assert.deepEqual(partial.calls, [`register:${acme.page}`]);
  });

  it('takes the place of the one pair of before, and leaves the scripts of others alone', async () => {
    const before = registrar([BRIDGE_SCRIPT_ID, PAGE_SCRIPT_ID, 'somebody-else']);

    await syncRegistration(before, ['https://acme.dev']);

    assert.deepEqual(before.calls, [
      `unregister:${BRIDGE_SCRIPT_ID},${PAGE_SCRIPT_ID}`,
      `register:${acme.bridge},${acme.page}`,
    ]);
    assert.equal(before.ids.has('somebody-else'), true);
  });
});

describe('matchPatternFor', () => {
  it('turns an origin into the pattern both APIs want', () => {
    assert.equal(matchPatternFor('https://acme.dev'), 'https://acme.dev/*');
    assert.equal(matchPatternFor('http://localhost:5177'), 'http://localhost:5177/*');
  });
});

describe('serialize', () => {
  it('runs one at a time, however many ask at once', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const run = serialize(async (name: string) => {
      order.push(`start:${name}`);
      if (name === 'a') await new Promise<void>((resolve) => (release = resolve));
      order.push(`end:${name}`);
    });

    const first = run('a');
    const second = run('b');
    // The first link of the chain is a microtask, so let it run before looking.
    await Promise.resolve();

    // `b` must not have started while `a` is still in flight — that overlap is what made two runs
    // both see an id as absent and both try to register it.
    assert.deepEqual(order, ['start:a']);

    release?.();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('does not wedge the queue when a run fails', async () => {
    const done: string[] = [];
    const run = serialize(async (name: string) => {
      if (name === 'bad') throw new Error('nope');
      done.push(name);
    });

    await run('bad');
    await run('good');

    assert.deepEqual(done, ['good']);
  });
});
