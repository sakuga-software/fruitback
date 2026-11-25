import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCENTS,
  ACCENT_IDS,
  ACCENT_VARIABLES,
  type Appearance,
  DEFAULT_APPEARANCE,
  type Palette,
  PRESETS,
  PRESET_IDS,
  SIDEBAR_KEYS,
  STORAGE_KEY,
  TINTS,
  VARIABLES,
  applyAppearance,
  choosePreset,
  keptAppearance,
  presetOf,
  readAppearance,
  sidebarPalette,
  sidebarVariable,
  variablesOf,
} from './appearance.ts';

/**
 * The appearance of the console (FRU-694). Every theme, every tint of the sidebar and every accent
 * keeps the contrasts of WCAG 2.1 AA: 4.5:1 for a text, 3:1 for the border of a control and for the
 * focus ring (1.4.11). The pairs are the ones the console draws: `theme.test.ts` measures the same on
 * the default theme from the stylesheets.
 */
const APP = new URL('./', import.meta.url);
const theme = readFileSync(new URL('theme.css', APP), 'utf8');
const app = readFileSync(new URL('app.css', APP), 'utf8');
const sidebar = readFileSync(new URL('sidebar.css', APP), 'utf8');
const shared = readFileSync(new URL('../../../packages/shared/tailwind/theme.css', import.meta.url), 'utf8');

