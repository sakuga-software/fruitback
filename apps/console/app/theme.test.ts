import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * The slate theme of the console (FRU-683).
 *
 * `theme.css` is the console's alone: the shared theme stays what the extension, the widget and the
 * docs read. A screen names a radius and a height, and never writes one: a setting of the appearance
 * (FRU-694) then changes a token and every screen follows. The console has no DOM under
 * `node --test`, so the guards read the sources; `e2e/console-kit.spec.ts` reads what a browser
 * computes.
 */
const APP = new URL('./', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);
const theme = readFileSync(new URL('theme.css', APP), 'utf8');
const app = readFileSync(new URL('app.css', APP), 'utf8');
const shared = readFileSync(new URL('packages/shared/tailwind/theme.css', ROOT), 'utf8');

/**
 * Every source of the console that draws a control: the screens, their parts, the kit. Not
 * `preview-scene.tsx`: it is a picture of an example shop with the widget on it, drawn with the
 * shop's corners and the widget's, which a setting of the console does not change.
 */
function drawn(): Map<string, string> {
  const names = [
    ...readdirSync(new URL('routes/', APP)).map((name) => `routes/${name}`),
    ...readdirSync(new URL('parts/', APP)).map((name) => `parts/${name}`),
    ...readdirSync(APP).filter((name) => name.endsWith('.tsx') && name !== 'preview-scene.tsx'),
  ];

  return new Map(names.map((name) => [name, readFileSync(new URL(name, APP), 'utf8')]));
}

/**
 * The value of a custom property, as the console reads it: `theme.css`, then `app.css`, then the
 * shared theme. A var() is read in turn.
 */
function token(name: string): string {
  const declared = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm');
  const value = declared.exec(theme)?.[1] ?? declared.exec(app)?.[1] ?? declared.exec(shared)?.[1];
  assert.ok(value !== undefined, `${name} is not declared`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);

  return reference?.[1] === undefined ? value : token(reference[1]);
}

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

/** A radius written as a value, or a step of Tailwind's scale, in the class of an element. */
const WRITTEN_RADIUS =
  /(?<![\w-])rounded(?:-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee))?(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|button|field|box|frame|\[(?!inherit\])[^\]]+\]|\([^)]+\)))?(?![\w-])/g;

/** A height of a control of before the redesign: 44, 40, 38, 36 and 32 px. */
const HEIGHT_OF_BEFORE = /(?<![\w-])(?:min-|max-)?(?:h|size|w|min-w)-control(?:-(?:panel|row|chip|small))?(?![\w-])/g;

