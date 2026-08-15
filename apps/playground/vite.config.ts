import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * The port is fixed and documented in CLAUDE.md, because `/tf` and `/tfp` read it from there rather
 * than probing. `strictPort` makes a clash fail loudly instead of silently moving the playground.
 */
export default defineConfig({
  server: { port: 5177, strictPort: true },
  preview: { port: 5177, strictPort: true },
  /**
   * Pre-bundled at boot rather than discovered on the first navigation.
   *
   * Vite binds its port — and so answers Playwright's readiness probe — before it has finished
   * optimizing dependencies. Left to discover them lazily, the first real navigation triggers a
   * re-optimization, in-flight module requests come back `504 (Outdated Optimize Dep)`, and the page
   * reloads underneath the running spec: on CI that showed up as two pins where the test expected
   * one. It only bites here because a React app with a design system pulls a far heavier graph than
   * the static page this replaced.
   *
   * Naming them is what makes "the server answered" mean "the server is ready". The E2E suite
   * deliberately runs against `dev` and not a production build: `source` carries the component name
   * and the file, and both come from React's dev-only fiber metadata.
   */
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-router',
      'react-router/dom',
      '@heroui/react',
      'react-grab/primitives',
      'zod',
    ],
  },
  plugins: [tailwindcss(), reactRouter()],
});
