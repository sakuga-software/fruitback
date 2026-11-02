import type { Meta, StoryObj } from '@storybook/html-vite';
import { stateStory } from './surface.ts';

export default { title: 'Extension/Welcome page', parameters: { surface: 'welcome' } } satisfies Meta;

export const SignedOut: StoryObj = { name: 'Signed out', ...stateStory('welcome', 'signed-out') };
export const SignedOutLessMotion: StoryObj = {
  name: 'Signed out · less motion: the video waits behind its poster (FRU-531)',
  ...stateStory('welcome', 'signed-out-less-motion'),
};
export const SignInRefused: StoryObj = {
  name: 'Sign-in stopped · refused',
  ...stateStory('welcome', 'sign-in-refused'),
};
export const Connecting: StoryObj = { name: 'Connecting · the word to check', ...stateStory('welcome', 'connecting') };
export const ConnectingUnanswered: StoryObj = {
  name: 'Connecting · Fruitback did not answer',
  ...stateStory('welcome', 'connecting-unanswered'),
};
export const SignedInReading: StoryObj = {
  name: 'Signed in · reading the sites',
  ...stateStory('welcome', 'signed-in-reading'),
};
export const SignedInOneSite: StoryObj = {
  name: 'Signed in · one site to turn on',
  ...stateStory('welcome', 'signed-in-one-site'),
};
export const SignedInSiteOn: StoryObj = {
  name: 'Signed in · the site is on',
  ...stateStory('welcome', 'signed-in-site-on'),
};
export const SignedInSites: StoryObj = {
  name: 'Signed in · several sites',
  ...stateStory('welcome', 'signed-in-sites'),
};
export const SignedInNoSite: StoryObj = {
  name: 'Signed in · no site yet',
  ...stateStory('welcome', 'signed-in-no-site'),
};
export const SignedInUnavailable: StoryObj = {
  name: 'Signed in · Fruitback did not answer',
  ...stateStory('welcome', 'signed-in-unavailable'),
};
export const SignedInProblem: StoryObj = {
  name: 'Signed in · the site could not be turned on',
  ...stateStory('welcome', 'signed-in-problem'),
};
export const SelfHosted: StoryObj = {
  name: 'A build with no Fruitback Cloud',
  ...stateStory('welcome', 'self-hosted'),
};
