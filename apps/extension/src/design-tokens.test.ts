import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * The popup and the options page wear the tokens of the design, which are the tokens of the widget
 * (FRU-170, `design/README.md`).
 *
 * A stylesheet of an extension page cannot import `packages/widget/src/theme.ts`, so
 * `entrypoints/popup/style.css` copies the values. This file reads both texts and compares them, in
 * the light scheme and in the dark scheme, then measures each pair of text and background that the
 * two pages paint. Before FRU-170 the extension had a palette of its own: an orange accent, and
 * rectangles where the boards draw pills.
 */

const sheet = readFileSync(new URL('../entrypoints/popup/style.css', import.meta.url), 'utf8');
const optionsSheet = readFileSync(new URL('../entrypoints/options/style.css', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../../packages/widget/src/theme.ts', import.meta.url), 'utf8');

/** The token of the widget that each property of the stylesheet copies. */
const COPIES = {
  surface: 'color-surface',
  text: 'color-text',
  muted: 'color-text-muted',
  line: 'color-border',
  'line-strong': 'color-border-strong',
  accent: 'color-accent',
  'on-accent': 'color-on-accent',
} as const;

type Scheme = Record<string, string>;

/** The colours a block declares: `--name: #hex;`, with or without a prefix. */
function declared(block: string, prefix: string): Scheme {
  const colours: Scheme = {};
  for (const [, name, value] of block.matchAll(new RegExp(`--${prefix}([a-z-]+):\\s*(#[0-9a-f]{3,6})\\s*;`, 'gi'))) {
    if (name !== undefined && value !== undefined) colours[name] = value.toLowerCase();
  }

  return colours;
}

/** The light scheme and the dark scheme of a text: what comes before its first media query, and its dark block. */
function schemes(text: string, prefix: string): { light: Scheme; dark: Scheme } {
  const darkStart = text.indexOf('@media (prefers-color-scheme: dark)');
  assert.notEqual(darkStart, -1, 'no dark block');
  const next = text.indexOf('@media', darkStart + 1);
  const light = declared(text.slice(0, text.indexOf('@media')), prefix);
  const darkEnd = next === -1 ? text.indexOf('\nbody {', darkStart) : next;

  return { light, dark: { ...light, ...declared(text.slice(darkStart, darkEnd), prefix) } };
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

/** Each pair that the popup and the options page paint. Text needs 4.5:1, the edge of a field 3:1. */
const PAIRS = [
  { foreground: 'text', background: 'surface', minimum: 4.5, where: 'the text of both pages' },
  { foreground: 'muted', background: 'surface', minimum: 4.5, where: 'the origin, a state, a secondary button' },
  { foreground: 'on-accent', background: 'accent', minimum: 4.5, where: 'the label of an action' },
  { foreground: 'accent', background: 'surface', minimum: 4.5, where: 'the words of a problem, and its remedy' },
  { foreground: 'line-strong', background: 'surface', minimum: 3, where: 'the edge of a field' },
] as const;

describe('the tokens of the popup and of the options page (FRU-170)', () => {
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
    it(`copies each colour of the widget, in the ${scheme} scheme`, () => {
      for (const [name, token] of Object.entries(COPIES)) {
        const theirColour = theirs[scheme][token];
        assert.ok(theirColour !== undefined, `the widget has no ${token}`);
        assert.equal(long(ours[scheme][name] ?? ''), long(theirColour), `--${name} is not ${token} of the widget`);
      }
    });

    it(`holds each pair of text and background at its ratio, in the ${scheme} scheme`, () => {
      for (const { foreground, background, minimum, where } of PAIRS) {
        const measured = ratio(ours[scheme][foreground] ?? '', ours[scheme][background] ?? '');
        assert.ok(measured >= minimum, `${where}: ${foreground} on ${background} is ${measured.toFixed(2)}:1`);
      }
    });
  }

  it('writes no colour outside the tokens, but the red of the mark', () => {
    const body = sheet.slice(sheet.indexOf('\nbody {'));
    const written = [...`${body}\n${optionsSheet}`.matchAll(/#[0-9a-f]{3,8}\b|%23[0-9a-f]{3,8}\b|rgba?\(/gi)].map(
      ([colour]) => colour.toLowerCase(),
    );

    // The pin beside the name: the accent of the light scheme, in both schemes, as the console draws it.
    assert.deepEqual(written, ['%23dd2c27']);
    assert.equal(ours.light.accent, '#dd2c27');
  });

  it('draws an action as a pill', () => {
    assert.match(sheet, /--radius-pill:\s*999px;/);
    assert.match(sheet, /\nbutton \{[^}]*border-radius:\s*var\(--radius-pill\);/);
  });
});
