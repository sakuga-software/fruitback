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
 * **`--fruitback-`, and the prefix is the whole defence.** A custom property inherits *into* a Shadow
 * root from the client's page, so a name the host also uses silently repaints us — the Shadow root
 * blocks their selectors, never their inherited properties. `--color-text` would be reckless. `--fb-`
 * was the first attempt and no better, being exactly what a Facebook SDK or somebody's flexbox
 * utilities would pick. `--fruit-` was the second and did fix that, but the package already spelled
 * its script-tag attributes `data-fruitback-*`, so two prefixes coexisted with no rule saying which
 * belonged where. SKG-580 settled on the whole word for all of it: tokens, classes and attributes.
 *
 * **SKG-528 changed no rendered colour.** Every colour was the hexadecimal already in the
 * stylesheets. SKG-544 then changed three values for contrast: `color-border-strong`,
 * `color-text-subtle` and `color-success`. `contrast.test.ts` measures every pair a module paints.
 *
 * One thing does move, by 4 pixels: the thread's shadow was `0 10px 34px rgba(0, 0, 0, 0.18)` and the
 * panel's `0 10px 30px rgb(0 0 0 / 18%)` — the same intention spelled twice. They are one token now.
 *
 * **Radii are tokenised now, and only because the scale was shortened first** (SKG-529). SKG-528 left
 * them out on purpose: there were eight distinct values in use, each mapping to exactly one token,
 * which is indirection wearing the costume of a scale. The eight are four — 4, 6 and 8 became `sm`;
 * 10 and 12 became `md`; 14 and 18 became `lg`; 999px is `pill` — and four is a scale a reader can
 * hold. Naming them before reducing them would have frozen the accident.
 *
 * The pin's own silhouette is **not** in the scale and is not settable: `border-radius: 50% 50% 50% 0`
 * is a shape, not a corner size, and it is the product's identity rather than a preference.
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
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-pill',
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
  return `var(--fruitback-stage-${stage})`;
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

    element.style.setProperty(`--fruitback-${name}`, value);
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
  --fruitback-color-accent: #e53935;
  /*
    One foreground per filled background, and not one shared by all of them.
    All four hold #fff today, which is why a single on-accent looked harmless: the original CSS said
    color:#fff in five places, and naming it after the accent coupled three elements whose background
    is something else — the gear on the chip, every pin badge on its stage, the orphan chip on the
    warning. A host pairing a pale accent with a dark foreground would have turned those three into
    dark text on unchanged dark fills. Caught in review on SKG-528.
  */
  --fruitback-color-on-accent: #fff;
  --fruitback-color-on-chip: #fff;
  --fruitback-color-on-stage: #fff;
  --fruitback-color-on-warning: #fff;
  --fruitback-color-surface: #fff;
  --fruitback-color-surface-raised: #fffdf9;
  --fruitback-color-border: #e7e5e4;
  --fruitback-color-border-strong: #8f8883;
  --fruitback-color-text: #1c1917;
  --fruitback-color-text-muted: #78716c;
  --fruitback-color-text-subtle: #7a736e;
  --fruitback-color-chip: #44403c;
  --fruitback-color-success: #4e7d2a;
  --fruitback-color-warning: #8d6e63;

  /* Ripening, not a rainbow. Same five values the contract used to carry. */
  --fruitback-stage-seeded: #a3b18a;
  --fruitback-stage-green: #7cb342;
  --fruitback-stage-ripening: #fb8c00;
  --fruitback-stage-ripe: #e53935;
  --fruitback-stage-composted: #8d6e63;

  /* Named for the elevation they belong to, not for a size, so a fifth one has to justify itself. */
  --fruitback-shadow-sm: 0 3px 10px rgba(28, 25, 23, 0.28);
  --fruitback-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.25);
  --fruitback-shadow-lg: 0 10px 30px rgb(0 0 0 / 18%);
  --fruitback-shadow-xl: 0 14px 40px rgba(28, 25, 23, 0.22);

  /* Four steps, and each one is a decision: a chip, a control, a surface, a pill. */
  --fruitback-radius-sm: 6px;
  --fruitback-radius-md: 10px;
  --fruitback-radius-lg: 14px;
  --fruitback-radius-pill: 999px;

  --fruitback-font-sans: -apple-system, system-ui, sans-serif;

  --fruitback-duration-fast: 220ms;
  --fruitback-duration-slow: 420ms;
}

/*
  A widget that overlays a dark site with a white popover at three in the morning is a widget they
  turn off. Colours and shadows move — a shadow tuned for a white surface is invisible on a dark one —
  and the durations do not.
*/
@media (prefers-color-scheme: dark) {
  :host {
    --fruitback-color-surface: #1c1917;
    --fruitback-color-surface-raised: #262220;
    --fruitback-color-border: #3a3532;
    --fruitback-color-border-strong: #7a736e;
    --fruitback-color-text: #f5f5f4;
    --fruitback-color-text-muted: #a8a29e;
    --fruitback-color-text-subtle: #8f8883;
    --fruitback-color-chip: #57534e;
    --fruitback-color-success: #7cb342;
    --fruitback-shadow-sm: 0 3px 10px rgba(0, 0, 0, 0.55);
    --fruitback-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.6);
    --fruitback-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);
    --fruitback-shadow-xl: 0 14px 40px rgba(0, 0, 0, 0.55);
  }
}

/*
  Borders and muted text are where a low-contrast palette actually fails someone, so those are what
  harden. A widget laid over a page that was audited for contrast must not be the thing that fails it.
*/
@media (prefers-contrast: more) {
  :host {
    --fruitback-color-border: var(--fruitback-color-text);
    --fruitback-color-border-strong: var(--fruitback-color-text);
    --fruitback-color-text-muted: var(--fruitback-color-text);
    --fruitback-color-text-subtle: var(--fruitback-color-text);
  }
}
`;
