import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES } from '@fruitback/shared';
import { THEME_STYLES } from './theme.ts';

/**
 * WCAG 2.2 contrast of the default tokens, in the light scheme and in the dark scheme (SKG-544).
 *
 * Text needs 4.5:1 (1.4.3). The border of a field and a focus ring need 3:1 (1.4.11).
 * `KNOWN_FAILURES` holds the pairs that fail now. They are the accent and the stage colours, which
 * are the product's identity and wait for a decision. A pair that starts to pass must leave the list,
 * and a new failure must go in it on purpose.
 *
 * The pin itself sits on the host's page, whose colour nothing here knows. No test can promise its
 * contrast.
 */

type Pair = { foreground: string; background: string; minimum: number; where: string };

const PAIRS: Pair[] = [
  { foreground: 'color-on-accent', background: 'color-accent', minimum: 4.5, where: 'the launch and send labels' },
  {
    foreground: 'color-on-chip',
    background: 'color-chip',
    minimum: 4.5,
    where: 'the gear, and the launch label while capturing',
  },
  { foreground: 'color-text', background: 'color-surface', minimum: 4.5, where: 'the panel and thread text' },
  { foreground: 'color-text', background: 'color-surface-raised', minimum: 4.5, where: 'the composer text' },
  {
    foreground: 'color-text-muted',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the panel labels and the thread byline',
  },
  {
    foreground: 'color-text-muted',
    background: 'color-surface-raised',
    minimum: 4.5,
    where: 'the composer status, Cancel and the name disclosure',
  },
  {
    foreground: 'color-text-subtle',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the thread line that says no reply yet',
  },
  { foreground: 'color-success', background: 'color-surface-raised', minimum: 4.5, where: 'the harvested status' },
  { foreground: 'color-accent', background: 'color-surface-raised', minimum: 4.5, where: 'the failed status' },
  {
    foreground: 'color-accent',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the thread and detached-note links',
  },
  {
    foreground: 'color-warning',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the thread warning about an approximate position',
  },
  { foreground: 'color-on-warning', background: 'color-warning', minimum: 4.5, where: 'the detached-notes chip' },
  { foreground: 'color-border-strong', background: 'color-surface', minimum: 3, where: 'the border of a field' },
  {
    foreground: 'color-border-strong',
    background: 'color-surface-raised',
    minimum: 3,
    where: 'the border of a field in the composer',
  },
  { foreground: 'color-accent', background: 'color-surface-raised', minimum: 3, where: 'the focus ring' },
  ...SEED_STAGES.map((stage) => ({
    foreground: 'color-on-stage',
    background: `stage-${stage}`,
    minimum: 4.5,
    where: 'the approximate mark on a pin',
  })),
];

const KNOWN_FAILURES = [
  'light: color-on-accent on color-accent, the launch and send labels',
  'light: color-accent on color-surface-raised, the failed status',
  'light: color-accent on color-surface, the thread and detached-note links',
  'light: color-on-stage on stage-seeded, the approximate mark on a pin',
  'light: color-on-stage on stage-green, the approximate mark on a pin',
  'light: color-on-stage on stage-ripening, the approximate mark on a pin',
  'light: color-on-stage on stage-ripe, the approximate mark on a pin',
  'dark: color-on-accent on color-accent, the launch and send labels',
  'dark: color-accent on color-surface-raised, the failed status',
  'dark: color-accent on color-surface, the thread and detached-note links',
  'dark: color-warning on color-surface, the thread warning about an approximate position',
  'dark: color-on-stage on stage-seeded, the approximate mark on a pin',
  'dark: color-on-stage on stage-green, the approximate mark on a pin',
  'dark: color-on-stage on stage-ripening, the approximate mark on a pin',
  'dark: color-on-stage on stage-ripe, the approximate mark on a pin',
];

function declared(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--fruitback-([a-z-]+):\s*(#[0-9a-f]{3,6})\s*;/gi)) {
    if (name !== undefined && value !== undefined) tokens[name] = value;
  }

  return tokens;
}

function luminance(hex: string): number {
  const digits = hex.slice(1).length === 3 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1);
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

const light = declared(THEME_STYLES.slice(0, THEME_STYLES.indexOf('@media')));
const darkStart = THEME_STYLES.indexOf('@media (prefers-color-scheme: dark)');
const dark = { ...light, ...declared(THEME_STYLES.slice(darkStart, THEME_STYLES.indexOf('@media', darkStart + 1))) };

describe('the contrast of the default tokens (SKG-544)', () => {
  it('measures what WCAG measures', () => {
    assert.equal(ratio('#000', '#fff'), 21);
    assert.equal(ratio('#fff', '#fff'), 1);
    assert.equal(ratio('#767676', '#fff').toFixed(2), '4.54');
  });

  it('finds a value for every token it compares, in both schemes', () => {
    assert.ok(Object.keys(dark).length > Object.keys(light).length - 1, 'the dark block was not read');
    assert.notEqual(dark['color-surface'], light['color-surface'], 'the dark block was not read');
    for (const { foreground, background } of PAIRS) {
      assert.ok(light[foreground] !== undefined, `${foreground} has no colour`);
      assert.ok(light[background] !== undefined, `${background} has no colour`);
    }
  });

  it('fails only where a failure is known', () => {
    const failures: string[] = [];
    for (const [scheme, tokens] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const { foreground, background, minimum, where } of PAIRS) {
        const measured = ratio(tokens[foreground] ?? '', tokens[background] ?? '');
        if (measured < minimum) failures.push(`${scheme}: ${foreground} on ${background}, ${where}`);
      }
    }

    assert.deepEqual(failures, KNOWN_FAILURES);
  });
});
