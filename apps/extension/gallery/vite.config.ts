import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The gallery of the extension (FRU-523): `pnpm --filter @fruitback/extension gallery`, then
 * http://localhost:5179/gallery/. The root is the extension, so the pages load the sheets of
 * `entrypoints/` by the same relative paths as the pages of the extension.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  root,
  server: { port: 5179, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: page('index'), popup: page('popup'), welcome: page('welcome'), panel: page('panel') },
    },
  },
});
