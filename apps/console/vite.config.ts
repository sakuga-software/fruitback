import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** 5178, beside the playground's 5177. The worker the console calls is `VITE_FRUITBACK_API`. */
export default defineConfig({
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
  plugins: [tailwindcss(), reactRouter()],
});
