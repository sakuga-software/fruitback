/**
 * The appearance of the console (FRU-694): a theme, a mode, the tint of the sidebar, an accent, the
 * density of the rows, the radius and the size of the text. Each member picks their own.
 *
 * The appearance only sets the tokens of `theme.css` and `app.css`: each one is a CSS variable on
 * `:root`, which every utility reads through `var()`. It writes them on `<html>` as inline custom
 * properties, and the console follows at once. It adds no style of its own.
 *
 * The sidebar has its own copy of the colours: `theme.css` points the tokens of `.kit-rail` to the
 * variables `--sidebar-*`, which follow the page unless a tint sets them. So an ink sidebar on a light
 * page writes its words light, and its focus ring stays visible on it.
 *
 * Where the choice is kept (FRU-716): with the account (« Only for you, on this account »), by
 * `POST /console/me/appearance`, and `GET /console/me` answers it. Each answer of `/console/me`
 * writes the choice of the account in this browser (`adoptAppearance`), or takes the one kept here
 * away when the account has none: the choice of one account never shows for another one in this
 * browser. A sign-out takes it away too. The copy in this browser (`localStorage`) is what
 * `public/appearance.js` writes on `<html>` before the first paint, so a page never shows Slate first
 * and the chosen theme after.
 *
 * Every colour is a value here, in a `.ts` file: a screen writes the name of a token, never a value
 * (`tokens.test.ts`). `appearance.test.ts` computes the contrast of every pair of every theme, tint
 * and accent.
 */

/** The colours of one theme: each key is one CSS variable (`VARIABLES`). */
export type Palette = {
  /** `light` or `dark`: the `color-scheme` of the page, for its scroll bars and its native controls. */
  scheme: 'light' | 'dark';
  ink: string;
  inkSoft: string;
  muted: string;
  page: string;
  sidebar: string;
  subtle: string;
  hover: string;
  selected: string;
  chip: string;
  line: string;
  control: string;
  done: string;
  avatar: string;
  /** What is written on ink and on an avatar: white on a light theme, ink on a dark one. */
  onInk: string;
  /** A red word, an error, the danger of a deletion. It never follows the accent. */
  accentStrong: string;
  /** What is written on the red of a deletion. */
  onDanger: string;
  /** What is written on `done`. */
  onDone: string;
  /** The border of the danger zone (FRU-693). */
  dangerLine: string;
  /** The panels of HeroUI that the kit does not name: a second and a third surface, a segment. */
  surfaceSecondary: string;
  surfaceTertiary: string;
};

/** The CSS variable of each colour of a palette. */
export const VARIABLES: Readonly<Record<Exclude<keyof Palette, 'scheme'>, string>> = {
  ink: '--color-ink',
  inkSoft: '--color-ink-soft',
  muted: '--muted',
  page: '--color-page',
  sidebar: '--color-sidebar',
  subtle: '--color-subtle',
  hover: '--color-hover',
  selected: '--color-selected',
  chip: '--color-chip',
  line: '--color-line',
  control: '--color-control',
  done: '--color-done',
  avatar: '--color-avatar',
  onInk: '--color-on-ink',
  accentStrong: '--color-accent-strong',
  onDanger: '--danger-foreground',
  onDone: '--success-foreground',
  dangerLine: '--color-danger-line',
  surfaceSecondary: '--surface-secondary',
  surfaceTertiary: '--surface-tertiary',
};

/** The variable of the `color-scheme` of the page, which `app.css` reads. */
export const SCHEME = '--scheme';

/** The three colours of an accent: the fill, what is written on it, the fill under the pointer. */
export type AccentColours = { accent: string; on: string; hover: string };

/** The CSS variables of an accent. `--color-accent` is HeroUI's name, which the focus ring reads. */
export const ACCENT_VARIABLES: Readonly<Record<keyof AccentColours, readonly string[]>> = {
  accent: ['--accent', '--color-accent', '--focus'],
  on: ['--accent-foreground'],
  hover: ['--accent-hover'],
};

/**
 * The colours of the sidebar that follow its tint: `theme.css` points each of these tokens of
 * `.kit-rail` to `--sidebar-<variable>`. `appearance.test.ts` holds the two lists together.
 */
export const SIDEBAR_KEYS = [
  'ink',
  'inkSoft',
  'muted',
  'page',
  'subtle',
  'hover',
  'selected',
  'chip',
  'line',
  'control',
  'done',
  'avatar',
  'onInk',
  'accentStrong',
] as const satisfies readonly (keyof Palette)[];

