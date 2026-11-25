import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * The tokens of the console (FRU-232), slate since FRU-683.
 *
 * `app.css` names each value of the mockup of 2026-10-13 once. A screen writes the name of a token
 * and never a value: a change of the palette is then a change of one file. The console has no DOM
 * under `node --test`, so the guard reads the sources; `e2e/console-kit.spec.ts` reads what a browser
 * computes.
 */
const APP = new URL('./', import.meta.url);
const css = readFileSync(new URL('app.css', APP), 'utf8');
/** The Tailwind theme the console shares with the extension, the widget and the docs (FRU-677). */
const theme = readFileSync(new URL('../../../packages/shared/tailwind/theme.css', import.meta.url), 'utf8');
/** The slate theme of the console alone (FRU-683), which sets tokens of the shared theme again. */
const own = readFileSync(new URL('theme.css', APP), 'utf8');

/** Every source of the console that draws something: the screens, their parts, the kit. */
function drawn(): Map<string, string> {
  const names = [
    ...readdirSync(new URL('routes/', APP)).map((name) => `routes/${name}`),
    ...readdirSync(new URL('parts/', APP)).map((name) => `parts/${name}`),
    ...readdirSync(APP).filter((name) => name.endsWith('.tsx')),
  ];

  return new Map(names.map((name) => [name, readFileSync(new URL(name, APP), 'utf8')]));
}

/**
 * The value of a custom property, as the console reads it: its own theme, then `app.css`, then the
 * shared theme. A var() is read in turn.
 */
function token(name: string): string | undefined {
  const declared = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm');
  const value = declared.exec(own)?.[1] ?? declared.exec(css)?.[1] ?? declared.exec(theme)?.[1];
  const reference = value === undefined ? undefined : /^var\((--[\w-]+)\)$/.exec(value)?.[1];

  return reference === undefined ? value : token(reference);
}

/** The palette of before the mockup: the warm greys, the green of the first boards. */
const BEFORE = ['#1c1917', '#e7e5e4', '#faf9f5', '#f6f4f1', '#736c67', '#8f8883', '#56802e', '#a8a29e', '#78716c'];

/** A colour written as a value: `#rgb`, `#rrggbb`, `rgb(…)`, `hsl(…)`, `oklch(…)`. */
const VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi;

