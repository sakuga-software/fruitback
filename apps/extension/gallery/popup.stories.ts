import type { Meta, StoryObj } from '@storybook/html-vite';
import { stateStory } from './surface.ts';

export default { title: 'Extension/Popup', parameters: { surface: 'popup' } } satisfies Meta;

export const Loading: StoryObj = { name: 'Loading', ...stateStory('popup', 'loading') };
export const SignedOut: StoryObj = { name: 'Signed out', ...stateStory('popup', 'signed-out') };
export const SignedOutEnded: StoryObj = {
  name: 'Signed out · the sign-in ended',
  ...stateStory('popup', 'signed-out-ended'),
};
export const SignedOutSelfHosted: StoryObj = {
  name: 'Signed out · a build with no Fruitback Cloud',
  ...stateStory('popup', 'signed-out-self-hosted'),
};
export const SignInRefused: StoryObj = { name: 'Sign-in stopped · refused', ...stateStory('popup', 'sign-in-refused') };
export const SignInExpired: StoryObj = { name: 'Sign-in stopped · expired', ...stateStory('popup', 'sign-in-expired') };
export const SignInUnavailable: StoryObj = {
  name: 'Sign-in stopped · unavailable',
  ...stateStory('popup', 'sign-in-unavailable'),
};
export const SignInUntrusted: StoryObj = {
  name: 'Sign-in stopped · untrusted',
  ...stateStory('popup', 'sign-in-untrusted'),
};
export const SignInBlocked: StoryObj = { name: 'Sign-in stopped · blocked', ...stateStory('popup', 'sign-in-blocked') };
export const Connecting: StoryObj = { name: 'Connecting · the word to check', ...stateStory('popup', 'connecting') };
export const ConnectingUnanswered: StoryObj = {
  name: 'Connecting · Fruitback did not answer',
  ...stateStory('popup', 'connecting-unanswered'),
};
export const NotWeb: StoryObj = { name: 'Not a web page', ...stateStory('popup', 'not-web') };
export const NotWebNoKeys: StoryObj = {
  name: 'Not a web page · no keys set',
  ...stateStory('popup', 'not-web-no-keys'),
};
export const Unreachable: StoryObj = { name: 'Fruitback cannot be reached', ...stateStory('popup', 'unreachable') };
export const NoAccess: StoryObj = {
  name: 'Site on · the browser removed its access',
  ...stateStory('popup', 'no-access'),
};
export const TurnOnWorkspace: StoryObj = {
  name: 'Turn on · a site of the workspace, off here',
  ...stateStory('popup', 'turn-on-workspace'),
};
export const TurnOnNewSite: StoryObj = {
  name: 'Turn on · a site of no workspace',
  ...stateStory('popup', 'turn-on-new-site'),
};
export const TurnOnPickWorkspace: StoryObj = {
  name: 'Turn on · a site of no workspace, two workspaces',
  ...stateStory('popup', 'turn-on-pick-workspace'),
};
export const TurnOnChoices: StoryObj = {
  name: 'Turn on · an admin chooses where notes go',
  ...stateStory('popup', 'turn-on-choices'),
};
export const TurnOnHttp: StoryObj = {
  name: 'Turn on · a site on http, added from the console (FRU-537)',
  ...stateStory('popup', 'turn-on-http'),
};
export const TurnOnAskAdmin: StoryObj = {
  name: 'Turn on · nobody here can add the site',
  ...stateStory('popup', 'turn-on-ask-admin'),
};
export const SiteOn: StoryObj = { name: 'Site on · with what waits', ...stateStory('popup', 'site-on') };
export const SiteOnChange: StoryObj = {
  name: 'Site on · a role that may change where the notes go',
  ...stateStory('popup', 'site-on-change'),
};
export const SiteOnQuiet: StoryObj = { name: 'Site on · nothing open', ...stateStory('popup', 'site-on-quiet') };
export const SiteOnReading: StoryObj = {
  name: 'Site on · before the worker answers',
  ...stateStory('popup', 'site-on-reading'),
};
export const SiteHidden: StoryObj = { name: 'Site on · hidden on this page', ...stateStory('popup', 'site-hidden') };
export const SiteOff: StoryObj = { name: 'Site off', ...stateStory('popup', 'site-off') };
export const UpdateAvailable: StoryObj = { name: 'A newer release is out', ...stateStory('popup', 'update-available') };
