import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { GALLERY, type Surface } from '../gallery/states.ts';
import * as panelStories from '../gallery/panel.stories.ts';
import * as popupStories from '../gallery/popup.stories.ts';
import * as welcomeStories from '../gallery/welcome.stories.ts';

function documentOf(): Document {
  return new HappyDomWindow({ url: 'https://gallery.fruitback.com/gallery/' }).document as unknown as Document;
}

const STORIES: Record<Surface, Record<string, unknown>> = {
  popup: popupStories,
  welcome: welcomeStories,
  panel: panelStories,
};

type Story = { name?: string; parameters?: { state?: string } };

function storiesOf(surface: Surface): [string, Story][] {
  return Object.entries(STORIES[surface])
    .filter(([name]) => name !== 'default')
    .map(([name, story]) => [name, story as Story]);
}

/** `SignedOutEnded` → `signed-out-ended`, as Storybook makes the id of a story from its export. */
function kebab(name: string): string {
  return name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '-').toLowerCase();
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

    it(`gives every state of the ${surface} one story, named by its title`, () => {
      const titles = new Map(GALLERY[surface]().map((state) => [state.id, state.title]));
      const stories = storiesOf(surface);
      const told = stories.map(([, story]) => story.parameters?.state);
      assert.deepEqual(
        [...told].sort(),
        [...titles.keys()].sort(),
        `${surface}.stories.ts and states.ts list other states`,
      );
      for (const [name, story] of stories) {
        assert.equal(
          story.name,
          titles.get(story.parameters?.state ?? ''),
          `the story of « ${story.parameters?.state} »`,
        );
        // nginx.conf sends `<page>.html?state=<id>`, the link of a state before Storybook, to the story with this id.
        assert.equal(kebab(name), story.parameters?.state, `the export ${name} gives another id than its state`);
      }
    });
  }
});
