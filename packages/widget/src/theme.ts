import { SEED_STAGES, type SeedStage } from '@fruitback/shared';

/**
 * The widget's design tokens, and the only thing a host may change about how it looks (FRU-35).
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
 * belonged where. FRU-53 settled on the whole word for all of it: tokens, classes and attributes.
 *
 * **FRU-35 changed no rendered colour.** Every colour was the hexadecimal already in the
 * stylesheets. FRU-51 then changed three values for contrast: `color-border-strong`,
 * `color-text-subtle` and `color-success`. FRU-93 changed the accent and four stage colours, and
 * gave the dark scheme its own accent and warning. `contrast.test.ts` measures every pair a module
 * paints, and no pair fails.
 *
 * **FRU-233 changed most of them, and FRU-292 changes them again.** The mock-up of 2026-10-13 had
 * left the warm stone greys for a neutral zinc scale. The mock-up of 2026-10-20 brings the stone
 * greys back, and gives the five stages new colours: olive for new, green for to do, amber for in
 * progress, red for done, brown for closed. The tables of old and new values are in
 * docs/decisions/widget.md. The names of the stages do not change: they are the contract.
 *
 * **One accent per surface** (FRU-292). The widget keeps the red #dd2c27; the extension paints its
 * own pages in #c2410c. The greys, the statuses, the shadows and the radii are shared, and
 * apps/extension/src/design-tokens.test.ts compares them.
 *
 * One thing does move, by 4 pixels: the thread's shadow was `0 10px 34px rgba(0, 0, 0, 0.18)` and the
 * panel's `0 10px 30px rgb(0 0 0 / 18%)` — the same intention spelled twice. They are one token now.
 *
 * **Radii are tokenised now, and only because the scale was shortened first** (FRU-36). FRU-35 left
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
  'color-accent-strong',
  'color-on-accent',
  'color-on-chip',
  'color-on-stage',
  'color-on-stage-ripening',
  'color-on-warning',
  'color-surface',
  'color-surface-raised',
  'color-surface-sunken',
  'color-surface-warm',
  'color-border',
  'color-border-strong',
  'color-text',
  'color-text-muted',
  'color-text-subtle',
  'color-chip',
  'color-ink',
  'color-on-ink',
  'color-on-ink-muted',
  'color-success',
  'color-warning',
  'color-unplaced',
  'stage-seeded',
  'stage-green',
  'stage-ripening',
  'stage-ripe',
  'stage-composted',
  'shadow-xs',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'radius-sm',
  'radius-field',
  'radius-md',
  'radius-lg',
  'radius-pill',
  'font-sans',
  'font-mono',
  'duration-fast',
  'duration-slow',
  'ease-out',
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

/**
 * What is written on a pin of this stage (FRU-233): its number, or the mark of an approximate place.
 *
 * One stage has a token of its own for its foreground. The amber of 2026-10-13 needed dark text;
 * the amber of 2026-10-20 holds white (4.78:1), so the token now holds white too. It stays because a
 * host may have set it. The others fall back to the shared `color-on-stage`, so a host that set that
 * one token keeps what it set.
 */
