import type { Config } from '@react-router/dev/config';

export default {
  // A single-page application: the console holds no secret and renders nothing on a server. The build
  // is static files, served as they are (FRU-99).
  ssr: false,
} satisfies Config;
