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
  plugins: [tailwindcss(), reactRouter()],
});
