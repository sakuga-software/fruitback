import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES } from '@fruitback/shared';
import { THEME_STYLES } from './theme.ts';

/**
 * WCAG 2.2 contrast of the default tokens, in the light scheme and in the dark scheme (FRU-51).
 *
 * Text needs 4.5:1 (1.4.3). The border of a field and a focus ring need 3:1 (1.4.11).
 * No pair fails since FRU-93. Before it, a list of known failures held the accent, four stage colours
 * and the dark warning.
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
  {
    foreground: 'color-text',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the panel, the thread and the list text',
  },
  { foreground: 'color-text', background: 'color-surface-raised', minimum: 4.5, where: 'the composer text' },
  {
    foreground: 'color-text-muted',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the panel labels, the thread byline, and the count and bylines of the list',
  },
  {
    foreground: 'color-text-muted',
    background: 'color-surface-raised',
    minimum: 4.5,
    where: 'the composer status, Cancel, the name disclosure, and the line and the list of where a note goes',
  },
  {
    foreground: 'color-text-subtle',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the thread line that says no reply yet',
  },
  { foreground: 'color-success', background: 'color-surface-raised', minimum: 4.5, where: 'the sent status' },
  {
    foreground: 'color-accent',
    background: 'color-surface-raised',
    minimum: 4.5,
    where: 'the failed status, and the notice of a place that is gone',
  },
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
    where: 'the warning about an approximate position, in the thread and in the list',
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
  // A drawing and a border, not text: 1.4.11 asks for 3:1. The list names the stage in words too.
  ...SEED_STAGES.map((stage) => ({
    foreground: `stage-${stage}`,
    background: 'color-surface',
    minimum: 3,
    where: 'the stage mark of a detached note, and the top border of a thread',
  })),
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

describe('the contrast of the default tokens (FRU-51)', () => {
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

  it('passes for every pair, in both schemes', () => {
    const failures: string[] = [];
    for (const [scheme, tokens] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const { foreground, background, minimum, where } of PAIRS) {
        const measured = ratio(tokens[foreground] ?? '', tokens[background] ?? '');
        if (measured < minimum) {
          failures.push(`${scheme}: ${foreground} on ${background}, ${where} (${measured.toFixed(2)})`);
        }
      }
    }

    assert.deepEqual(failures, []);
  });
});
