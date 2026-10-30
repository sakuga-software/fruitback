import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { GALLERY, type Surface } from '../gallery/states.ts';

function documentOf(): Document {
  return new HappyDomWindow({ url: 'https://gallery.fruitback.com/gallery/' }).document as unknown as Document;
}

describe('the gallery of the extension (FRU-523)', () => {
  for (const surface of Object.keys(GALLERY) as Surface[]) {
    it(`builds every state of the ${surface}, each with an id of its own`, () => {
      const states = GALLERY[surface]();
      assert.ok(states.length > 0);
      assert.equal(new Set(states.map((state) => state.id)).size, states.length);
      for (const state of states) {
        assert.match(state.id, /^[a-z0-9-]+$/, `the id « ${state.id} » goes in an address`);
        const built = state.build(documentOf());
        assert.ok((built.textContent ?? '').trim().length > 0, `the state « ${state.id} » draws nothing`);
      }
    });
  }
});
