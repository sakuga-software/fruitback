import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  BRIDGE_SCRIPT_ID,
  PAGE_SCRIPT_ID,
  type RegisteredScript,
  type ScriptRegistrar,
  matchPatternFor,
  syncRegistration,
} from './registration.ts';

function registrar(initial: string[] = []): ScriptRegistrar & { calls: string[]; ids: Set<string> } {
  const ids = new Set(initial);
  const calls: string[] = [];

  return {
    ids,
    calls,
    getRegisteredContentScripts: async () => [...ids].map((id) => ({ id })),
    registerContentScripts: async (scripts: RegisteredScript[]) => {
      for (const script of scripts) {
        // The real API throws on a duplicate id, and a test that let it pass would hide exactly the
        // bug this module exists to avoid.
        assert.equal(ids.has(script.id), false, `registered ${script.id} twice`);
        ids.add(script.id);
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

  beforeEach(() => {
    scripting = registrar();
  });

  it('registers both scripts the first time', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);

    assert.deepEqual(scripting.calls, [`register:${BRIDGE_SCRIPT_ID},${PAGE_SCRIPT_ID}`]);
    assert.deepEqual([...scripting.ids].sort(), [BRIDGE_SCRIPT_ID, PAGE_SCRIPT_ID].sort());
  });

  it('updates rather than re-registers when they are already there', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, ['https://acme.dev', 'https://other.dev']);

    assert.deepEqual(scripting.calls, [`update:${BRIDGE_SCRIPT_ID},${PAGE_SCRIPT_ID}`]);
  });

  /**
   * The one that matters. `updateContentScripts` refuses an empty `matches`, so an implementation
   * that updated here would throw and leave the previous origins registered — the extension would go
   * on running on a site somebody had just switched off.
   */
  it('unregisters when the last site is switched off, rather than updating with nothing', async () => {
    await syncRegistration(scripting, ['https://acme.dev']);
    scripting.calls.length = 0;

    await syncRegistration(scripting, []);

    assert.deepEqual(scripting.calls, [`unregister:${BRIDGE_SCRIPT_ID},${PAGE_SCRIPT_ID}`]);
    assert.deepEqual([...scripting.ids], []);
  });

  it('does nothing at all when there is nothing registered and nothing to register', async () => {
    await syncRegistration(scripting, []);

    assert.deepEqual(scripting.calls, []);
  });

  it('puts the widget in the main world and the bridge beside it', async () => {
    const scripts: RegisteredScript[] = [];
    await syncRegistration({ ...scripting, registerContentScripts: async (s) => void scripts.push(...s) }, [
      'https://acme.dev',
    ]);

    assert.partialDeepStrictEqual(scripts, [
      { id: BRIDGE_SCRIPT_ID, world: 'ISOLATED', matches: ['https://acme.dev/*'] },
      { id: PAGE_SCRIPT_ID, world: 'MAIN', matches: ['https://acme.dev/*'] },
    ]);
  });

  it('recovers when only one of the two survived', async () => {
    const partial = registrar([BRIDGE_SCRIPT_ID]);

    await syncRegistration(partial, ['https://acme.dev']);

    assert.deepEqual(partial.calls, [`update:${BRIDGE_SCRIPT_ID}`, `register:${PAGE_SCRIPT_ID}`]);
  });
});

describe('matchPatternFor', () => {
  it('turns an origin into the pattern both APIs want', () => {
    assert.equal(matchPatternFor('https://acme.dev'), 'https://acme.dev/*');
    assert.equal(matchPatternFor('http://localhost:5177'), 'http://localhost:5177/*');
  });
});
