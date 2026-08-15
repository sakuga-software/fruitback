import type { Config } from '@react-router/dev/config';

export default {
  // Server-rendered, like a real client site. That is the point: the widget has to mount after
  // hydration and survive React replacing the DOM it was pointing at.
  ssr: true,
} satisfies Config;
