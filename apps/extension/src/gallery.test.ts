import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyDomWindow } from 'happy-dom';
import { storyNameFromExport, toId } from 'storybook/internal/csf';
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

const PAGES: Record<Surface, string> = { popup: 'popup.html', welcome: 'welcome.html', panel: 'panel.html' };
const NGINX = readFileSync(new URL('../gallery/nginx.conf', import.meta.url), 'utf8');

/** The id that nginx.conf puts before `--<state>` when it sends an old link of `page` to its story. */
function redirectPrefix(page: string): string | undefined {
  const block = NGINX.split('location = /gallery/').find((each) => each.startsWith(`${page} {`));

  return block?.match(/\/story\/([a-z0-9-]+)--\$arg_state;/)?.[1];
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
      const title = (STORIES[surface].default as { title: string }).title;
      const prefix = redirectPrefix(PAGES[surface]);
      assert.ok(prefix !== undefined, `nginx.conf sends no ${PAGES[surface]}?state= to a story`);
      for (const [name, story] of stories) {
        const state = story.parameters?.state ?? '';
        assert.equal(story.name, titles.get(state), `the story of « ${state} »`);
        // nginx.conf sends `<page>.html?state=<id>`, the link of a state before Storybook, to `<prefix>--<id>`.
        assert.equal(toId(title, storyNameFromExport(name)), `${prefix}--${state}`, `the old link of « ${state} »`);
      }
    });
  }
});
