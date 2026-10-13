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
 * **FRU-233 changes most of them, on purpose.** The mock-up of 2026-10-13 (« simpler flow »,
 * design/simpler-flow) leaves the warm stone greys for a neutral zinc scale, and the five « fruit »
 * colours of the stages for five plain status colours: red for new, blue for to do, amber for in
 * progress, green for done, slate for closed. The table of old and new values is in
 * docs/decisions/widget.md. The names of the stages do not change: they are the contract.
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
 * One stage has a foreground of its own. Amber holds white at 2.15:1 and the ink at 8.25:1, so
 * « in progress » is written dark, as the mock-up draws it. The others fall back to the shared
 * `color-on-stage`, so a host that set that one token keeps what it set.
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
  /* Amber is the one stage that white cannot be read on: 2.15:1. The ink on it is 8.25:1. */
  --fruitback-color-on-stage-ripening: #18181b;
  --fruitback-color-on-warning: #fff;
  --fruitback-color-surface: #fff;
  --fruitback-color-surface-raised: #fafafa;
  /* Under a thing that is chosen: the rail of the tabs, the note of the list that is open. */
  --fruitback-color-surface-sunken: #f4f4f5;
  --fruitback-color-border: #e4e4e7;
  --fruitback-color-border-strong: #8a8a93;
  --fruitback-color-text: #18181b;
  --fruitback-color-text-muted: #6b6b74;
  --fruitback-color-text-subtle: #52525b;
  --fruitback-color-chip: #3f3f46;
  /*
    The banner that says what a click does while a note is being placed. It lies on the page of the
    host, like the dock, so it is the same ink in both schemes.
  */
  --fruitback-color-ink: #18181b;
  --fruitback-color-on-ink: #fff;
  --fruitback-color-on-ink-muted: #a1a1aa;
  --fruitback-color-success: #15803d;
  /*
    The mock-up draws no warning text. This is its amber, darkened until it holds as text (5.02:1 on
    the surface) and under white text (5.02:1).
  */
  --fruitback-color-warning: #b45309;
  /* The dashed outline of a note whose element is gone. A drawing, not text: 3.19:1 on the surface. */
  --fruitback-color-unplaced: #d97706;

  /*
    Five plain status colours (FRU-233): new, to do, in progress, done, closed. The names are the
    stages of the contract, which do not change. Each one holds its foreground at 4.5:1 or more,
    white for four of them and the ink for the amber. Four of them are 3:1 or more on the surface.
    The amber is 2.15:1 on white, as the mock-up draws it: a status is never said by its colour
    alone, a word or a number is always beside it. contrast.test.ts names that one pair.
  */
  --fruitback-stage-seeded: #dd2c27;
  --fruitback-stage-green: #2563eb;
  --fruitback-stage-ripening: #f59e0b;
  --fruitback-stage-ripe: #15803d;
  --fruitback-stage-composted: #64748b;

  /* Named for the elevation they belong to, not for a size, so a fifth one has to justify itself. */
  --fruitback-shadow-xs: 0 1px 3px rgba(24, 24, 27, 0.12);
  --fruitback-shadow-sm: 0 3px 10px rgba(24, 24, 27, 0.28);
  --fruitback-shadow-md: 0 4px 18px rgba(0, 0, 0, 0.25);
  --fruitback-shadow-lg: 0 10px 30px rgb(0 0 0 / 18%);
  --fruitback-shadow-xl: 0 14px 40px rgba(24, 24, 27, 0.22);

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

  The mock-up of FRU-233 draws no dark scheme. This one is derived from its tokens: the same zinc
  scale read from its other end, and every pair measured by contrast.test.ts.
*/
@media (prefers-color-scheme: dark) {
  :host {
    /*
      The accent and the warning are a fill under text and also text on the surface. No red holds
      white text at 4.5:1 and is also readable on a dark surface, so the dark scheme uses a lighter
      fill with dark text on it (FRU-93). The red the mock-up draws on its dark rail, #ec5b57, is
      4.40:1 on the raised surface, under what text needs: this one is 4.83:1 there.
    */
    --fruitback-color-accent: #ec6a65;
    --fruitback-color-accent-strong: #f28b87;
    --fruitback-color-on-accent: #18181b;
    --fruitback-color-warning: #fbbf24;
    --fruitback-color-on-warning: #18181b;
    /*
      The five stages keep their values. A pin lies on the page of the host, and each one is also
      3:1 or more on the dark surface, where it is the mark of a note in the list: from 3.43:1 for
      the blue to 8.25:1 for the amber.
    */
    --fruitback-color-surface: #18181b;
    --fruitback-color-surface-raised: #27272a;
    --fruitback-color-surface-sunken: #2e2e33;
    --fruitback-color-border: #3f3f46;
    --fruitback-color-border-strong: #71717a;
    --fruitback-color-text: #f4f4f5;
    --fruitback-color-text-muted: #a1a1aa;
    --fruitback-color-text-subtle: #d4d4d8;
    --fruitback-color-chip: #52525b;
    --fruitback-color-success: #4ade80;
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