/** The name of the variable a sidebar reads in place of `variable`: `--color-ink` → `--sidebar-color-ink`. */
export function sidebarVariable(variable: string): string {
  return `--sidebar-${variable.slice(2)}`;
}

/** Slate, the default (FRU-683): the values of `theme.css` and `app.css`, which a test compares. */
const SLATE: Palette = {
  scheme: 'light',
  ink: '#0f172a',
  inkSoft: '#334155',
  muted: '#5b6779',
  page: '#ffffff',
  sidebar: '#f1f4f8',
  subtle: '#f7f9fb',
  hover: '#e8edf3',
  selected: '#e2e8f0',
  chip: '#e8edf3',
  line: '#e3e8ef',
  control: '#7b8797',
  done: '#166534',
  avatar: '#334155',
  onInk: '#ffffff',
  accentStrong: '#b91c1c',
  onDanger: '#ffffff',
  onDone: '#ffffff',
  dangerLine: '#f1c2c0',
  surfaceSecondary: '#f7f9fb',
  surfaceTertiary: '#e8edf3',
};

/** Snow: a white sidebar on a white page, and cool greys. */
const SNOW: Palette = {
  ...SLATE,
  ink: '#111827',
  inkSoft: '#374151',
  muted: '#566070',
  sidebar: '#ffffff',
  subtle: '#f9fafb',
  hover: '#f1f3f6',
  selected: '#eaedf1',
  chip: '#f1f3f6',
  line: '#e5e7eb',
  control: '#7a8290',
  avatar: '#374151',
  surfaceSecondary: '#f9fafb',
  surfaceTertiary: '#f1f3f6',
};

/** Zinc: neutral greys, with no blue in them. */
const ZINC: Palette = {
  ...SLATE,
  ink: '#18181b',
  inkSoft: '#3f3f46',
  muted: '#5f5f69',
  sidebar: '#f4f4f5',
  subtle: '#fafafa',
  hover: '#ebebed',
  selected: '#e4e4e7',
  chip: '#ebebed',
  line: '#e4e4e7',
  control: '#818189',
  avatar: '#3f3f46',
  surfaceSecondary: '#fafafa',
  surfaceTertiary: '#ebebed',
};

/** Midnight: a blue night. The sidebar is darker than the page. */
const MIDNIGHT: Palette = {
  scheme: 'dark',
  ink: '#e2e8f0',
  inkSoft: '#cbd5e1',
  muted: '#94a3b8',
  page: '#111a2e',
  sidebar: '#0b1220',
  subtle: '#16213a',
  hover: '#1e293b',
  selected: '#22304a',
  chip: '#1e293b',
  line: '#22304a',
  control: '#6b7a90',
  done: '#4ade80',
  avatar: '#94a3b8',
  onInk: '#0b1220',
  accentStrong: '#fca5a5',
  onDanger: '#0b1220',
  onDone: '#0b1220',
  dangerLine: '#7f1d1d',
  surfaceSecondary: '#16213a',
  surfaceTertiary: '#1e293b',
};

/** Graphite: a neutral night. */
const GRAPHITE: Palette = {
  ...MIDNIGHT,
  ink: '#f4f4f5',
  inkSoft: '#d4d4d8',
  muted: '#a1a1aa',
  page: '#1f1f23',
  sidebar: '#18181b',
  subtle: '#26262b',
  hover: '#2e2e33',
  selected: '#36363c',
  chip: '#2e2e33',
  line: '#2e2e33',
  control: '#76767f',
  avatar: '#a1a1aa',
  onInk: '#18181b',
  onDanger: '#18181b',
  onDone: '#18181b',
  surfaceSecondary: '#26262b',
  surfaceTertiary: '#2e2e33',
};

export type PresetId = 'slate' | 'snow' | 'zinc' | 'midnight' | 'graphite';

/** The five themes, in the order of the mockup. No beige (the ticket). */
export const PRESETS: Readonly<Record<PresetId, Palette>> = {
  slate: SLATE,
  snow: SNOW,
  zinc: ZINC,
  midnight: MIDNIGHT,
  graphite: GRAPHITE,
};
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const LIGHT_PRESETS = PRESET_IDS.filter((id) => PRESETS[id].scheme === 'light');
export const DARK_PRESETS = PRESET_IDS.filter((id) => PRESETS[id].scheme === 'dark');