export function onStageToken(stage: SeedStage): string {
  return `var(--fruitback-color-on-stage-${stage}, var(--fruitback-color-on-stage))`;
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
  /*
    The accent of the widget. The extension has an accent of its own (#c2410c, FRU-292): one accent per
    surface, so the widget keeps the red that lies on the host's page.
  */
  --fruitback-color-accent: #dd2c27;
  /* A main button under the pointer, and the launch button while it is pressed. White on it is 6.47:1. */
  --fruitback-color-accent-strong: #b91c1c;
  /*
    One foreground per filled background, and not one shared by all of them.
    All four hold #fff in the light scheme, which is why a single on-accent looked harmless: the original CSS said
    color:#fff in five places, and naming it after the accent coupled three elements whose background
    is something else — the gear on the chip, every pin badge on its stage, the orphan chip on the
    warning. A host pairing a pale accent with a dark foreground would have turned those three into
    dark text on unchanged dark fills. Caught in review on FRU-35.
  */
  --fruitback-color-on-accent: #fff;
  --fruitback-color-on-chip: #fff;
  --fruitback-color-on-stage: #fff;
  /*
    White holds on the amber of the mock-up of 2026-10-20 (4.78:1), so « in progress » is written
    white like the four others. The token stays: a host may have set it.
  */
  --fruitback-color-on-stage-ripening: #fff;
  --fruitback-color-on-warning: #fff;
  --fruitback-color-surface: #fff;
  --fruitback-color-surface-raised: #fafaf9;
  /* Under a thing that is chosen: the rail of the tabs, the note of the list that is open. */
  --fruitback-color-surface-sunken: #f5f5f4;
  /* The block that quotes the selector and the source of a note, and the head of the composer. */
  --fruitback-color-surface-warm: #fffdf9;
  --fruitback-color-border: #e7e5e4;
  /* The border of a field. 3.49:1 on the surface. */
  --fruitback-color-border-strong: #8f8883;
  --fruitback-color-text: #1c1917;
  /*
    The mock-up draws #78716c. That is 4.40:1 on the sunken surface, under what text needs, so the
    muted text is one step darker: 4.59:1 there, 4.98:1 on the surface.
  */
  --fruitback-color-text-muted: #756e69;
  --fruitback-color-text-subtle: #57534e;
  --fruitback-color-chip: #44403c;
  /*
    The capsule that says what a click does while a note is being placed. It lies on the page of the
    host, like the dock, so it is the same ink in both schemes.
  */
  --fruitback-color-ink: #1c1917;
  --fruitback-color-on-ink: #fff;
  --fruitback-color-on-ink-muted: #d6d3d1;
  --fruitback-color-success: #3f6421;
  /* No warning text in the mock-up. An amber that holds as text (5.02:1) and under white text (5.02:1). */
  --fruitback-color-warning: #b45309;
  /* The dashed outline of a note whose element is gone: the brown of « closed », 4.62:1 on the surface. */
  --fruitback-color-unplaced: #8d6e63;

  /*
    The five statuses of the mock-up of 2026-10-20 (FRU-292): new, to do, in progress, done, closed.
    The names are the stages of the contract, which do not change. Each one holds white at 4.62:1 or
    more, and is 4.62:1 or more on the surface.
  */
  --fruitback-stage-seeded: #6a7950;
  --fruitback-stage-green: #56802e;
  --fruitback-stage-ripening: #ac5f00;
  --fruitback-stage-ripe: #dd2c27;
  --fruitback-stage-composted: #8d6e63;

  /* Named for the elevation they belong to, not for a size, so a fifth one has to justify itself. */
  --fruitback-shadow-xs: 0 1px 3px rgba(28, 25, 23, 0.15);
  --fruitback-shadow-sm: 0 3px 10px rgba(28, 25, 23, 0.28);
  --fruitback-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.25);
  --fruitback-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.18);
  --fruitback-shadow-xl: 0 14px 40px rgba(28, 25, 23, 0.22);

  /* Five steps, and each one is a decision: a chip, a field, a control, a surface, a pill. */
  --fruitback-radius-sm: 6px;
  --fruitback-radius-field: 8px;
  --fruitback-radius-md: 10px;
  --fruitback-radius-lg: 14px;
  --fruitback-radius-pill: 999px;

  --fruitback-font-sans: -apple-system, system-ui, sans-serif;
  --fruitback-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

  --fruitback-duration-fast: 220ms;
  --fruitback-duration-slow: 420ms;
  /* Arrives fast and settles with no overshoot. */
  --fruitback-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

/*
  A widget that overlays a dark site with a white popover at three in the morning is a widget they
  turn off. Colours and shadows move — a shadow tuned for a white surface is invisible on a dark one —
  and the durations do not.

  The mock-up of 2026-10-20 draws no dark scheme. This one is derived from its tokens: the same stone
  scale read from its other end (900, 800, 700), and every pair measured by contrast.test.ts.
*/
@media (prefers-color-scheme: dark) {
  :host {
    /*
      The accent and the warning are a fill under text and also text on the surface. No red holds
      white text at 4.5:1 and is also readable on a dark surface, so the dark scheme uses a lighter
      fill with dark text on it (FRU-93): 5.68:1 on the surface, 4.92:1 on the raised surface.
    */
    --fruitback-color-accent: #ec6a65;
    --fruitback-color-accent-strong: #f08a85;
    --fruitback-color-on-accent: #1c1917;
    --fruitback-color-warning: #fbbf24;
    --fruitback-color-on-warning: #1c1917;
    /*
      The five stages keep their values. A pin lies on the page of the host, and each one is also
      3:1 or more on the dark surface, where it is the mark of a note in the list: from 3.66:1 for
      the amber to 3.78:1 for the brown.
    */
    --fruitback-color-surface: #1c1917;
    --fruitback-color-surface-raised: #292524;
    --fruitback-color-surface-sunken: #312c29;
    --fruitback-color-surface-warm: #221e1b;
    --fruitback-color-border: #44403c;
    --fruitback-color-border-strong: #8f8883;
    --fruitback-color-text: #f5f5f4;
    --fruitback-color-text-muted: #a8a29e;
    --fruitback-color-text-subtle: #d6d3d1;
    --fruitback-color-chip: #57534e;
    --fruitback-color-success: #9bc46a;
    --fruitback-shadow-xs: 0 1px 3px rgba(0, 0, 0, 0.5);
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
