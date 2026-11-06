import type { Meta, StoryObj } from '@storybook/html-vite';
import { stateStory } from './surface.ts';

export default { title: 'Extension/Side panel', parameters: { surface: 'panel' } } satisfies Meta;

export const NotOn: StoryObj = { name: 'Not on for this page', ...stateStory('panel', 'not-on') };
export const NotOnToolbar: StoryObj = {
  name: 'Not on for this page · the popup cannot open from here',
  ...stateStory('panel', 'not-on-toolbar'),
};
export const SiteWidget: StoryObj = { name: 'The site runs its own Fruitback', ...stateStory('panel', 'site-widget') };
export const Reading: StoryObj = { name: 'Reading the notes', ...stateStory('panel', 'reading') };
export const Failed: StoryObj = { name: 'The read failed', ...stateStory('panel', 'failed') };
export const Reload: StoryObj = { name: 'The page must be reloaded', ...stateStory('panel', 'reload') };
export const NotStarted: StoryObj = { name: 'The widget did not start', ...stateStory('panel', 'not-started') };
export const SignedOut: StoryObj = { name: 'The session of the site ended', ...stateStory('panel', 'signed-out') };
export const Empty: StoryObj = { name: 'No note on this page', ...stateStory('panel', 'empty') };
export const Open: StoryObj = { name: 'Open notes', ...stateStory('panel', 'open') };
export const OpenRow: StoryObj = { name: 'Open notes · a row open', ...stateStory('panel', 'open-row') };
export const Replying: StoryObj = { name: 'Open notes · a reply being written', ...stateStory('panel', 'replying') };
export const Finished: StoryObj = { name: 'Finished notes', ...stateStory('panel', 'finished') };
export const Search: StoryObj = { name: 'Search and options', ...stateStory('panel', 'search') };
export const SearchStatuses: StoryObj = {
  name: 'Search and options · seven statuses, the five chips',
  ...stateStory('panel', 'search-statuses'),
};
export const SearchStatusSearched: StoryObj = {
  name: 'Search and options · « In Review » found by the search',
  ...stateStory('panel', 'search-status-searched'),
};