/** The tint of the sidebar, from the page to ink. `theme` is the sidebar of the theme. */
export type Tint = 'page' | 'faint' | 'theme' | 'deep' | 'ink';
export const TINTS: readonly Tint[] = ['page', 'faint', 'theme', 'deep', 'ink'];

/**
 * The sidebar of a theme for each tint: what changes from the theme. A light tint changes the ground
 * and, where the ground is darker, the hover and the selection under it. The ink of a light theme is a
 * night: the sidebar takes the night of its family, so its words are light.
 */
const LIGHT_TINTS: Readonly<Record<Exclude<PresetId, 'midnight' | 'graphite'>, Record<Tint, Partial<Palette>>>> = {
  slate: {
    page: { sidebar: '#ffffff' },
    faint: { sidebar: '#f7f9fb' },
    theme: {},
    deep: { sidebar: '#e8edf3', hover: '#dce3eb', selected: '#d5dde7', chip: '#dce3eb', muted: '#4f5b6d' },
    ink: {
      ...MIDNIGHT,
      sidebar: '#1e293b',
      hover: '#273449',
      selected: '#2c3b55',
      line: '#334155',
      page: '#0f172a',
      muted: '#a9b6c8',
    },
  },
  snow: {
    page: { sidebar: '#ffffff' },
    faint: { sidebar: '#f9fafb' },
    theme: {},
    deep: { sidebar: '#f1f3f6', hover: '#e5e8ed', selected: '#dde1e7', chip: '#e5e8ed', muted: '#4f5866' },
    ink: {
      ...MIDNIGHT,
      sidebar: '#1f2937',
      hover: '#29333f',
      selected: '#2e3947',
      line: '#374151',
      page: '#111827',
      muted: '#a9b4c2',
    },
  },
  zinc: {
    page: { sidebar: '#ffffff' },
    faint: { sidebar: '#fafafa' },
    theme: {},
    deep: { sidebar: '#e9e9eb', hover: '#e0e0e3', selected: '#dbdbde', chip: '#e0e0e3', muted: '#55555e' },
    ink: {
      ...GRAPHITE,
      sidebar: '#27272a',
      hover: '#313135',
      selected: '#36363b',
      line: '#3f3f46',
      page: '#18181b',
      muted: '#b0b0b8',
    },
  },
};

/** The tints of a night: from its page, lighter than its sidebar, to the darkest. */
const DARK_TINTS: Readonly<Record<'midnight' | 'graphite', Record<Tint, Partial<Palette>>>> = {
  midnight: {
    page: { sidebar: '#111a2e' },
    faint: { sidebar: '#0e1627' },
    theme: {},
    deep: { sidebar: '#080e1a' },
    ink: { sidebar: '#04070e' },
  },
  graphite: {
    page: { sidebar: '#1f1f23' },
    faint: { sidebar: '#1b1b1f' },
    theme: {},
    deep: { sidebar: '#131316' },
    ink: { sidebar: '#0a0a0b' },
  },
};

/** The colours of the sidebar of `preset` with `tint`. */
export function sidebarPalette(preset: PresetId, tint: Tint): Palette {
  const tints = preset === 'midnight' || preset === 'graphite' ? DARK_TINTS[preset] : LIGHT_TINTS[preset];

  return { ...PRESETS[preset], ...tints[tint] };
}

export type AccentId = 'red' | 'orange' | 'teal' | 'blue' | 'indigo' | 'ink';
export const ACCENT_IDS: readonly AccentId[] = ['red', 'orange', 'teal', 'blue', 'indigo', 'ink'];

/**
 * The six accents of the mockup, for a light ground and for a dark one. On a light ground white is
 * written on the accent; on a dark one the accent is lighter, so the ring shows, and ink is written
 * on it. Red is the red of Fruitback.
 */
