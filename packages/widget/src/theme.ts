import { SEED_STAGES, type SeedStage } from '@fruitback/shared';

/**
 * The widget's design tokens, and the only thing a host may change about how it looks (SKG-528).
 *
 * Before this, every colour was a hexadecimal written into one of five `STYLES` literals — `host.ts`,
 * `overlay.ts`, `composer.ts`, `panel.ts`, `orphans.ts` — plus the stage colours, which travelled in
 * the published contract. Changing the look meant editing five files and a package other people
 * install. Nothing was adjustable by the site the widget sits on, and there was no dark theme.
 *
 * **Custom properties rather than classes, because inheritance is what crosses the modules.** Each
 * module injects its own `<style>` into the one Shadow root, so a token declared on `:host` reaches
 * all of them without any of them importing anything. That is also why the names are this specific:
 * a custom property inherits *into* the Shadow root from the client's page too, so `--fb-color-text`
 * is deliberately not `--color-text`, which a design system on the host would plausibly define.
 *
 * **No rendered colour changes here.** Every colour below is the hexadecimal that was already in the
 * stylesheets, so the E2E specs that read a pin's computed colour are the proof. Choosing different
 * values is SKG-529's job; this is the layer that makes it one edit instead of five.
 *
 * One thing does move, by 4 pixels: the thread's shadow was `0 10px 34px rgba(0, 0, 0, 0.18)` and the
 * panel's `0 10px 30px rgb(0 0 0 / 18%)` — the same intention spelled twice. They are one token now.
 *
 * **Radii are deliberately not tokenised.** There are eight distinct ones in use and each would map
 * to exactly one token, which is indirection wearing the costume of a scale — and more for SKG-529 to
 * undo when it shortens the scale on purpose. Colour, shadow, typography and duration are what a dark
 * theme and a host override actually need.
 */

/** Every token a host may set. An unknown name is ignored rather than written — see `applyTheme`. */
export const THEME_TOKENS = [
  'color-accent',
  'color-on-accent',
  'color-surface',
  'color-surface-raised',
  'color-border',
  'color-border-strong',
  'color-text',
  'color-text-muted',
  'color-text-subtle',
  'color-chip',
  'color-success',
  'color-warning',
  'stage-seeded',
  'stage-green',
  'stage-ripening',
  'stage-ripe',
  'stage-composted',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'font-sans',
  'duration-fast',
  'duration-slow',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * What a host may pass to `init({ theme })`.
 *
 * Tokens only, and deliberately not a stylesheet. A host that could write arbitrary CSS into the
 * Shadow root would be a host we could never change the markup under — the class names would become
 * a contract by accident, which is the whole thing the Shadow root exists to avoid. A colour, a
 * shadow and a font family are safe to promise; a selector is not.
 */
export type FruitbackTheme = Partial<Record<ThemeToken, string>>;

/** The stage a pin is at, as the token that colours it. Used by the overlay and the panel. */
export function stageToken(stage: SeedStage): string {
  return `var(--fb-stage-${stage})`;
}

const KNOWN = new Set<string>(THEME_TOKENS);

/**
 * Write a host's tokens onto the element, skipping anything not named in `THEME_TOKENS`.
 *
 * Skipped rather than refused: a host on an older version of the widget passing a token a newer one
 * renamed should lose that one override, not have its widget fail to mount. And filtering by name is
 * what keeps `theme` from becoming a way to set arbitrary properties on the host element.
 */
export function applyTheme(element: HTMLElement, theme: FruitbackTheme | undefined): void {
  if (theme === undefined) return;

  for (const [name, value] of Object.entries(theme)) {
    if (!KNOWN.has(name) || typeof value !== 'string' || value === '') continue;

    element.style.setProperty(`--fb-${name}`, value);
  }
}

/** Asserted by a test: a stage without a token would render a pin with no colour at all. */
export function missingStageTokens(): SeedStage[] {
  return SEED_STAGES.filter((stage) => !KNOWN.has(`stage-${stage}`));
}

/**
 * The token declarations, injected ahead of every other stylesheet in the Shadow root.
 *
 * No backticks anywhere in here. A comment quoting a symbol closes the template literal and the
 * module stops parsing — it has happened four times in this repo, twice while writing a comment
 * about a different bug. Write display:block, not the same thing in backticks.
 */
export const THEME_STYLES = `
:host {
  --fb-color-accent: #e53935;
  --fb-color-on-accent: #fff;
  --fb-color-surface: #fff;
  --fb-color-surface-raised: #fffdf9;
  --fb-color-border: #e7e5e4;
  --fb-color-border-strong: #d6d3d1;
  --fb-color-text: #1c1917;
  --fb-color-text-muted: #78716c;
  --fb-color-text-subtle: #a8a29e;
  --fb-color-chip: #44403c;
  --fb-color-success: #7cb342;
  --fb-color-warning: #8d6e63;

  /* Ripening, not a rainbow. Same five values the contract used to carry. */
  --fb-stage-seeded: #a3b18a;
  --fb-stage-green: #7cb342;
  --fb-stage-ripening: #fb8c00;
  --fb-stage-ripe: #e53935;
  --fb-stage-composted: #8d6e63;

  /* Named for the elevation they belong to, not for a size, so a fifth one has to justify itself. */
  --fb-shadow-sm: 0 3px 10px rgba(28, 25, 23, 0.28);
  --fb-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.25);
  --fb-shadow-lg: 0 10px 30px rgb(0 0 0 / 18%);
  --fb-shadow-xl: 0 14px 40px rgba(28, 25, 23, 0.22);

  --fb-font-sans: -apple-system, system-ui, sans-serif;

  --fb-duration-fast: 220ms;
  --fb-duration-slow: 420ms;
}

/*
  A widget that overlays a dark site with a white popover at three in the morning is a widget they
  turn off. Colours and shadows move — a shadow tuned for a white surface is invisible on a dark one —
  and the durations do not.
*/
@media (prefers-color-scheme: dark) {
  :host {
    --fb-color-surface: #1c1917;
    --fb-color-surface-raised: #262220;
    --fb-color-border: #3a3532;
    --fb-color-border-strong: #4a4441;
    --fb-color-text: #f5f5f4;
    --fb-color-text-muted: #a8a29e;
    --fb-color-text-subtle: #78716c;
    --fb-color-chip: #57534e;
    --fb-shadow-sm: 0 3px 10px rgba(0, 0, 0, 0.55);
    --fb-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.6);
    --fb-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);
    --fb-shadow-xl: 0 14px 40px rgba(0, 0, 0, 0.55);
  }
}

/*
  Borders and muted text are where a low-contrast palette actually fails someone, so those are what
  harden. A widget laid over a page that was audited for contrast must not be the thing that fails it.
*/
@media (prefers-contrast: more) {
  :host {
    --fb-color-border: var(--fb-color-text);
    --fb-color-border-strong: var(--fb-color-text);
    --fb-color-text-muted: var(--fb-color-text);
    --fb-color-text-subtle: var(--fb-color-text);
  }
}
`;