/** The contrast of two colours `#rrggbb`, as WCAG 2 computes it. */
function contrast(one: string, other: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;

      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

type Key = keyof Omit<Palette, 'scheme'>;
/** The texts, and the grounds each is written on. */
const TEXTS: readonly [Key, readonly Key[]][] = [
  ['ink', ['page', 'subtle', 'hover', 'selected', 'chip', 'sidebar']],
  ['inkSoft', ['page', 'subtle', 'hover', 'selected', 'chip', 'sidebar']],
  ['muted', ['page', 'subtle', 'hover', 'selected', 'sidebar']],
  ['accentStrong', ['page', 'subtle', 'hover', 'selected']],
  ['done', ['page', 'subtle', 'selected']],
  ['onInk', ['ink', 'avatar']],
  ['onDanger', ['accentStrong']],
  ['onDone', ['done']],
];

/** The pairs of `palette` under the ratio they need, as « text on ground: ratio ». */
function under(palette: Palette, ground: 'page' | 'sidebar', accent: { accent: string; on: string; hover: string }) {
  const failed: string[] = [];
  const check = (name: string, ratio: number, needed: number) => {
    if (ratio < needed) failed.push(`${name}: ${ratio.toFixed(2)}`);
  };
  for (const [text, grounds] of TEXTS)
    for (const on of grounds) check(`${text} on ${on}`, contrast(palette[text], palette[on]), 4.5);
  check(`control on ${ground}`, contrast(palette.control, palette[ground]), 3);
  check(`control on page`, contrast(palette.control, palette.page), 3);
  check(`ring on ${ground}`, contrast(accent.accent, palette[ground]), 3);
  check('on accent', contrast(accent.on, accent.accent), 4.5);
  check('on accent hover', contrast(accent.on, accent.hover), 4.5);

  return failed;
}

describe('the appearance of the console (FRU-694)', () => {
  it('keeps every contrast AA, on every theme with every accent', () => {
    const failed = PRESET_IDS.flatMap((preset) =>
      ACCENT_IDS.flatMap((accent) =>
        under(PRESETS[preset], 'page', ACCENTS[accent][PRESETS[preset].scheme]).map(
          (pair) => `${preset} ${accent}: ${pair}`,
        ),
      ),
    );

    assert.deepEqual(failed, []);
  });

  it('keeps every contrast AA in the sidebar, on every theme, tint and accent', () => {
    const failed = PRESET_IDS.flatMap((preset) =>
      TINTS.flatMap((tint) => {
        const side = sidebarPalette(preset, tint);

        return ACCENT_IDS.flatMap((accent) =>
          under(side, 'sidebar', ACCENTS[accent][side.scheme]).map((pair) => `${preset} ${tint} ${accent}: ${pair}`),
        );
      }),
    );

    assert.deepEqual(failed, []);
  });

  it('finds a pair under AA when there is one, so the checks above are not empty by accident', () => {
    // The control: the faint grey of the mockup of the notes, 3.16:1 on white, as the secondary text.
    const planted = { ...PRESETS.slate, muted: '#8592a3' };

    assert.deepEqual(under(planted, 'page', ACCENTS.red.light), [
      'muted on page: 3.16',
      'muted on subtle: 3.00',
      'muted on hover: 2.69',
      'muted on selected: 2.57',
      'muted on sidebar: 2.87',
    ]);
    // An accent in the colour of the page is no ring.
    assert.ok(under(PRESETS.midnight, 'page', ACCENTS.ink.light).some((pair) => pair.startsWith('ring on page')));
  });

  it('is the default theme of the stylesheets, value for value, on Slate', () => {
    const declared = (name: string) =>
      new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(theme)?.[1] ??
      new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(app)?.[1] ??
      new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(shared)?.[1];
    const resolve = (name: string): string | undefined => {
      const value = declared(name);
      const reference = value === undefined ? undefined : /^var\((--[\w-]+)\)$/.exec(value)?.[1];

      return reference === undefined ? value : resolve(reference);
    };
    // HeroUI's panels have no value in the stylesheets of the console: the appearance writes them.
    const ownedByHeroUI = new Set([
      '--surface-secondary',
      '--surface-tertiary',
      '--danger-foreground',
      '--success-foreground',
    ]);
    const differences = Object.entries(VARIABLES)
      .filter(([, variable]) => !ownedByHeroUI.has(variable))
      .filter(([key, variable]) => resolve(variable) !== PRESETS.slate[key as Key])
      .map(([key, variable]) => `${variable}: ${resolve(variable)} in the CSS, ${PRESETS.slate[key as Key]} here`);

    assert.deepEqual(differences, []);
    assert.equal(resolve('--accent'), ACCENTS.red.light.accent);
    assert.equal(resolve('--accent-hover'), ACCENTS.red.light.hover);
    assert.equal(resolve('--spacing-row'), '36px');
    assert.equal(resolve('--radius-control'), `${DEFAULT_APPEARANCE.radius}px`);
    assert.equal(resolve('--text-body'), `${DEFAULT_APPEARANCE.fontSize}px`);
  });

  it('gives the sidebar a copy of each token it reads, in sidebar.css, and no other', () => {
    const rail = /\.kit-rail \{([^}]*)\}/.exec(sidebar)?.[1] ?? '';
    const scoped = [...rail.matchAll(/(--[\w-]+):\s*var\((--[\w-]+)\);/g)].map(([, token, copy]) => [token, copy]);
    const expected = [...SIDEBAR_KEYS.map((key) => VARIABLES[key]), ...Object.values(ACCENT_VARIABLES).flat()].map(
      (variable) => [variable, sidebarVariable(variable)],
    );

    assert.deepEqual(scoped.slice().sort(), expected.slice().sort());
    // Each copy follows the page by default.
    for (const [token, copy] of expected)
      assert.match(
        sidebar,
        new RegExp(
          `^\\s*${copy}:\\s*var\\(${token === '--color-accent' || token === '--focus' ? '--accent' : token}\\);`,
          'm',
        ),
        `${copy} does not follow ${token}`,
      );
    assert.ok(scoped.length > 10, 'the rule of the sidebar was not read');
  });

  it('writes on <html> only CSS variables, every one of them each time', () => {
    const appearance: Appearance = { ...DEFAULT_APPEARANCE, light: 'zinc', sidebar: 'ink', accent: 'teal', radius: 0 };
    const written = variablesOf(appearance, 'zinc');

    assert.deepEqual(
      Object.keys(written).filter((name) => !/^--[a-z0-9-]+$/.test(name)),
      [],
    );
    assert.equal(written['--color-ink'], PRESETS.zinc.ink);
    // The ink sidebar of a light theme is dark, and writes its words light.
    assert.equal(written['--color-sidebar'], '#27272a');
    assert.equal(written['--sidebar-color-ink'], PRESETS.graphite.ink);
    assert.equal(written['--accent'], ACCENTS.teal.light.accent);
    assert.equal(written['--sidebar-accent'], ACCENTS.teal.dark.accent);
    assert.equal(written['--radius-control'], '0px');
    assert.equal(written['--radius-card'], '0px');
    assert.equal(written['--scheme'], 'light');
    assert.deepEqual(
      Object.keys(variablesOf(DEFAULT_APPEARANCE, 'midnight')).slice().sort(),
      Object.keys(written).slice().sort(),
    );
  });

  it('keeps a choice in this browser, and the default keeps nothing and writes nothing', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    };
    const style = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string | null) => void style.set(name, value ?? ''),
        removeProperty: (name: string) => {
          style.delete(name);
          return '';
        },
      },
    };
    const chosen: Appearance = { ...DEFAULT_APPEARANCE, mode: 'system', accent: 'blue', density: 'compact' };
    applyAppearance(chosen, root, storage, true);

    assert.deepEqual(keptAppearance(storage), chosen);
    // Under « System » with a dark system: the dark theme of the choice.
    assert.equal(style.get('--color-page'), PRESETS.midnight.page);
    assert.equal(style.get('--spacing-row'), '32px');
    // What public/appearance.js reads: the two themes, written before the first paint.
    const written = JSON.parse(kept.get(STORAGE_KEY) as string) as {
      light: Record<string, string>;
      dark: Record<string, string>;
    };
    assert.equal(written.light['--color-page'], PRESETS.slate.page);
    assert.equal(written.dark['--color-page'], PRESETS.midnight.page);

    applyAppearance(DEFAULT_APPEARANCE, root, storage, true);
    assert.equal(kept.size, 0);
    assert.equal(style.size, 0);

    // A storage that refuses: the choice shows on <html>, and the answer says it was not kept.
    const refusing = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    assert.equal(applyAppearance(chosen, root, refusing, false), false);
    assert.equal(style.get('--spacing-row'), '32px');
    assert.equal(applyAppearance(chosen, root, undefined, false), false);
    assert.equal(applyAppearance(chosen, root, storage, false), true);
  });

  it('reads back only known values, and a storage that throws as no choice', () => {
    assert.deepEqual(readAppearance({ mode: 'neon', light: 'midnight', radius: 5, accent: 'blue' }), {
      ...DEFAULT_APPEARANCE,
      accent: 'blue',
    });
    assert.deepEqual(readAppearance('nothing'), DEFAULT_APPEARANCE);
    assert.deepEqual(
      keptAppearance({
        getItem: () => {
          throw new Error('refused');
        },
      }),
      DEFAULT_APPEARANCE,
    );
    assert.deepEqual(keptAppearance({ getItem: () => '{not json' }), DEFAULT_APPEARANCE);
  });

  it('makes a theme the one of its mode, and keeps « System » when the system shows that mode', () => {
    const night = choosePreset(DEFAULT_APPEARANCE, 'graphite', false);
    assert.deepEqual([night.mode, night.dark, presetOf(night, false)], ['dark', 'graphite', 'graphite']);
    const system = choosePreset({ ...DEFAULT_APPEARANCE, mode: 'system' }, 'zinc', false);
    assert.deepEqual([system.mode, presetOf(system, false), presetOf(system, true)], ['system', 'zinc', 'midnight']);
    const back = choosePreset({ ...DEFAULT_APPEARANCE, mode: 'system' }, 'midnight', false);
    assert.equal(back.mode, 'dark');
  });
});

