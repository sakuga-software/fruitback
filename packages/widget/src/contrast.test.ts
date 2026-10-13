import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES } from '@fruitback/shared';
import { THEME_STYLES, onStageToken } from './theme.ts';

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

/** The stages whose drop is not written in the shared foreground. */
const ON_STAGE: Partial<Record<string, string>> = { ripening: 'color-on-stage-ripening' };

/**
 * The one pair under its ratio, and it is the mock-up's own (FRU-233): the amber of « in progress »
 * is 2.15:1 on white, where a drawing needs 3:1. It is the colour Mathieu's mock-up gives that status.
 *
 * What makes it hold is that the colour never speaks alone: the list writes the stage in words beside
 * its mark, a thread writes the state beside its drop, and a pin carries its number in the ink.
 * `messages.test.ts` and the specs of the list hold those words. The test fails if this pair starts
 * to pass, so the line cannot outlive its reason, and if any other pair fails.
 */
const KNOWN = [
  'light: stage-ripening on color-surface, the stage mark of a detached note, and the drop in the head of a thread (2.15)',
];

const PAIRS: Pair[] = [
  {
    foreground: 'color-on-accent',
    background: 'color-accent',
    minimum: 4.5,
    where: 'the launch and send labels, and the name of the component on the frame of a capture',
  },
  {
    foreground: 'color-on-chip',
    background: 'color-chip',
    minimum: 4.5,
    where: 'the gear, and the button that stops a capture',
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
    where: 'the panel labels, the byline and the link of a thread, and the count and bylines of the list',
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
    foreground: 'color-text-subtle',
    background: 'color-surface-raised',
    minimum: 4.5,
    where: 'the component and the file of a note, in its thread',
  },
  {
    foreground: 'color-accent-strong',
    background: 'color-surface',
    minimum: 4.5,
    where: 'the link of a thread under the pointer',
  },
  // A drawing: 1.4.11 asks for 3:1.
  {
    foreground: 'color-text-muted',
    background: 'color-surface-sunken',
    minimum: 3,
    where: 'the cross of a thread under the pointer',
  },
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
    where: 'the detached-note links',
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
  // What a pin writes on its drop. One stage has a foreground of its own (FRU-233): `onStageToken`.
  ...SEED_STAGES.map((stage) => ({
    foreground: ON_STAGE[stage] ?? 'color-on-stage',
    background: `stage-${stage}`,
    minimum: 4.5,
    where: 'the number of a pin, and its approximate mark',
  })),
  // The mock-up of 2026-10-13 (FRU-233). Held here before a module paints them.
  {
    foreground: 'color-on-accent',
    background: 'color-accent-strong',
    minimum: 4.5,
    where: 'a main button under the pointer, and the launch button while it is pressed',
  },
  {
    foreground: 'color-text',
    background: 'color-surface-sunken',
    minimum: 4.5,
    where: 'the note that is open, in the list',
  },
  {
    foreground: 'color-text-muted',
    background: 'color-surface-sunken',
    minimum: 4.5,
    where: 'the byline of the note that is open, in the list',
  },
  {
    foreground: 'color-text-subtle',
    background: 'color-surface-sunken',
    minimum: 4.5,
    where: 'a tab that is not chosen',
  },
  { foreground: 'color-on-ink', background: 'color-ink', minimum: 4.5, where: 'the banner of a capture' },
  { foreground: 'color-on-ink-muted', background: 'color-ink', minimum: 4.5, where: 'the hint of that banner' },
  // A drawing: 1.4.11 asks for 3:1.
  { foreground: 'color-accent', background: 'color-ink', minimum: 3, where: 'the focus ring of its button' },
  // The composer stands on the surface since FRU-258, as the mock-up paints it: its text, its muted
  // lines and its failed status are the pairs of the surface above. The sent status is this one.
  { foreground: 'color-success', background: 'color-surface', minimum: 4.5, where: 'the sent status' },
  {
    foreground: 'color-unplaced',
    background: 'color-surface',
    minimum: 3,
    where: 'the outline of a note with no place',
  },
  // A drawing, not text: 1.4.11 asks for 3:1. The list names the stage in words too.
  ...SEED_STAGES.map((stage) => ({
    foreground: `stage-${stage}`,
    background: 'color-surface',
    minimum: 3,
    where: 'the stage mark of a detached note, and the drop in the head of a thread',
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

  it('writes « in progress » dark on its amber, where white cannot be read (FRU-233)', () => {
    // The mock-up draws the 2 of that pin in the ink. White on the amber is 2.15:1.
    for (const tokens of [light, dark]) {
      const amber = tokens['stage-ripening'] ?? '';
      assert.ok(ratio('#ffffff', amber) < 3, 'white reads on this stage now: the token of its own is not needed');
      assert.ok(ratio(tokens['color-on-stage-ripening'] ?? '', amber) >= 4.5);
      assert.ok(
        luminance(tokens['color-on-stage-ripening'] ?? '#fff') < 0.05,
        'the foreground of the amber is not dark',
      );
    }
    assert.equal(onStageToken('ripening'), 'var(--fruitback-color-on-stage-ripening, var(--fruitback-color-on-stage))');
  });

  it('holds the five statuses of the mock-up, in both schemes (FRU-233)', () => {
    const drawn = { seeded: '#dd2c27', green: '#2563eb', ripening: '#f59e0b', ripe: '#15803d', composted: '#64748b' };
    for (const tokens of [light, dark]) {
      assert.deepEqual(Object.fromEntries(SEED_STAGES.map((stage) => [stage, tokens[`stage-${stage}`]])), drawn);
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

    assert.deepEqual(failures, KNOWN);
  });
});
