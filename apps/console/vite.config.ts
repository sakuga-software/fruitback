import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** 5178, beside the playground's 5177. The worker the console calls is `VITE_FRUITBACK_API`. */
export default defineConfig({
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
  plugins: [tailwindcss(), reactRouter()],
  // `@fruitback/shared` is a package of the workspace, so Vite serves its sources and finds `zod`, which
  // it imports, only when a screen that reads it is first opened (the statuses of a site, FRU-371). It
  // then bundles `zod` and reloads every page it serves, the others too: in CI, where four workers share
  // one server, a test of another screen lost its page in the middle (`console-sites.spec.ts:645`,
  // `console-setup.spec.ts:201`). Named here, it is bundled when the server starts.
  optimizeDeps: { include: ['@fruitback/shared > zod'] },
});
