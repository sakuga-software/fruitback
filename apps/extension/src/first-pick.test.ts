import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_PICK_KEY,
  type FirstPickArea,
  firstActivation,
  pickOnFirstActivation,
  pickWhenReady,
} from './first-pick.ts';
import type { TabCommandAnswer } from './tab-command.ts';

function area(initial: Record<string, unknown> = {}): FirstPickArea & { items: Record<string, unknown> } {
  const items = { ...initial };

  return {
    items,
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    set: async (more) => void Object.assign(items, more),
  };
}

describe('the first activation of a site opens the choice of an element (FRU-485)', () => {
  it('says « first » once per origin, and keeps the others', async () => {
    const stored = area();
    assert.equal(await firstActivation(stored, 'https://staging.acme.dev'), true);
    assert.equal(await firstActivation(stored, 'https://staging.acme.dev'), false);
    assert.equal(await firstActivation(stored, 'https://acme.dev'), true);
    assert.deepEqual(stored.items[FIRST_PICK_KEY], ['https://staging.acme.dev', 'https://acme.dev']);
  });

  it('reads a stored value that is not a list of origins as none', async () => {
    assert.equal(await firstActivation(area({ [FIRST_PICK_KEY]: 'broken' }), 'https://acme.dev'), true);
    assert.equal(await firstActivation(area({ [FIRST_PICK_KEY]: [3, 'https://acme.dev'] }), 'https://acme.dev'), false);
  });

  it('asks again until the widget of a tab that just opened answers', async () => {
    const answers: TabCommandAnswer[] = [{ done: false }, { done: false }, { done: true }];
    let asked = 0;
    const waits: number[] = [];
    const picked = await pickWhenReady(async () => answers[asked++] ?? { done: false }, {
      every: 100,
      wait: async (ms) => void waits.push(ms),
    });
    assert.equal(picked, true);
    assert.equal(asked, 3);
    assert.deepEqual(waits, [100, 100]);
  });

  it('leaves a widget where somebody writes a note as it is', async () => {
    let asked = 0;
    const picked = await pickWhenReady(
      async () => {
        asked += 1;

        return { done: false, busy: true };
      },
      { wait: async () => {} },
    );
    assert.equal(picked, false);
    assert.equal(asked, 1);
  });

  it('stops after its time, and a refused message counts as no widget', async () => {
    let asked = 0;
    const picked = await pickWhenReady(
      async () => {
        asked += 1;
        throw new Error('no receiving end');
      },
      { within: 1_000, every: 250, wait: async () => {} },
    );
    assert.equal(picked, false);
    assert.equal(asked, 5);
  });

  it('a storage that fails leaves the site on: no rejection, a log, and no choice', async () => {
    const failing: FirstPickArea = {
      get: async () => {
        throw new Error('QUOTA_BYTES quota exceeded');
      },
      set: async () => {},
    };
    const logged: unknown[] = [];
    let picks = 0;
    const picked = await pickOnFirstActivation(failing, 'https://acme.dev', async () => ({ done: true }), {
      log: (error) => void logged.push(error),
      pick: async () => {
        picks += 1;

        return true;
      },
    });
    assert.equal(picked, false);
    assert.equal(picks, 0);
    assert.equal(logged.length, 1);
  });

  it('a first activation picks, and a second one does not', async () => {
    const stored = area();
    let picks = 0;
    const pick = async () => {
      picks += 1;

      return true;
    };
    assert.equal(await pickOnFirstActivation(stored, 'https://acme.dev', async () => ({ done: true }), { pick }), true);
    assert.equal(
      await pickOnFirstActivation(stored, 'https://acme.dev', async () => ({ done: true }), { pick }),
      false,
    );
    assert.equal(picks, 1);
  });
});
