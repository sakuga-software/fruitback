/**
 * Where the console serves the widget's script (FRU-106).
 *
 * The image of the console is built with the version of the script it holds
 * (`VITE_FRUITBACK_WIDGET_VERSION`, see `widget-version.ts`), and serves it at
 * `/v/<version>/fruitback.iife.js`, cached for one year. A build without a version (`pnpm dev`) gives
 * the address of before, `/fruitback.iife.js`, which every image still serves with a cache of five
 * minutes.
 */
export function widgetScriptPath(version: string | undefined): string {
  const given = version?.trim();
  return given ? `/v/${given}/fruitback.iife.js` : '/fruitback.iife.js';
}

/** The address of the script of this build. */
export const WIDGET_SCRIPT_PATH = widgetScriptPath(
  import.meta.env?.VITE_FRUITBACK_WIDGET_VERSION as string | undefined,
);
