import type { StorybookConfig } from '@storybook/html-vite';

/**
 * The gallery (FRU-523): `pnpm --filter @fruitback/extension gallery` serves it on
 * http://localhost:5179. The build goes to `gallery/dist/gallery`, which nginx serves at `/gallery/`.
 */
const config: StorybookConfig = {
  stories: ['../*.stories.ts'],
  framework: '@storybook/html-vite',
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  features: {
    actions: false,
    controls: false,
    interactions: false,
    sidebarOnboardingChecklist: false,
    menuOnboardingChecklist: false,
  },
};

export default config;
