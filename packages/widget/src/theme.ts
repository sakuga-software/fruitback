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
 * all of them without any of them importing anything.
 *
 * **`--fruit-`, and the prefix is the whole defence.** A custom property inherits *into* a Shadow
 * root from the client's page, so a name the host also uses silently repaints us — the Shadow root
 * blocks their selectors, never their inherited properties. `--color-text` would be reckless; `--fb-`
 * was the first attempt and is not much better, since it is exactly what a Facebook SDK or somebody's
 * flexbox utilities would pick. `--fruit-` is ours in a way two letters never were.
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
  'color-on-chip',
  'color-on-stage',
  'color-on-warning',
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
  return `var(--fruit-stage-${stage})`;
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

    element.style.setProperty(`--fruit-${name}`, value);
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
  --fruit-color-accent: #e53935;
  /*
    One foreground per filled background, and not one shared by all of them.
    All four hold #fff today, which is why a single on-accent looked harmless: the original CSS said
    color:#fff in five places, and naming it after the accent coupled three elements whose background
    is something else — the gear on the chip, every pin badge on its stage, the orphan chip on the
    warning. A host pairing a pale accent with a dark foreground would have turned those three into
    dark text on unchanged dark fills. Caught in review on SKG-528.
  */
  --fruit-color-on-accent: #fff;
  --fruit-color-on-chip: #fff;
  --fruit-color-on-stage: #fff;
  --fruit-color-on-warning: #fff;
  --fruit-color-surface: #fff;
  --fruit-color-surface-raised: #fffdf9;
  --fruit-color-border: #e7e5e4;
  --fruit-color-border-strong: #d6d3d1;
  --fruit-color-text: #1c1917;
  --fruit-color-text-muted: #78716c;
  --fruit-color-text-subtle: #a8a29e;
  --fruit-color-chip: #44403c;
  --fruit-color-success: #7cb342;
  --fruit-color-warning: #8d6e63;

  /* Ripening, not a rainbow. Same five values the contract used to carry. */
  --fruit-stage-seeded: #a3b18a;
  --fruit-stage-green: #7cb342;
  --fruit-stage-ripening: #fb8c00;
  --fruit-stage-ripe: #e53935;
  --fruit-stage-composted: #8d6e63;

  /* Named for the elevation they belong to, not for a size, so a fifth one has to justify itself. */
  --fruit-shadow-sm: 0 3px 10px rgba(28, 25, 23, 0.28);
  --fruit-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.25);
  --fruit-shadow-lg: 0 10px 30px rgb(0 0 0 / 18%);
  --fruit-shadow-xl: 0 14px 40px rgba(28, 25, 23, 0.22);

  --fruit-font-sans: -apple-system, system-ui, sans-serif;

  --fruit-duration-fast: 220ms;
  --fruit-duration-slow: 420ms;
}

/*
  A widget that overlays a dark site with a white popover at three in the morning is a widget they
  turn off. Colours and shadows move — a shadow tuned for a white surface is invisible on a dark one —
  and the durations do not.
*/
@media (prefers-color-scheme: dark) {
  :host {
    --fruit-color-surface: #1c1917;
    --fruit-color-surface-raised: #262220;
    --fruit-color-border: #3a3532;
    --fruit-color-border-strong: #4a4441;
    --fruit-color-text: #f5f5f4;
    --fruit-color-text-muted: #a8a29e;
    --fruit-color-text-subtle: #78716c;
    --fruit-color-chip: #57534e;
    --fruit-shadow-sm: 0 3px 10px rgba(0, 0, 0, 0.55);
    --fruit-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.6);
    --fruit-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);
    --fruit-shadow-xl: 0 14px 40px rgba(0, 0, 0, 0.55);
  }
}

/*
  Borders and muted text are where a low-contrast palette actually fails someone, so those are what
  harden. A widget laid over a page that was audited for contrast must not be the thing that fails it.
*/
@media (prefers-contrast: more) {
  :host {
    --fruit-color-border: var(--fruit-color-text);
    --fruit-color-border-strong: var(--fruit-color-text);
    --fruit-color-text-muted: var(--fruit-color-text);
    --fruit-color-text-subtle: var(--fruit-color-text);
  }
}
`;
