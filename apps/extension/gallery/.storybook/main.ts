import type { StorybookConfig } from '@storybook/html-vite';

/**
 * The gallery (FRU-523): `pnpm --filter @fruitback/extension gallery` serves it on
 * http://localhost:5179. The build goes to `gallery/dist/gallery`, which nginx serves at `/gallery/`.
 */
const config: StorybookConfig = {
  stories: ['../*.stories.ts'],
  framework: '@storybook/html-vite',
  // The video of the welcome page (FRU-581), next to `iframe.html` as it is next to `welcome.html`.
  staticDirs: [{ from: '../../public/demo', to: '/demo' }],
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