export const ACCENTS: Readonly<Record<AccentId, Record<'light' | 'dark', AccentColours>>> = {
  red: {
    light: { accent: '#dd2c27', on: '#ffffff', hover: '#b91c1c' },
    dark: { accent: '#dc2626', on: '#ffffff', hover: '#b91c1c' },
  },
  orange: {
    light: { accent: '#c2410c', on: '#ffffff', hover: '#9a3412' },
    dark: { accent: '#fb923c', on: '#0b1220', hover: '#fdba74' },
  },
  teal: {
    light: { accent: '#0f766e', on: '#ffffff', hover: '#115e59' },
    dark: { accent: '#2dd4bf', on: '#0b1220', hover: '#5eead4' },
  },
  blue: {
    light: { accent: '#2563eb', on: '#ffffff', hover: '#1d4ed8' },
    dark: { accent: '#60a5fa', on: '#0b1220', hover: '#93c5fd' },
  },
  indigo: {
    light: { accent: '#5560c4', on: '#ffffff', hover: '#4349a8' },
    dark: { accent: '#a5b4fc', on: '#0b1220', hover: '#c7d2fe' },
  },
  ink: {
    light: { accent: '#0f172a', on: '#ffffff', hover: '#334155' },
    dark: { accent: '#e2e8f0', on: '#0b1220', hover: '#cbd5e1' },
  },
};

export type Mode = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'default' | 'comfortable';
/** The height of a row of a list or a table, by density (the mockup). */
export const ROW_HEIGHTS: Readonly<Record<Density, number>> = { compact: 32, default: 36, comfortable: 40 };
export const RADII = [0, 4, 6, 8] as const;
export type Radius = (typeof RADII)[number];
export const FONT_SIZES = [12, 13, 14] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/** What a person chose. `light` and `dark` are the theme of each mode: « System » picks one of them. */
export type Appearance = {
  mode: Mode;
  light: PresetId;
  dark: PresetId;
  sidebar: Tint;
  accent: AccentId;
  density: Density;
  radius: Radius;
  fontSize: FontSize;
};

/** Slate, light, as the console is with no choice (FRU-683). */
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'light',
  light: 'slate',
  dark: 'midnight',
  sidebar: 'theme',
  accent: 'red',
  density: 'default',
  radius: 6,
  fontSize: 13,
};

/** The theme on screen: the one of the mode, and of the system under « System ». */
export function presetOf(appearance: Appearance, systemDark: boolean): PresetId {
  const dark = appearance.mode === 'dark' || (appearance.mode === 'system' && systemDark);

  return dark ? appearance.dark : appearance.light;
}

/**
 * The choice of a theme. It becomes the theme of its mode, and the mode follows it, unless « System »
 * already shows that mode.
 */
export function choosePreset(appearance: Appearance, preset: PresetId, systemDark: boolean): Appearance {
  const scheme = PRESETS[preset].scheme;
  const shown = appearance.mode === 'system' && (systemDark ? 'dark' : 'light') === scheme;

  return { ...appearance, [scheme]: preset, mode: shown ? 'system' : scheme };
}

/** The variables of `palette` and of its accent, as `{ name: value }`. */
function paletteVariables(palette: Palette, accent: AccentColours): Record<string, string> {
  const written: Record<string, string> = {};
  for (const [key, variable] of Object.entries(VARIABLES)) written[variable] = palette[key as keyof typeof VARIABLES];
  for (const [key, variables] of Object.entries(ACCENT_VARIABLES))
    for (const variable of variables) written[variable] = accent[key as keyof AccentColours];

  return written;
}

/**
 * Every variable the appearance writes on `<html>`, for one theme: the page, the sidebar, the
 * scheme, the density, the radius and the size of the text.
 */
export function variablesOf(appearance: Appearance, preset: PresetId): Record<string, string> {
  const palette = PRESETS[preset];
  const side = sidebarPalette(preset, appearance.sidebar);
  const accent = ACCENTS[appearance.accent][palette.scheme];
  const sideAccent = ACCENTS[appearance.accent][side.scheme];
  const written: Record<string, string> = { ...paletteVariables(palette, accent), [SCHEME]: palette.scheme };
  // The ground of the sidebar is its tint: `bg-sidebar` is read in the sidebar alone.
  written[VARIABLES.sidebar] = side.sidebar;
  const sidebar = paletteVariables(side, sideAccent);
  for (const key of SIDEBAR_KEYS) written[sidebarVariable(VARIABLES[key])] = sidebar[VARIABLES[key]] as string;
  for (const [, variables] of Object.entries(ACCENT_VARIABLES))
    for (const variable of variables) written[sidebarVariable(variable)] = sidebar[variable] as string;

  const radius = appearance.radius;
  written['--radius-control'] = `${radius}px`;
  written['--radius-inner'] = `${Math.min(radius, 4)}px`;
  written['--radius-card'] = `${radius === 0 ? 0 : radius + 2}px`;
  written['--radius-modal'] = `${radius === 0 ? 0 : radius + 4}px`;
  written['--spacing-row'] = `${ROW_HEIGHTS[appearance.density]}px`;
  const size = appearance.fontSize;
  for (const name of ['--text-body', '--text-small', '--text-table', '--text-label']) written[name] = `${size}px`;
  written['--text-hint'] = `${size - 1}px`;
  written['--text-tiny'] = `${size - 2}px`;

  return written;
}

