import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * The popup and the options page wear the tokens of the mock-up of 2026-10-20 (FRU-292).
 *
 * **Shared tokens, one accent per surface.** The greys, the statuses, the shadows and the radii are
 * those of the widget, and a stylesheet of an extension page cannot import
 * `packages/widget/src/theme.ts`, so `entrypoints/popup/style.css` copies them. This file reads both
 * texts and compares each shared token, in the light scheme and in the dark scheme. The accent is
 * not shared: the extension paints its pages in #c2410c, the widget keeps its red #dd2c27 on the
 * page of a host. Each accent is checked against its own value, and the two must differ, so that
 * going back to one accent is a decision written here and not an accident. Then the test measures
 * each pair of text and background that the pages paint.
 */

const sheet = readFileSync(new URL('../entrypoints/popup/style.css', import.meta.url), 'utf8');
const optionsSheet = readFileSync(new URL('../entrypoints/options/style.css', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../../packages/widget/src/theme.ts', import.meta.url), 'utf8');

/** The token of the widget that each shared property of the stylesheet copies. */
const COPIES = {
  surface: 'color-surface',
  'surface-raised': 'color-surface-raised',
  'surface-sunken': 'color-surface-sunken',
  'surface-warm': 'color-surface-warm',
  text: 'color-text',
  muted: 'color-text-muted',
  subtle: 'color-text-subtle',
  line: 'color-border',
  'line-strong': 'color-border-strong',
  chip: 'color-chip',
  'on-chip': 'color-on-chip',
  ink: 'color-ink',
  'on-ink-muted': 'color-on-ink-muted',
  success: 'color-success',
  'stage-seeded': 'stage-seeded',
  'stage-green': 'stage-green',
  'stage-ripening': 'stage-ripening',
  'stage-ripe': 'stage-ripe',
  'stage-composted': 'stage-composted',
} as const;

/** The shadows and the radii that both surfaces draw, by the same value. */
const SHAPES = {
  'shadow-xs': 'shadow-xs',
  'radius-control': 'radius-sm',
  'radius-field': 'radius-field',
  'radius-action': 'radius-md',
  'radius-panel': 'radius-lg',
  'radius-pill': 'radius-pill',
} as const;

/** The accent of each surface, in the light scheme (FRU-292). */
const ACCENTS = { extension: '#c2410c', widget: '#dd2c27' } as const;

type Scheme = Record<string, string>;

/** The colours a block declares: `--name: #hex;`, with or without a prefix. */
function declared(block: string, prefix: string): Scheme {
  const colours: Scheme = {};
  for (const [, name, value] of block.matchAll(new RegExp(`--${prefix}([a-z-]+):\\s*(#[0-9a-f]{3,6})\\s*;`, 'gi'))) {
    if (name !== undefined && value !== undefined) colours[name] = value.toLowerCase();
  }

  return colours;
}

/** Every value a block declares, colour or not, with its spaces made single. */
function values(block: string, prefix: string): Scheme {
  const read: Scheme = {};
  for (const [, name, value] of block.matchAll(new RegExp(`--${prefix}([a-z-]+):\\s*([^;]+);`, 'gi'))) {
    if (name !== undefined && value !== undefined) read[name] = value.trim().replace(/\s+/g, ' ');
  }

  return read;
}

/** The light scheme and the dark scheme of a text: what comes before its first media query, and its dark block. */
function schemes(
  text: string,
  prefix: string,
  read: (block: string, prefix: string) => Scheme = declared,
): { light: Scheme; dark: Scheme } {
  const darkStart = text.indexOf('@media (prefers-color-scheme: dark)');
  assert.notEqual(darkStart, -1, 'no dark block');
  const next = text.indexOf('@media', darkStart + 1);
  const light = read(text.slice(0, text.indexOf('@media')), prefix);
  const blockEnd = text.indexOf('\n}\n', text.indexOf('\n  }\n', darkStart));
  const darkEnd = next === -1 ? blockEnd : Math.min(next, blockEnd);

  return { light, dark: { ...light, ...read(text.slice(darkStart, darkEnd), prefix) } };
}

function long(hex: string): string {
  return hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex;
}

function luminance(hex: string): number {
  const digits = long(hex).slice(1);
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(digits.slice(start, start + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function ratio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);

  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

const ours = schemes(sheet, '');
const theirs = schemes(widget, 'fruitback-');
const ourShapes = schemes(sheet, '', values);
const theirShapes = schemes(widget, 'fruitback-', values);

/** Each pair that the popup and the options page paint. Text needs 4.5:1, the edge of a field 3:1. */
const PAIRS = [
  { foreground: 'text', background: 'surface', minimum: 4.5, where: 'the text of both pages' },
  { foreground: 'muted', background: 'surface', minimum: 4.5, where: 'the origin, a state, a chevron' },
  { foreground: 'subtle', background: 'surface', minimum: 4.5, where: 'the secondary text, the terms of a list' },
  { foreground: 'on-accent', background: 'accent', minimum: 4.5, where: 'the label of an action' },
  { foreground: 'on-accent', background: 'accent-strong', minimum: 4.5, where: 'an action under the pointer' },
  { foreground: 'accent', background: 'surface', minimum: 4.5, where: 'a link, and « Change »' },
  { foreground: 'accent-strong', background: 'surface', minimum: 4.5, where: 'a link under the pointer' },
  { foreground: 'accent', background: 'surface', minimum: 3, where: 'the focus ring' },
  { foreground: 'line-strong', background: 'surface', minimum: 3, where: 'the edge of a field' },
  // The pairs the screens of the mock-up paint, held here before a screen uses them (FRU-293 and after).
  { foreground: 'text', background: 'surface-raised', minimum: 4.5, where: 'text on the page of the extension' },
  { foreground: 'muted', background: 'surface-raised', minimum: 4.5, where: 'a hint on the page of the extension' },
  { foreground: 'subtle', background: 'surface-raised', minimum: 4.5, where: 'an intro on the page of the extension' },
  { foreground: 'accent', background: 'surface-raised', minimum: 4.5, where: 'a link on the page of the extension' },
  { foreground: 'line-strong', background: 'surface-raised', minimum: 3, where: 'a field of the page' },
  { foreground: 'text', background: 'surface-sunken', minimum: 4.5, where: 'a thing that is chosen' },
  { foreground: 'muted', background: 'surface-sunken', minimum: 4.5, where: 'a hint on a thing that is chosen' },
  { foreground: 'subtle', background: 'surface-sunken', minimum: 4.5, where: 'a tab that is not chosen' },
  { foreground: 'text', background: 'surface-warm', minimum: 4.5, where: 'a mono block' },
  { foreground: 'subtle', background: 'surface-warm', minimum: 4.5, where: 'the row that is open' },
  { foreground: 'on-chip', background: 'chip', minimum: 4.5, where: 'the initial of the account' },
  { foreground: 'on-ink-muted', background: 'ink', minimum: 4.5, where: 'the hint of the capture capsule' },
  { foreground: 'success', background: 'surface', minimum: 4.5, where: 'a word that says it worked' },
  { foreground: 'success-line', background: 'surface', minimum: 3, where: 'the edge of « Looks fixed »' },
  { foreground: 'alert-text', background: 'alert-surface', minimum: 4.5, where: 'the title of a problem' },
  { foreground: 'text', background: 'alert-surface', minimum: 4.5, where: 'the words of a problem' },
  { foreground: 'subtle', background: 'ready-surface', minimum: 4.5, where: 'the words of « Ready to check »' },
  { foreground: 'text', background: 'selection', minimum: 4.5, where: 'a selected text' },
  { foreground: 'on-tile', background: 'tile-on', minimum: 4.5, where: 'the initial of a site that is on' },
  // A drawing, not text: 1.4.11 asks for 3:1. A status is also named in words.
  ...(['seeded', 'green', 'ripening', 'ripe', 'composted'] as const).map((stage) => ({
    foreground: `stage-${stage}`,
    background: 'surface',
    minimum: 3,
    where: `the drop of a status (${stage})`,
  })),
] as const;

describe('the tokens of the popup and of the options page (FRU-170, FRU-292)', () => {
  it('reads both schemes of both texts', () => {
    for (const read of [ours, theirs]) {
      assert.ok(Object.keys(read.light).length >= Object.keys(COPIES).length, 'the light scheme was not read');
      assert.notEqual(
        read.dark.surface ?? read.dark['color-surface'],
        read.light.surface ?? read.light['color-surface'],
      );
    }
    assert.equal(ratio('#767676', '#fff').toFixed(2), '4.54');
  });

  for (const scheme of ['light', 'dark'] as const) {
    it(`copies each shared colour of the widget, in the ${scheme} scheme`, () => {
      assert.deepEqual(sharedDifferences(ours[scheme], theirs[scheme]), []);
    });

    it(`copies each shared shadow and radius of the widget, in the ${scheme} scheme`, () => {
      for (const [name, token] of Object.entries(SHAPES)) {
        const theirValue = theirShapes[scheme][token];
        assert.ok(theirValue !== undefined, `the widget has no ${token}`);
        assert.equal(ourShapes[scheme][name], theirValue, `--${name} is not ${token} of the widget`);
      }
    });

    it(`holds each pair of text and background at its ratio, in the ${scheme} scheme`, () => {
      for (const { foreground, background, minimum, where } of PAIRS) {
        const measured = ratio(ours[scheme][foreground] ?? '', ours[scheme][background] ?? '');
        assert.ok(measured >= minimum, `${where}: ${foreground} on ${background} is ${measured.toFixed(2)}:1`);
      }
    });
  }

  it('fails when one shared grey differs between the two surfaces', () => {
    // A planted violation: the widget's border, one step off on the extension side.
    const planted = { ...ours.light, line: '#e4e4e7' };
    assert.deepEqual(sharedDifferences(planted, theirs.light), [
      '--line is #e4e4e7, color-border of the widget is #e7e5e4',
    ]);
  });

  it('gives each surface its own accent (FRU-292)', () => {
    assert.equal(ours.light.accent, ACCENTS.extension);
    assert.equal(theirs.light['color-accent'], ACCENTS.widget);
    assert.notEqual(ours.light.accent, theirs.light['color-accent']);
    // The accent is not in the shared list: a shared accent would make the test above pass by accident.
    const shared: readonly string[] = Object.values(COPIES);
    assert.ok(!shared.some((token) => token.startsWith('color-accent') || token === 'color-on-accent'));
  });

  it('writes no colour outside the tokens, but the drop of the mark', () => {
    const body = sheet.slice(sheet.indexOf('\nbody {'));
    const written = [...`${body}\n${optionsSheet}`.matchAll(/#[0-9a-f]{3,8}\b|%23[0-9a-f]{3,8}\b|rgba?\(/gi)].map(
      ([colour]) => colour.toLowerCase(),
    );

    // The drop beside the name: the accent of the light scheme, in both schemes.
    assert.deepEqual(written, [`%23${ACCENTS.extension.slice(1)}`]);
  });

  it('draws an action as a pill', () => {
    assert.match(sheet, /--radius-pill:\s*999px;/);
    assert.match(sheet, /\nbutton \{[^}]*border-radius:\s*var\(--radius-pill\);/);
  });
});

/** Each shared colour of the extension that is not the widget's, as a sentence. */
function sharedDifferences(extension: Scheme, theWidget: Scheme): string[] {
  const differences: string[] = [];
  for (const [name, token] of Object.entries(COPIES)) {
    const theirColour = theWidget[token];
    if (theirColour === undefined) {
      differences.push(`the widget has no ${token}`);
    } else if (long(extension[name] ?? '') !== long(theirColour)) {
      differences.push(`--${name} is ${extension[name] ?? 'missing'}, ${token} of the widget is ${theirColour}`);
    }
  }

  return differences;
}