describe('the slate theme of the console (FRU-683)', () => {
  it('has the values of the ticket', () => {
    const expected: Record<string, string> = {
      '--color-page': '#ffffff',
      '--color-sidebar': '#f1f4f8',
      '--color-line': '#e3e8ef',
      '--color-hover': '#e8edf3',
      '--color-selected': '#e2e8f0',
      '--color-ink': '#0f172a',
      '--color-ink-soft': '#334155',
      '--muted': '#5b6779',
      '--accent': '#dd2c27',
      '--radius-control': '6px',
      '--radius-card': '8px',
      '--radius-modal': '10px',
      '--spacing-control-sm': '24px',
      '--spacing-control-md': '28px',
      '--spacing-control-lg': '32px',
      '--text-body': '13px',
    };
    const read = Object.fromEntries(Object.keys(expected).map((name) => [name, token(name)]));

    assert.deepEqual(read, expected);
    assert.match(token('--font-sans'), /^'Inter Variable', 'Inter',/);
  });

  it('is read by the console alone, after the shared theme', () => {
    const sharedAt = app.indexOf("@import '@fruitback/shared/tailwind/theme.css';");
    const ownAt = app.indexOf("@import './theme.css';");
    assert.ok(sharedAt > 0 && ownAt > sharedAt, 'app.css does not import theme.css after the shared theme');

    // Every token is written, used or not: a setting of the appearance finds each one on :root.
    assert.match(theme.replace(/\/\*[\s\S]*?\*\//g, ''), /^\s*@theme static \{/);

    // The extension, the site and the docs build from the shared theme and their own: none of
    // them reads the console's. The control: a planted import is found.
    const readsConsole = (source: string) => /console\/app\/theme\.css/.test(source);
    const others = [
      'apps/extension/src/theme.css',
      'apps/extension/entrypoints/popup/style.css',
      'apps/site/src/theme.css',
      'packages/shared/tailwind/theme.css',
    ].filter((name) => readsConsole(readFileSync(new URL(name, ROOT), 'utf8')));
    assert.deepEqual(others, []);
    assert.ok(readsConsole("@import '../../console/app/theme.css';"));
  });

  it('keeps every text 4.5:1 on the page, the sidebar, the hover and the selection (WCAG AA)', () => {
    const grounds = ['--color-page', '--color-sidebar', '--color-subtle', '--color-hover', '--color-selected'];
    // A red word is accent-strong: the accent is 3.82:1 on the selection, and fills a button.
    const texts = ['--color-ink', '--color-ink-soft', '--muted', '--color-accent-strong', '--color-done'];
    const ratios = texts.flatMap((text) =>
      grounds.map((ground) => [`${text} on ${ground}`, contrast(token(text), token(ground))] as const),
    );
    const under = ratios.filter(([, ratio]) => ratio < 4.5).map(([pair, ratio]) => `${pair}: ${ratio.toFixed(2)}`);

    assert.deepEqual(under, []);
    // The measures the docs give (design/README.md): the secondary text, the weakest of the texts.
    const muted = Object.fromEntries(
      grounds.map((ground) => [ground, contrast(token('--muted'), token(ground)).toFixed(2)]),
    );
    assert.deepEqual(muted, {
      '--color-page': '5.74',
      '--color-sidebar': '5.20',
      '--color-subtle': '5.44',
      '--color-hover': '4.87',
      '--color-selected': '4.65',
    });
    // White on the accent and on an avatar.
    assert.ok(contrast('#ffffff', token('--accent')) >= 4.5);
    assert.ok(contrast('#ffffff', token('--color-avatar')) >= 4.5);
    // The control: the faint grey of the mockup (#8592a3) is under 4.5:1 on white.
    assert.ok(contrast('#8592a3', '#ffffff') < 4.5);
  });

  it('draws the border of a control at 3:1 on every ground it sits on (WCAG 1.4.11)', () => {
    for (const ground of ['--color-page', '--color-sidebar', '--color-subtle']) {
      const ratio = contrast(token('--color-control'), token(ground));
      assert.ok(ratio >= 3, `--color-control on ${ground}: ${ratio.toFixed(2)}`);
    }
  });

  it('writes no radius in a screen or the kit: each names a token of theme.css', () => {
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) =>
        (source.match(WRITTEN_RADIUS) ?? []).map((value) => `${name}: ${value}`),
      );

    assert.deepEqual(found(drawn()), []);
    // The control: a value, a step of the scale, a variable, a side and a name of before are found;
    // the tokens, `rounded-full`, `rounded-none` and `rounded-[inherit]` are not.
    assert.deepEqual(
      found(
        new Map([
          [
            'planted.tsx',
            '"rounded-[12px] rounded-md rounded rounded-(--field-radius) first:rounded-l-[999px] rounded-frame rounded-control rounded-card rounded-full rounded-none rounded-[inherit] rounded-l-full"',
          ],
        ]),
      ),
      [
        'planted.tsx: rounded-[12px]',
        'planted.tsx: rounded-md',
        'planted.tsx: rounded',
        'planted.tsx: rounded-(--field-radius)',
        'planted.tsx: rounded-l-[999px]',
        'planted.tsx: rounded-frame',
      ],
    );
    assert.ok(drawn().size > 12, `only ${drawn().size} files were read`);
  });

  it('gives a modal and an alert of HeroUI their radius, where HeroUI reads a control', () => {
    const kit = readFileSync(new URL('ui.tsx', APP), 'utf8');

    assert.match(kit, /<Modal\.Dialog className=\{`kit-dialog rounded-modal /);
    assert.match(kit, /<Alert\s[^>]*className="[^"]*\brounded-card\b/);
    // app.css writes no radius: a component carries its classes (FRU-678).
    assert.doesNotMatch(app.replace(/\/\*[\s\S]*?\*\//g, ''), /border-radius/);
  });

  it('gives a control one of three heights: 24, 28 or 32 px', () => {
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) =>
        (source.match(HEIGHT_OF_BEFORE) ?? []).map((value) => `${name}: ${value}`),
      );

    assert.deepEqual(found(drawn()), []);
    // The control: the heights of before are found, the three of now are not.
    assert.deepEqual(
      found(new Map([['planted.tsx', '"h-control min-h-control-panel size-control-chip h-control-md"']])),
      ['planted.tsx: h-control', 'planted.tsx: min-h-control-panel', 'planted.tsx: size-control-chip'],
    );
  });

  it('holds no stone or beige: the warm greys stay on fruitback.com', () => {
    // Tailwind's stone, and the warm tones of the site and of the first boards (design/README.md).
    const WARM = [
      '#fafaf9',
      '#f5f5f4',
      '#e7e5e4',
      '#d6d3d1',
      '#a8a29e',
      '#78716c',
      '#57534e',
      '#44403c',
      '#292524',
      '#1c1917',
      '#fffdf9',
      '#faf7f2',
      '#f3f1ee',
      '#faf9f5',
      '#f6f4f1',
      '#736c67',
      '#8f8883',
    ];
    const files = new Map([...drawn(), ['app.css', app], ['theme.css', theme]]);
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, source]) =>
        WARM.filter((colour) => source.toLowerCase().includes(colour)).map((colour) => `${name}: ${colour}`),
      );

    assert.deepEqual(found(files), []);
    assert.deepEqual(found(new Map([['planted.css', ':root { --page: #FAF9F5; }']])), ['planted.css: #faf9f5']);
  });
});