describe('the script that writes the appearance before the first paint (FRU-694)', () => {
  const script = readFileSync(new URL('../public/appearance.js', import.meta.url), 'utf8');

  it('reads the key the console keeps the choice under', () => {
    assert.ok(script.includes(`'${STORAGE_KEY}'`));
  });

  it('writes the variables of the mode on screen, and nothing that is not a custom property', () => {
    const style = new Map<string, string>();
    const run = (kept: unknown, dark: boolean) => {
      style.clear();
      const sandbox = {
        localStorage: { getItem: () => JSON.stringify(kept) },
        matchMedia: () => ({ matches: dark }),
        document: {
          documentElement: { style: { setProperty: (name: string, value: string) => void style.set(name, value) } },
        },
      };
      new Function('localStorage', 'matchMedia', 'document', script)(
        sandbox.localStorage,
        sandbox.matchMedia,
        sandbox.document,
      );

      return Object.fromEntries(style);
    };
    const kept = {
      appearance: { mode: 'system' },
      light: { '--color-page': '#ffffff' },
      dark: { '--color-page': '#111a2e', color: 'red', '--x': 3 },
    };

    assert.deepEqual(run(kept, false), { '--color-page': '#ffffff' });
    assert.deepEqual(run(kept, true), { '--color-page': '#111a2e' });
    assert.deepEqual(run(null, true), {});
    assert.deepEqual(run({ appearance: { mode: 'dark' } }, false), {});
  });
});
