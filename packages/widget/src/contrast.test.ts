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

/** The stages whose drop is not written in the shared foreground: the three light fills (FRU-334). */
const ON_STAGE: Partial<Record<string, string>> = {
  seeded: 'color-on-stage-seeded',
  green: 'color-on-stage-green',
  ripening: 'color-on-stage-ripening',
};

/**
 * The pairs under their ratio. None since FRU-292. The light statuses of FRU-334 are under 3:1 on
 * white, but a drop is drawn by its edge, and the edge is what is measured below. The test fails if
 * any pair fails, so a new failure has to be written here with its reason.
 */
const KNOWN: string[] = [];

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
  // The grey of a note whose element is gone, on the chip of the capsule (FRU-303, FRU-334).
  { foreground: 'color-on-stage', background: 'color-unplaced', minimum: 4.5, where: 'the detached-notes chip' },
  // The list and the gear are drawn on the capsule, and on its sunken fill under the pointer.
  {
    foreground: 'color-text-subtle',
    background: 'color-surface',
    minimum: 3,
    where: 'the list and the gear of the dock',
  },
  // A drawing: the key Esc on the way out of a capture.
  { foreground: 'color-on-ink-muted', background: 'color-chip', minimum: 3, where: 'the border of the key Esc' },
  { foreground: 'color-border-strong', background: 'color-surface', minimum: 3, where: 'the border of a field' },
  {
    foreground: 'color-border-strong',
    background: 'color-surface-raised',
    minimum: 3,
    where: 'the border of a field in the composer',
  },
  { foreground: 'color-accent', background: 'color-surface-raised', minimum: 3, where: 'the focus ring' },
  // What a pin writes on its drop. Three stages have a foreground of their own (FRU-334): `onStageToken`.
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
  // The block that quotes the selector and the source of a note (FRU-292, held before FRU-304 paints it).
  { foreground: 'color-text', background: 'color-surface-warm', minimum: 4.5, where: 'the selector of a note' },
  {
    foreground: 'color-text-subtle',
    background: 'color-surface-warm',
    minimum: 4.5,
    where: 'the component and the file of a note',
  },
  { foreground: 'color-text-muted', background: 'color-surface-warm', minimum: 4.5, where: 'a hint in that block' },
  // The composer stands on the surface since FRU-258, as the mock-up paints it: its text, its muted
  // lines and its failed status are the pairs of the surface above. The sent status is this one.
  { foreground: 'color-success', background: 'color-surface', minimum: 4.5, where: 'the sent status' },
  {
    foreground: 'color-unplaced',
    background: 'color-surface',
    minimum: 3,
    where: 'the outline of a note with no place',
  },
  // A drawing, not text: 1.4.11 asks for 3:1. The list names the stage in words too. The fill of a
  // light stage is under 3:1 on white, and blueberry and cherry are under it on the dark surface:
  // every drop and every mark is drawn with an edge (FRU-334), and the edge is what holds.
  ...(['color-surface', 'color-surface-raised', 'color-surface-sunken'] as const).map((background) => ({
    foreground: 'color-stage-edge',
    background,
    minimum: 3,
    where: 'the edge of a pin, of a drop in the list and of the mark of a status',
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

  it('writes new, to do and in progress black, and done and closed white (FRU-334)', () => {
    // The « Texte » column of the ticket: black on the three light fills, white on the two dark ones.
    const written = { seeded: '#18181b', green: '#18181b', ripening: '#18181b', ripe: '#fff', composted: '#fff' };
    for (const tokens of [light, dark]) {
      const read = Object.fromEntries(SEED_STAGES.map((stage) => [stage, tokens[ON_STAGE[stage] ?? 'color-on-stage']]));
      assert.deepEqual(read, written);
    }
    for (const stage of ['seeded', 'green', 'ripening'] as const) {
      assert.equal(onStageToken(stage), `var(--fruitback-color-on-stage-${stage}, var(--fruitback-color-on-stage))`);
    }
    // The control: white on the grey of « to do » is what the black replaces, and it cannot be read.
    assert.ok(ratio('#ffffff', light['stage-green'] ?? '') < 1.5);
  });

  it('holds the five statuses chosen by Mathieu, in both schemes (FRU-334)', () => {
    const chosen = { seeded: '#bec2c8', green: '#d9dbdf', ripening: '#f3bb3d', ripe: '#5560c4', composted: '#a52a3a' };
    for (const tokens of [light, dark]) {
      assert.deepEqual(Object.fromEntries(SEED_STAGES.map((stage) => [stage, tokens[`stage-${stage}`]])), chosen);
    }
  });

  it('draws the edge of a drop in one grey in both schemes, outside the ring of the pin (FRU-334)', () => {
    // A pin lies on the page of the host: its edge does not follow the scheme of the reader.
    assert.equal(light['color-stage-edge'], dark['color-stage-edge']);
    // Without the edge, the light stages are the failures it fixes: the control of the pairs above.
    const unedged = (['seeded', 'green', 'ripening'] as const).filter(
      (stage) => ratio(light[`stage-${stage}`] ?? '', light['color-surface'] ?? '') < 3,
    );
    assert.deepEqual(unedged, ['seeded', 'green', 'ripening']);
  });

  it('keeps the red of the widget as its accent, in the light scheme (FRU-292)', () => {
    // The extension has an accent of its own (#c2410c). The widget lies on the page of a host and keeps its red.
    assert.equal(light['color-accent'], '#dd2c27');
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
