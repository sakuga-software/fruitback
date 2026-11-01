import type { Meta, StoryContext, StoryObj } from '@storybook/html-vite';
import { NOTES, OPENED, type WidgetStage, pointAt, widgetPage } from './widget-page.ts';

/**
 * The widget on a made-up page. `render` draws the page; `play` mounts the widget after the page is
 * in the document, then takes it to the state of the story.
 */

type Read = Parameters<typeof widgetPage>[1];

function widgetStory(then: (stage: WidgetStage) => void | Promise<void>, read: Read = {}): StoryObj {
  let mount: () => Promise<WidgetStage> = () => Promise.reject(new Error('The page is not drawn'));

  return {
    parameters: { layout: 'fullscreen', surface: 'widget' },
    render: (_args, context: StoryContext) => {
      const drawn = widgetPage(String(context.globals.locale ?? 'en'), read);
      mount = drawn.mount;

      return drawn.page;
    },
    play: async () => {
      await then(await mount());
    },
  };
}

function badgeOf(id: string): HTMLElement | null {
  const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
  const pins = [...(root?.querySelectorAll<HTMLElement>('.fruitback-pin') ?? [])];
  const index = NOTES.filter((issue) => issue.stage !== 'closed').findIndex((issue) => issue.note.id === id);

  return pins[index]?.querySelector<HTMLElement>('.fruitback-pin-badge') ?? null;
}

export default { title: 'Widget', parameters: { surface: 'widget' } } satisfies Meta;

export const Pins: StoryObj = { name: 'The pins of the page', ...widgetStory(() => undefined) };

export const PinPreview: StoryObj = {
  name: 'Pin · the preview under the pointer',
  ...widgetStory(() => {
    badgeOf(OPENED)?.focus();
  }),
};

export const PinWindow: StoryObj = {
  name: 'Pin window · a reply of the team, and the field to answer',
  ...widgetStory(({ widget }) => {
    widget.focusNote(OPENED);
  }),
};

export const PinWindowReadOnly: StoryObj = {
  name: 'Pin window · a reader who cannot reply',
  ...widgetStory(
    ({ widget }) => {
      widget.focusNote(OPENED);
    },
    { canReply: false },
  ),
};

export const PinWindowNew: StoryObj = {
  name: 'Pin window · a new note of somebody else',
  ...widgetStory(({ widget }) => {
    widget.focusNote('note-title');
  }),
};

export const Choosing: StoryObj = {
  name: 'Leave a note · choosing an element',
  ...widgetStory(({ widget, page }) => {
    widget.leaveFeedback();
    const target = page.querySelector('[data-demo="plan-team"]');
    if (target !== null) document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...pointAt(target) }));
  }),
};

export const Composer: StoryObj = {
  name: 'Leave a note · the note to write',
  ...widgetStory(({ widget, page }) => {
    widget.leaveFeedback();
    const target = page.querySelector('[data-demo="plan-team"]');
    if (target !== null)
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pointAt(target) }));
  }),
};

export const EveryNote: StoryObj = {
  name: 'The list of every note',
  ...widgetStory(({ widget }) => {
    widget.showEveryNote();
  }),
};

export const NoNote: StoryObj = { name: 'A page with no note', ...widgetStory(() => undefined, { issues: [] }) };

export const Closed: StoryObj = {
  name: 'A reader the workspace takes no note from',
  ...widgetStory(() => undefined, { canWrite: false }),
};
