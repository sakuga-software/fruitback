import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * The popup, the side panel and the options page wear the tokens of the widget (FRU-292, FRU-334).
 *
 * **Shared tokens, one accent per surface.** The greys, the statuses, the shadows and the radii are
 * those of the widget, the zinc of the console since FRU-334, and a stylesheet of an extension page
 * cannot import `packages/widget/src/theme.ts`, so `entrypoints/popup/style.css` copies them. The
 * widget is the one source of the statuses: the console copies them too, and
 * `apps/console/app/tokens.test.ts` compares its copy. This file reads both
 * texts and compares each shared token, in the light scheme and in the dark scheme. The accent is
 * shared since FRU-372: the red #dd2c27 of the console and of the widget, after the orange #c2410c
 * of FRU-292. Then the test measures each pair of text and background that the pages paint.
 */

const sheet = readFileSync(new URL('../entrypoints/popup/style.css', import.meta.url), 'utf8');
const optionsSheet = readFileSync(new URL('../entrypoints/options/style.css', import.meta.url), 'utf8');
const kitSheet = readFileSync(new URL('./kit.css', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../../packages/widget/src/theme.ts', import.meta.url), 'utf8');
const panelSheet = readFileSync(new URL('../entrypoints/sidepanel/style.css', import.meta.url), 'utf8');
const welcomeSheet = readFileSync(new URL('../entrypoints/welcome/style.css', import.meta.url), 'utf8');
const WIDGET_SOURCES = new URL('../../../packages/widget/src/', import.meta.url);

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
  unplaced: 'color-unplaced',
  'on-stage': 'color-on-stage',
  'on-stage-seeded': 'color-on-stage-seeded',
  'on-stage-green': 'color-on-stage-green',
  'on-stage-ripening': 'color-on-stage-ripening',
  'stage-edge': 'color-stage-edge',
  'stage-seeded': 'stage-seeded',
  'stage-green': 'stage-green',
  'stage-ripening': 'stage-ripening',
  'stage-ripe': 'stage-ripe',
  'stage-composted': 'stage-composted',
  // One accent everywhere since FRU-372: the red of the console and of the widget, in both schemes.
  accent: 'color-accent',
  'accent-strong': 'color-accent-strong',
  'on-accent': 'color-on-accent',
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

/** The one accent of the extension, the widget and the console, in the light scheme (FRU-372). */
const ACCENT = '#dd2c27';
const consoleSheet = readFileSync(new URL('../../../apps/console/app/app.css', import.meta.url), 'utf8');

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
  // The page of the extension (FRU-301).
  { foreground: 'alert-text', background: 'alert-surface', minimum: 4.5, where: 'no access' },
  // The chosen row of the table is on the sunken surface since FRU-334, under its bar of the accent.
  { foreground: 'text', background: 'surface-sunken', minimum: 4.5, where: 'the chosen row of the table' },
  { foreground: 'accent', background: 'surface-sunken', minimum: 3, where: 'the bar of the chosen row' },
  { foreground: 'alert-body', background: 'surface-sunken', minimum: 4.5, where: 'the words of the state of a rule' },
  { foreground: 'surface', background: 'text', minimum: 4.5, where: 'the label of « Save »' },
  // The kit (FRU-293).
  { foreground: 'on-avatar', background: 'avatar-surface', minimum: 4.5, where: 'the initial of the account' },
  { foreground: 'alert-body', background: 'alert-surface', minimum: 4.5, where: 'the words of a problem' },
  { foreground: 'line-strong', background: 'surface', minimum: 3, where: 'the track of a switch that is off' },
  { foreground: 'line-strong', background: 'surface-raised', minimum: 3, where: 'a switch of the page that is off' },
  // The number of a drop: black on the three light fills, white on done and closed (FRU-334).
  ...(['seeded', 'green', 'ripening'] as const).map((stage) => ({
    foreground: `on-stage-${stage}`,
    background: `stage-${stage}`,
    minimum: 4.5,
    where: `the number of a drop (${stage})`,
  })),
  ...(['ripe', 'composted'] as const).map((stage) => ({
    foreground: 'on-stage',
    background: `stage-${stage}`,
    minimum: 4.5,
    where: `the number of a drop (${stage})`,
  })),
  // A drawing, not text: 1.4.11 asks for 3:1. A status is also named in words. The light fills are
  // under 3:1 on white, so every drop is drawn with an edge, and the edge is what holds (FRU-334).
  ...(['surface', 'surface-raised', 'surface-sunken'] as const).map((background) => ({
    foreground: 'stage-edge',
    background,
    minimum: 3,
    where: 'the edge of the drop of a status',
  })),
  // A note with no place: its dashed card and its drop.
  { foreground: 'unplaced', background: 'surface', minimum: 3, where: 'the edge of a note with no place' },
  { foreground: 'unplaced', background: 'surface-warm', minimum: 3, where: 'the dashed card of a note with no place' },
] as const;

describe('the tokens of the popup and of the options page (FRU-170, FRU-292, FRU-334)', () => {
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
    // A planted violation: the stone border of FRU-292, left behind on the extension side.
    const planted = { ...ours.light, line: '#e7e5e4' };
    assert.deepEqual(sharedDifferences(planted, theirs.light), [
      '--line is #e7e5e4, color-border of the widget is #e4e4e7',
    ]);
  });

  it('paints the red of the console as its accent, as the widget does (FRU-372)', () => {
    assert.equal(ours.light.accent, ACCENT);
    assert.equal(theirs.light['color-accent'], ACCENT);
    assert.match(consoleSheet, new RegExp(`--accent:\\s*${ACCENT};`));
    // The control: the orange of before, left on the extension side, is a difference.
    assert.deepEqual(sharedDifferences({ ...ours.light, accent: '#c2410c' }, theirs.light), [
      '--accent is #c2410c, color-accent of the widget is #dd2c27',
    ]);
  });

  it('writes no colour outside the tokens, but the drop of the mark', () => {
    const body = sheet.slice(sheet.indexOf('\nbody {'));
    const written = [
      ...`${body}\n${optionsSheet}\n${kitSheet}`.matchAll(/#[0-9a-f]{3,8}\b|%23[0-9a-f]{3,8}\b|rgba?\(/gi),
    ].map(([colour]) => colour.toLowerCase());

    // The drop beside the name: the accent of the light scheme, in both schemes.
    assert.deepEqual(written, [`%23${ACCENT.slice(1)}`]);
  });

  it('holds no stone grey and no brown of FRU-292, in the extension or in the widget (FRU-334)', () => {
    // The values that FRU-334 replaced: the stone scale, the creams, the brown of closed, the brown
    // fills of the dark scheme, and the stone tint of the shadows. A comment may name them.
    const BEFORE = [
      ...['#1c1917', '#292524', '#312c29', '#221e1b', '#44403c', '#57534e', '#756e69', '#78716c', '#8f8883'],
      ...['#a8a29e', '#d6d3d1', '#e7e5e4', '#f0efed', '#f5f5f4', '#fafaf9', '#fffdf9', '#fffaf5', '#fde4c8'],
      ...['#8d6e63', '#6a7950', '#56802e', '#ac5f00', '#3f6421', '#4e7d2a', '#9bc46a', '#431407', '#2a1d14'],
      '28, 25, 23',
    ];
    const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    const found = (sources: Map<string, string>) =>
      [...sources].flatMap(([name, text]) =>
        BEFORE.filter((value) => uncommented(text).toLowerCase().includes(value)).map((value) => `${name}: ${value}`),
      );
    const widgetModules = readdirSync(WIDGET_SOURCES)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => [`widget/${name}`, readFileSync(new URL(name, WIDGET_SOURCES), 'utf8')] as const);
    const sources = new Map<string, string>([
      ['popup/style.css', sheet],
      ['options/style.css', optionsSheet],
      ['sidepanel/style.css', panelSheet],
      ['welcome/style.css', welcomeSheet],
      ['kit.css', kitSheet],
      ...widgetModules,
    ]);

    assert.deepEqual(found(sources), []);
    assert.ok(widgetModules.length > 10, `only ${widgetModules.length} modules of the widget were read`);
    // The control: a stone grey in a rule is found, the same grey in a comment is not.
    assert.deepEqual(found(new Map([['planted.css', '/* was #e7e5e4 */\n.row { border: 1px solid #E7E5E4; }']])), [
      'planted.css: #e7e5e4',
    ]);
    assert.deepEqual(found(new Map([['comment.css', '/* was #e7e5e4 */']])), []);
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