/** Where this browser keeps its copy of the choice of the account, for `public/appearance.js`. */
export const STORAGE_KEY = 'fruitback.appearance';

/**
 * What is kept: the choice, and the variables of its light and dark themes, which
 * `public/appearance.js` writes before the first paint with no other code.
 */
export type Kept = { appearance: Appearance; light: Record<string, string>; dark: Record<string, string> };

function isOneOf<Value>(list: readonly Value[], value: unknown): value is Value {
  return list.includes(value as Value);
}

/** A choice read back, each field checked: what is not a known value is the default. */
export function readAppearance(value: unknown): Appearance {
  const read = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const pick = <Value>(list: readonly Value[], key: keyof Appearance): Value =>
    isOneOf(list, read[key]) ? read[key] : (DEFAULT_APPEARANCE[key] as Value);

  return {
    mode: pick<Mode>(['light', 'dark', 'system'], 'mode'),
    light: pick(LIGHT_PRESETS, 'light'),
    dark: pick(DARK_PRESETS, 'dark'),
    sidebar: pick(TINTS, 'sidebar'),
    accent: pick(ACCENT_IDS, 'accent'),
    density: pick<Density>(['compact', 'default', 'comfortable'], 'density'),
    radius: pick(RADII, 'radius'),
    fontSize: pick(FONT_SIZES, 'fontSize'),
  };
}

/** The choice kept in this browser, or the default. A storage that throws is no choice. */
export function keptAppearance(storage: Pick<Storage, 'getItem'> | undefined): Appearance {
  try {
    const kept = storage?.getItem(STORAGE_KEY);

    return readAppearance(kept === null || kept === undefined ? undefined : (JSON.parse(kept) as Kept).appearance);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Whether a choice is the default one: then nothing is kept and nothing is written on `<html>`. */
export function isDefault(appearance: Appearance): boolean {
  return (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every(
    (key) => appearance[key] === DEFAULT_APPEARANCE[key],
  );
}

/** Every variable the appearance may write, so a change of choice or « Reset » takes all of them away. */
export function writtenNames(): string[] {
  return Object.keys(variablesOf(DEFAULT_APPEARANCE, 'slate'));
}

/**
 * Writes `appearance` on `root` for the theme of the mode, and keeps it in `storage`. The default
 * writes nothing and keeps nothing: the tokens of the stylesheets are the default. Answers whether
 * the storage took the choice: with no storage, or one that refused it, the choice shows in this tab
 * only.
 */
export function applyAppearance(
  appearance: Appearance,
  root: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> },
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  systemDark: boolean,
): boolean {
  for (const name of writtenNames()) root.style.removeProperty(name);
  const preset = presetOf(appearance, systemDark);
  // With no storage, the default is still what the next visit shows: nothing was lost.
  let kept = storage !== undefined || isDefault(appearance);
  try {
    if (isDefault(appearance)) storage?.removeItem(STORAGE_KEY);
    else {
      const kept: Kept = {
        appearance,
        light: variablesOf(appearance, appearance.light),
        dark: variablesOf(appearance, appearance.dark),
      };
      storage?.setItem(STORAGE_KEY, JSON.stringify(kept));
    }
  } catch {
    // A storage that is full or refused: the choice still shows in this tab, and the page says so.
    kept = false;
  }
  if (!isDefault(appearance))
    for (const [name, value] of Object.entries(variablesOf(appearance, preset))) root.style.setProperty(name, value);

  return kept;
}

/** Whether the system of this browser asks for a dark page. */
export function systemIsDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Keeps the page in step with the choice while it is open: under « System », a change of the system
 * changes the theme; a choice made in another tab of this browser shows here too. Returns what stops
 * it.
 */
export function followAppearance(): () => void {
  const local = (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })();
  const again = () => applyAppearance(keptAppearance(local), document.documentElement, undefined, systemIsDark());
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) again();
  };
  media?.addEventListener('change', again);
  window.addEventListener('storage', onStorage);

  return () => {
    media?.removeEventListener('change', again);
    window.removeEventListener('storage', onStorage);
  };
}

