import type { StoryObj } from '@storybook/html-vite';
import { GALLERY, type Surface } from './states.ts';

/**
 * The story of one entry of `states.ts`. The sheets of its surface come from the decorator of
 * `.storybook/preview.ts`, which reads `parameters.surface`.
 */
export function stateStory(surface: Surface, id: string): StoryObj {
  return {
    parameters: { surface, state: id },
    render: () => {
      const state = GALLERY[surface]().find((each) => each.id === id);
      if (state === undefined) throw new Error(`No state « ${id} » in the ${surface} of states.ts`);
      const frame = document.createElement('div');
      frame.className = `gallery-frame gallery-frame-${surface}`;
      frame.append(state.build(document));

      return frame;
    },
  };
}
