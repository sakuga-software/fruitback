import { type Fruitback, type FruitbackOptions, init } from './embed.ts';

/**
 * The `<script>` tag entry point (SKG-505).
 *
 * A client site that has no build step gets the widget the way it gets an analytics snippet: one
 * tag, two attributes, nothing to import.
 *
 *     <script src="https://cdn.example/fruitback.iife.js"
 *             data-fruitback-endpoint="https://feedback.acme.dev"
 *             data-fruitback-client="acme" defer></script>
 *
 * `defer` matters: the widget mounts into `<body>`, so running before it exists would throw. The
 * mount is deferred to `DOMContentLoaded` anyway rather than trusting the tag to carry the
 * attribute, because the one thing a snippet gets wrong is the part nobody reads.
 *
 * Auto-mounting only happens when the endpoint is on the tag. Without it the global is there and
 * `Fruitback.init(...)` is the caller's to make — which is what a site with its own bootstrap wants.
 */

export { init };
export type { Fruitback, FruitbackOptions };

/** Read where the tag is evaluated, not later: `currentScript` is null once anything awaits. */
const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

if (script !== null) {
  const endpoint = script.dataset.fruitbackEndpoint;
  const clientId = script.dataset.fruitbackClient;

  if (endpoint !== undefined && clientId !== undefined) {
    const mount = (): void => void init({ endpoint, clientId, label: script.dataset.fruitbackLabel });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
}