describe('the tokens of the console (FRU-232)', () => {
  it('has the values of the mockup', () => {
    const expected: Record<string, string> = {
      '--background': '#ffffff',
      '--foreground': '#0f172a',
      '--muted': '#5b6779',
      '--default': '#e8edf3',
      '--accent': '#dd2c27',
      '--accent-hover': '#b91c1c',
      '--success': '#15803d',
      '--border': '#e3e8ef',
      '--separator': '#e3e8ef',
      '--focus': '#dd2c27',
      '--field-foreground': '#0f172a',
      '--field-placeholder': '#5b6779',
      '--field-border': '#7b8797',
      '--field-radius': '6px',
      '--color-ink': '#0f172a',
      '--color-ink-soft': '#334155',
      '--color-line': '#e3e8ef',
      '--color-control': '#7b8797',
      '--color-page': '#ffffff',
      '--color-subtle': '#f7f9fb',
      '--color-chip': '#e8edf3',
      '--color-accent-strong': '#b91c1c',
      '--color-done': '#15803d',
      '--color-avatar': '#334155',
      '--color-rail': '#18181b',
      '--color-rail-active': '#27272a',
      '--color-rail-text': '#d4d4d8',
      '--color-rail-muted': '#a1a1aa',
      '--color-rail-accent': '#ec5b57',
      '--color-on-ink': '#ffffff',
      '--color-google-blue': '#4285f4',
      '--color-google-green': '#34a853',
      '--color-google-yellow': '#fbbc05',
      '--color-google-red': '#ea4335',
      '--color-status-new': '#bec2c8',
      '--color-status-todo': '#d9dbdf',
      '--color-status-progress': '#f3bb3d',
      '--color-status-done': '#5560c4',
      '--color-status-closed': '#a52a3a',
      '--color-status-edge': '#8a8a93',
      '--shadow-frame': '0 10px 30px rgba(15, 23, 42, 0.08)',
      '--ease-settle': 'cubic-bezier(0.16, 1, 0.3, 1)',
      '--duration-fast': '220ms',
      '--spacing-control-lg': '32px',
      '--spacing-control-md': '28px',
      '--spacing-control-sm': '24px',
      '--text-title': '20px',
      '--text-lead': '14px',
    };
    const read = Object.fromEntries(Object.keys(expected).map((name) => [name, token(name)]));

    assert.deepEqual(read, expected);
  });

  it('shares the five statuses and their edge with the widget and the extension (FRU-334)', () => {
    // The widget is the one source: the extension copies it too, and its design-tokens.test.ts compares.
    const widget = readFileSync(new URL('../../../packages/widget/src/theme.ts', import.meta.url), 'utf8');
    const light = widget.slice(0, widget.indexOf('@media'));
    const ofTheWidget = (name: string) => new RegExp(`--fruitback-${name}:\\s*([^;]+);`).exec(light)?.[1];
    const STAGES = { new: 'new', todo: 'todo', progress: 'progress', done: 'done', closed: 'closed' };
    const differences = (read: (name: string) => string | undefined) => [
      ...Object.entries(STAGES)
        .filter(([status, stage]) => read(`--color-status-${status}`) !== ofTheWidget(`stage-${stage}`))
        .map(([status]) => status),
      ...(read('--color-status-edge') === ofTheWidget('color-stage-edge') ? [] : ['edge']),
    ];

    assert.deepEqual(differences(token), []);
    assert.equal(ofTheWidget('stage-done'), '#5560c4', 'the stages of the widget were not read');
    // The control: the red « new » of 2026-10-13, left in the console, is a difference.
    assert.deepEqual(
      differences((name) => (name === '--color-status-new' ? '#dd2c27' : token(name))),
      ['new'],
    );
  });

  it('holds no colour of the palette of before, in any file of the console', () => {
    const files = new Map([...drawn(), ['app.css', css], ['theme.css', own], ['shared/tailwind/theme.css', theme]]);
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) =>
        BEFORE.filter((colour) => source.toLowerCase().includes(colour)).map((colour) => `${name}: ${colour}`),
      );

    assert.deepEqual(found(files), []);
    // The control: the search does find a colour of before where one is written.
    assert.deepEqual(found(new Map([['planted.css', ':root { --muted: #736C67; }']])), ['planted.css: #736c67']);
  });

  it('writes no colour as a value outside app.css: a screen and the kit name a token', () => {
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) => (source.match(VALUE) ?? []).map((value) => `${name}: ${value}`));

    assert.deepEqual(found(drawn()), []);
    // The control: a value in a class, in a style and in a picture are all found.
    assert.deepEqual(
      found(
        new Map([
          ['planted.tsx', '<p className="text-[#dd2c27]" style={{ color: "rgb(1, 2, 3)" }}><path fill="#fff" />'],
        ]),
      ),
      ['planted.tsx: #dd2c27', 'planted.tsx: rgb(', 'planted.tsx: #fff'],
    );
    assert.ok(drawn().size > 12, `only ${drawn().size} files were read`);
  });

  // FRU-508: 12 `text-white` painted the rail, the banners and a check outside the palette.
  it('writes no white or black of Tailwind: what is light on ink is `on-ink`', () => {
    const named = /\b(?:text|bg|border|fill|stroke|outline|ring|decoration)-(?:white|black)\b/g;
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) => (source.match(named) ?? []).map((value) => `${name}: ${value}`));

    assert.deepEqual(found(drawn()), []);
    // The control: a class of Tailwind, under a variant or with an opacity, is found.
    assert.deepEqual(found(new Map([['planted.tsx', '<a className="hover:text-white border-white/10" />']])), [
      'planted.tsx: text-white',
      'planted.tsx: border-white',
    ]);
  });

  it('names no token that app.css does not define', () => {
    // The names that went away with the palette of before. A class of Tailwind on a token that is
    // gone paints nothing, in silence.
    const gone = /\b(?:text|bg|border|fill|stroke|outline|ring|decoration)-faint\b/;
    const users = [...drawn()].filter(([, source]) => gone.test(source)).map(([name]) => name);

    assert.deepEqual(users, []);
    assert.equal(token('--color-faint'), undefined);
    assert.ok(gone.test('className="border border-faint"'));
  });
});