/** Sends a choice to the account, `null` for the default. `false` when the account did not take it. */
export type SaveAppearance = (appearance: Appearance | null) => Promise<boolean>;

/**
 * Sends each choice to the account (FRU-716), one request at a time. A choice made while one is on
 * its way waits for it, and only the last one waiting leaves: a run of presses on the accents sends
 * two requests, not one per press, and never lands out of order. Answers whether the account took the
 * last choice made.
 */
export function appearanceSender(save: SaveAppearance): {
  send: (appearance: Appearance) => Promise<boolean>;
  /** A choice is on its way, or waits: what the account answers is older than what is on screen. */
  busy: () => boolean;
  /**
   * A sign-out: a choice that waits never leaves. Sent later, it would carry the cookie of whoever
   * signs in next in this tab, and write the choice of one person on the account of another. A
   * request already on its way carries the cookie of the person who chose, so it ends as it is; it no
   * longer makes the sender busy, so the `/console/me` of the next person is adopted at once.
   */
  drop: () => void;
} {
  let flight: Promise<boolean> | undefined;
  let waiting: Appearance | undefined;
  // The run of before the last sign-out: it ends, and is busy for nobody.
  let dropped: Promise<boolean> | undefined;
  const one = async (appearance: Appearance): Promise<boolean> =>
    save(isDefault(appearance) ? null : appearance).catch(() => false);
  const drain = async (): Promise<boolean> => {
    let heard = false;
    while (waiting !== undefined) {
      const next = waiting;
      waiting = undefined;
      heard = await one(next);
    }

    return heard;
  };
  // Every caller gets the answer to the last request of the run, which carries the last choice.
  const send = (appearance: Appearance): Promise<boolean> => {
    waiting = appearance;
    flight ??= drain().finally(() => {
      flight = undefined;
    });

    return flight;
  };

  return {
    send,
    busy: () => flight !== undefined && flight !== dropped,
    drop: () => {
      waiting = undefined;
      dropped = flight;
    },
  };
}

/** The sender of this tab, set by `keepWithAccount`; `adoptAppearance` waits behind it. */
let sender: ReturnType<typeof appearanceSender> | undefined;

/** Sends `appearance` to the account through the one sender of this tab. */
export function keepWithAccount(appearance: Appearance, save: SaveAppearance): Promise<boolean> {
  sender ??= appearanceSender(save);

  return sender.send(appearance);
}

/**
 * Writes the choice an account holds on this page and in this browser (FRU-716), or the default when
 * it holds none: the choice another account left in this browser goes. A choice still on its way to
 * the account wins: the answer read is older than it. A value the console does not know is read field
 * by field (`readAppearance`).
 */
export function adoptAppearance(
  account: { appearance?: unknown },
  root: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } | undefined = pageRoot(),
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = browserStorage(),
  systemDark = systemIsDark(),
): void {
  if (sender?.busy() === true) return;
  const chosen = readAppearance(account.appearance);
  // The same choice as the copy of this browser: nothing to write, and no `storage` event elsewhere.
  if (sameAppearance(chosen, keptAppearance(storage)) && kept(storage) === !isDefault(chosen)) return;
  applyAppearance(chosen, root ?? NO_ROOT, storage, systemDark);
}

/**
 * A sign-out (FRU-716): the next person of this browser starts from the default look, and a choice
 * that still waits to be sent never leaves (raised in review).
 */
export function forgetAppearance(
  root: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } | undefined = pageRoot(),
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = browserStorage(),
): void {
  sender?.drop();
  applyAppearance(DEFAULT_APPEARANCE, root ?? NO_ROOT, storage, false);
}

/** `<html>`, or none outside a page. */
function pageRoot(): HTMLElement | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement;
}

const NO_ROOT = { style: { setProperty: () => {}, removeProperty: () => '' } };

function sameAppearance(one: Appearance, other: Appearance): boolean {
  return (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every((key) => one[key] === other[key]);
}

/** Whether this browser holds a copy at all. */
function kept(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return (storage?.getItem(STORAGE_KEY) ?? null) !== null;
  } catch {
    return false;
  }
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
